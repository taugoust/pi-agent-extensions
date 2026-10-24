import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { lazyStream } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { isIdle, lastModelActivity, type Config } from "./policy.ts";
import { bindSessionModelRequest, SESSION_MODEL_REFERENCE_EVENT, getSessionRoutingProfile, onSessionRoutingChanged, prepareSessionRoutingRequest, registerSessionModelReference, resolveSessionModelSelector, type RoutingProfile } from "../shared/session-routing.ts";

export const GUARD_PROVIDER = "idle-guard";
export const PROXY_PROVIDER = "idle-guard-proxy";
export const GUARD_PROOF = "idleContextGuard";
export const GUARD_ERROR = "IDLE_GUARD_CLOSED";
export type GuardProof = { version: 1; mode: "cheap" | "physical"; attempt: string; session: string; alias: string; target: string; idleAt: number | undefined; sourceLeaf: string | null; provider?: string; account?: string | null; revision?: number };
type Attempt = { proof: GuardProof; ctx: ExtensionContext; epoch: number; started: boolean; leaf?: string | null };
// Runtime-only checks never enter persisted compaction details.
const proofChecks = new WeakMap<GuardProof, () => void>();
export function assertGuardProofCurrent(proof: GuardProof): void {
  const check = proofChecks.get(proof);
  if (!check) throw new Error(`${GUARD_ERROR}: inactive compaction proof`);
  check();
}

// Registration must preserve discoverable names even when a target is invalid.
// Strict target validation happens only at routing/dispatch, where it closes.
export function guardedModelAliases(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((alias) => alias.length > 0 && !/\s/.test(alias));
}

export function parseGuardedModels(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("guardedModels must be an alias-to-provider/model object");
  const result: Record<string, string> = Object.create(null);
  for (const [alias, selector] of Object.entries(value)) {
    if (!alias || /\s/.test(alias) || typeof selector !== "string" || !/^[^/\s]+\/\S+$/.test(selector) || /:(off|minimal|low|medium|high|xhigh|max)$/.test(selector)) throw new Error("guardedModels requires exact provider/model selectors without thinking suffixes");
    if ([GUARD_PROVIDER, PROXY_PROVIDER].includes(selector.split("/")[0])) throw new Error("Guard aliases cannot target a guard provider");
    result[alias] = selector;
  }
  return result;
}

// Keep removed aliases selectable but closed. Registration must happen before
// startup selection, otherwise Pi restores the last physical response instead.
function rememberAliases(path: string, configured: string[]): string[] {
  let old: unknown = [];
  try { old = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!Array.isArray(old) || old.some((id) => typeof id !== "string" || !id || /\s/.test(id))) throw new Error("Invalid guard alias tombstones");
  const directory = `${path}.d`;
  let files: string[] = [];
  try { files = readdirSync(directory).filter((name) => name.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const file of files) {
    const alias: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (typeof alias !== "string" || !alias || /\s/.test(alias)) throw new Error("Invalid guard alias tombstone");
    (old as string[]).push(alias);
  }
  const aliases = [...new Set([...old as string[], ...configured])];
  // Immutable per-alias files are additive across simultaneous Pi processes.
  // Never write merely because an unconfigured extension was loaded.
  for (const alias of aliases) {
    const file = `${createHash("sha256").update(alias).digest("hex")}.json`;
    if (files.includes(file)) continue;
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(alias), { mode: 0o600 });
    renameSync(temporary, join(directory, file));
  }
  return aliases;
}

export function registerGuard(pi: ExtensionAPI, readSettings: () => Config, options: { tombstonePath?: string } = {}) {
  let initial: string[] = [];
  try { initial = guardedModelAliases(readSettings().guardedModels); } catch { /* Register persisted tombstones even with broken configuration. */ }
  const aliases = rememberAliases(options.tombstonePath ?? join(getAgentDir(), "idle-guard-aliases.json"), initial);
  if (aliases.length === 0) return { compactionProof: (_ctx: ExtensionContext): GuardProof | undefined => undefined };
  let context: ExtensionContext | undefined;
  let epoch = 0;
  let pending: Attempt | undefined;
  let externalCompaction: Attempt | undefined;
  let closed = false;
  let attempted = false;
  let retryRequired = false;
  let recoveryRequested = false;
  const invalidate = (requireRecovery = true) => {
    epoch++; pending = undefined; externalCompaction = undefined; recoveryRequested = false; closed = requireRecovery;
    try { if (context?.model?.provider === GUARD_PROVIDER) pi.appendEntry("idle-guard-revoked", { alias: context.model.id, retryRequired, closed }); } catch { /* In-memory gate still stays closed. */ }
  };
  const restoredClosed = (ctx: ExtensionContext) => {
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && ["idle-guard-authorized", "idle-guard-revoked"].includes(entry.customType));
    return last?.type === "custom" && last.customType === "idle-guard-revoked" && (last.data as any)?.closed !== false;
  };
  const restoredRetryRequired = (ctx: ExtensionContext) => {
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && ["idle-guard-authorized", "idle-guard-revoked"].includes(entry.customType));
    return last?.type === "custom" && last.customType === "idle-guard-revoked" && (last.data as any)?.retryRequired === true;
  };
  const targetFor = (alias: string, ctx: ExtensionContext, snapshot?: RoutingProfile) => {
    const configured = parseGuardedModels(readSettings().guardedModels)[alias];
    if (!configured) throw new Error(`${GUARD_ERROR}: alias removed or unconfigured`);
    const selector = resolveSessionModelSelector(ctx, configured, snapshot);
    const slash = selector.indexOf("/");
    const model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
    if (!model || model.api === "pi-virtual") throw new Error(`${GUARD_ERROR}: target must be a physical model`);
    return { selector, model };
  };
  const hasProof = (ctx: ExtensionContext, alias: string, selector: string): boolean => {
    const branch = ctx.sessionManager.getBranch();
    const idleAt = lastModelActivity(branch);
    const entry = branch.findLast((entry) => entry.type === "compaction");
    if (!entry || entry.type !== "compaction") return false;
    const details = entry.details as Record<string, any> | undefined;
    const proof = details?.[GUARD_PROOF] as GuardProof | undefined;
    const authorization = branch.findLast((item) => item.type === "custom" && ["idle-guard-authorized", "idle-guard-revoked"].includes(item.customType));
    const authorized = authorization?.type === "custom" && authorization.customType === "idle-guard-authorized" && (authorization.data as any)?.attempt === proof?.attempt && (authorization.data as any)?.compactionId === entry.id;
    try {
      const profile = getSessionRoutingProfile(ctx);
      return authorized && details?.idleContextNativeCompaction === 1 && proof?.version === 1 && proof.session === ctx.sessionManager.getSessionId() && proof.alias === alias && proof.target === selector && proof.idleAt === idleAt && proof.provider === profile?.providerId && proof.account === profile?.accountId && proof.revision === profile?.revision && Date.now() - Date.parse(entry.timestamp) < readSettings().idleMinutes * 60_000;
    } catch { return false; } // Broken settings can never authorize a persisted proof.
  };
  const stream: NonNullable<ProviderConfig["streamSimple"]> = (proxy, transcript, options) => lazyStream(proxy, async () => {
    const ctx = context;
    if (!ctx || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== proxy.id || options?.signal?.aborted) throw new Error(`${GUARD_ERROR}: inactive selection`);
    const profile = await prepareSessionRoutingRequest(ctx);
    const { selector, model } = targetFor(proxy.id, ctx, profile);
    const requestModel = profile ? bindSessionModelRequest(model, profile) : model;
    const requestEpoch = epoch;
    const session = ctx.sessionManager.getSessionId();
    const assertDispatch = () => {
      const currentProfile = getSessionRoutingProfile(ctx);
      if (epoch !== requestEpoch || options?.signal?.aborted || ctx.sessionManager.getSessionId() !== session || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== proxy.id || targetFor(proxy.id, ctx).selector !== selector || profile?.providerId !== currentProfile?.providerId || profile?.accountId !== currentProfile?.accountId || profile?.revision !== currentProfile?.revision) throw new Error(`${GUARD_ERROR}: stale request`);
      const idleAt = lastModelActivity(ctx.sessionManager.getBranch());
      const cold = isIdle(idleAt, Date.now(), readSettings().idleMinutes);
      if (closed || (cold && !hasProof(ctx, proxy.id, selector))) {
        closed = true;
        if (!attempted && !retryRequired && !ctx.hasPendingMessages()) {
          attempted = true;
          const current = getSessionRoutingProfile(ctx);
          pending = { ctx, epoch, started: false, proof: { version: 1, mode: "cheap", attempt: randomUUID(), session, alias: proxy.id, target: selector, idleAt, sourceLeaf: ctx.sessionManager.getLeafId(), provider: current?.providerId, account: current?.accountId, revision: current?.revision } };
        }
        throw new Error(`${GUARD_ERROR}: ${retryRequired ? "previous compaction failed; use /idle-guard-retry" : "native cheap compaction required"}`);
      }
    };
    assertDispatch();
    // Resolve real credentials at the destination. Never send proxy credentials
    // or proxy-scoped environment/headers to another provider.
    const { apiKey: _key, headers: _headers, env: _env, ...forward } = options ?? {};
    const originalPayload = forward.onPayload;
    return ctx.modelRegistry.streamSimple(requestModel, transcript, {
      ...forward,
      onPayload: async (payload, physicalModel) => {
        // Registry authentication and earlier payload hooks can await long
        // enough to cross idle or switch sessions. Recheck after those awaits,
        // at the supported provider's last payload-before-dispatch boundary.
        const replacement = await originalPayload?.(payload, physicalModel);
        assertDispatch();
        return replacement;
      },
    });
  });
  const registerProxy = (ctx?: ExtensionContext) => {
    pi.registerProvider(PROXY_PROVIDER, {
      api: "idle-guard-proxy", apiKey: "idle-guard-local-only", baseUrl: "https://invalid.invalid", streamSimple: stream,
      models: aliases.map((alias) => {
        let model;
        try { if (ctx) model = targetFor(alias, ctx).model; } catch { /* tombstone */ }
        return { id: alias, name: `Guard dispatch: ${alias}`, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: model?.input ?? ["text", "image"], contextWindow: model?.contextWindow ?? 0, maxTokens: model?.maxTokens ?? 0, cost: model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      }),
    });
  };
  registerProxy();
  for (const alias of aliases) pi.registerVirtualModel({
    provider: GUARD_PROVIDER, id: alias, name: `Idle guarded: ${alias}`,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    route(request, ctx) {
      context = ctx;
      // A direct summary request must never recurse through the proxy. All
      // guarded compaction is owned by the explicit native cheap hook.
      if (request.reason === "direct") throw new Error(`${GUARD_ERROR}: direct alias request forbidden`);
      targetFor(alias, ctx);
      const model = ctx.modelRegistry.find(PROXY_PROVIDER, alias);
      if (!model) throw new Error(`${GUARD_ERROR}: proxy unavailable`);
      return { model, thinkingLevel: request.thinkingLevel };
    },
  });
  let removeRoutingListener: (() => void) | undefined;
  let removeModelReference: (() => void) | undefined;
  const installModelReference = (ctx: ExtensionContext) => {
    removeModelReference?.();
    removeModelReference = registerSessionModelReference(ctx, () => {
      const alias = ctx.model?.provider === GUARD_PROVIDER ? ctx.model.id : undefined;
      if (!alias) return undefined;
      const configured = parseGuardedModels(readSettings().guardedModels)[alias];
      if (!configured) return undefined;
      const slash = configured.indexOf("/");
      return { provider: configured.slice(0, slash), id: configured.slice(slash + 1) };
    });
  };
  // Accounts may initialize before our session_start handler. All factories
  // have loaded by then; the same-runtime event supplies a safe bootstrap role.
  const removeBootstrapListener = pi.events?.on?.(SESSION_MODEL_REFERENCE_EVENT, (request: any) => {
    if (request?.ctx?.model?.provider === GUARD_PROVIDER && typeof request.ctx.sessionManager?.getSessionId === "function") installModelReference(request.ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    installModelReference(ctx);
    epoch++; pending = undefined; externalCompaction = undefined; recoveryRequested = false; retryRequired = restoredRetryRequired(ctx); attempted = retryRequired; closed = restoredClosed(ctx); registerProxy(ctx);
  });
  pi.on("session_start", (_event, ctx) => { removeRoutingListener?.(); removeRoutingListener = onSessionRoutingChanged(ctx, () => {
    // A new binding invalidates authorization, not a warm conversation. Forcing
    // recovery on a tiny warm session would fail native 'nothing to compact'
    // and permanently block a perfectly valid account/provider switch.
    attempted = false; retryRequired = false;
    invalidate(isIdle(lastModelActivity(ctx.sessionManager.getBranch()), Date.now(), readSettings().idleMinutes));
    registerProxy(ctx);
  }); });
  pi.on("input", () => { if (pending || externalCompaction) invalidate(); });
  const cancelPending = () => { if (pending || externalCompaction || closed) invalidate(); else epoch++; };
  pi.on("session_before_switch", cancelPending);
  pi.on("session_before_tree", cancelPending);
  pi.on("session_shutdown", () => { cancelPending(); removeRoutingListener?.(); removeRoutingListener = undefined; removeModelReference?.(); removeModelReference = undefined; removeBootstrapListener?.(); context = undefined; });
  pi.on("model_select", (_event, ctx) => { cancelPending(); context = ctx; retryRequired = restoredRetryRequired(ctx); attempted = retryRequired; closed = restoredClosed(ctx); });
  pi.on("session_compact_failed", () => { if (context?.model?.provider === GUARD_PROVIDER) { retryRequired = true; attempted = true; invalidate(); } });
  // Core may compact after routing but before dispatch. Authorize that exact
  // persisted result here, avoiding a redundant second compaction at settlement.
  // Explicit guard recovery is authorized by its callback, which also resumes.
  pi.on("session_compact", (event, ctx) => {
    const attempt = externalCompaction;
    if (!attempt) return;
    externalCompaction = undefined;
    const entry = event.compactionEntry;
    const proof = (entry.details as any)?.[GUARD_PROOF];
    if (attempt.epoch !== epoch || ctx.hasPendingMessages() || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== attempt.proof.alias || ctx.sessionManager.getSessionId() !== attempt.proof.session || entry.parentId !== attempt.leaf || ctx.sessionManager.getLeafId() !== entry.id || proof?.attempt !== attempt.proof.attempt || (entry.details as any)?.idleContextNativeCompaction !== 1 || proof.idleAt !== lastModelActivity(ctx.sessionManager.getBranch())) { invalidate(); return; }
    try {
      pi.appendEntry("idle-guard-authorized", { attempt: proof.attempt, compactionId: entry.id });
      if (!hasProof(ctx, attempt.proof.alias, attempt.proof.target)) { invalidate(); return; }
      recoveryRequested = false; closed = false;
    } catch { invalidate(); }
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (ctx.model?.provider === GUARD_PROVIDER && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && !pending && !retryRequired) attempted = false;
  });
  pi.on("agent_settled", (_event, ctx) => {
    const attempt = pending;
    if (!attempt || attempt.started || attempt.epoch !== epoch) return;
    if (ctx.hasPendingMessages() || !ctx.isIdle() || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== attempt.proof.alias || ctx.sessionManager.getSessionId() !== attempt.proof.session) { invalidate(); return; }
    // Core may have compacted after the local error, before settlement. Its
    // persisted authorization is sufficient; do not compact the summary again.
    // If core already continued and received a real response, do not resume twice.
    if (lastModelActivity(ctx.sessionManager.getBranch()) !== attempt.proof.idleAt) {
      pending = undefined; attempted = false;
      return;
    }
    if (!closed && hasProof(ctx, attempt.proof.alias, attempt.proof.target)) {
      pending = undefined;
      try { pi.sendMessage({ customType: "idle-guard-resume", content: "Native cheap compaction persisted successfully. Continue the pending request.", display: false }, { triggerTurn: true }); }
      catch { invalidate(); }
      return;
    }
    attempt.started = true;
    attempt.leaf = ctx.sessionManager.getLeafId();
    ctx.compact({
      onError: () => { if (pending === attempt) { retryRequired = true; attempted = true; invalidate(); } },
      onComplete: () => {
        if (pending !== attempt || epoch !== attempt.epoch || ctx.hasPendingMessages() || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== attempt.proof.alias || ctx.sessionManager.getSessionId() !== attempt.proof.session) return;
        const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
        const proof = entry?.type === "compaction" ? (entry.details as any)?.[GUARD_PROOF] : undefined;
        if (entry?.parentId !== attempt.leaf || ctx.sessionManager.getLeafId() !== entry?.id || proof?.attempt !== attempt.proof.attempt || (entry?.details as any)?.idleContextNativeCompaction !== 1 || proof.idleAt !== lastModelActivity(ctx.sessionManager.getBranch())) { invalidate(); return; }
        try {
          pi.appendEntry("idle-guard-authorized", { attempt: proof.attempt, compactionId: entry.id });
          if (!hasProof(ctx, attempt.proof.alias, attempt.proof.target)) { invalidate(); return; }
          pending = undefined; recoveryRequested = false; closed = false;
          pi.sendMessage({ customType: "idle-guard-resume", content: "Native cheap compaction persisted successfully. Continue the pending request.", display: false }, { triggerTurn: true });
        } catch { invalidate(); }
      },
    });
  });
  pi.registerCommand("idle-guard-retry", {
    description: "Retry native cheap compaction for the selected guarded alias (never bypass the guard)",
    handler: async (_args, ctx) => {
      if (ctx.model?.provider !== GUARD_PROVIDER || !ctx.isIdle() || ctx.hasPendingMessages() || pending?.started) {
        if (ctx.hasUI) ctx.ui.notify("Select a guarded alias and wait for pending work before retrying.", "warning");
        return;
      }
      retryRequired = false; invalidate(); recoveryRequested = true; attempted = false; context = ctx;
      pi.sendMessage({ customType: "idle-guard-retry", content: "Retry the guarded native cheap compaction; continue only after persisted success.", display: false }, { triggerTurn: true });
    },
  });
  const checkedProof = (attempt: Attempt, ctx: ExtensionContext): GuardProof => {
    proofChecks.set(attempt.proof, () => {
      const profile = getSessionRoutingProfile(ctx);
      if (attempt.epoch !== epoch || (pending !== attempt && externalCompaction !== attempt) || ctx.sessionManager.getSessionId() !== attempt.proof.session || attempt.proof.provider !== profile?.providerId || attempt.proof.account !== profile?.accountId || attempt.proof.revision !== profile?.revision) throw new Error(`${GUARD_ERROR}: stale compaction attempt`);
    });
    return attempt.proof;
  };
  return {
    compactionProof(ctx: ExtensionContext): GuardProof | undefined {
      if (ctx.model?.provider !== GUARD_PROVIDER) return;
      const attempt = pending;
      if (retryRequired && !attempt?.started) throw new Error(`${GUARD_ERROR}: previous compaction failed; use /idle-guard-retry`);
      if (!attempt?.started) {
        const { selector } = targetFor(ctx.model.id, ctx);
        const leaf = ctx.sessionManager.getLeafId();
        const current = getSessionRoutingProfile(ctx);
        externalCompaction = { ctx, epoch, started: true, leaf, proof: { version: 1, mode: recoveryRequested || isIdle(lastModelActivity(ctx.sessionManager.getBranch()), Date.now(), readSettings().idleMinutes) ? "cheap" : "physical", attempt: randomUUID(), session: ctx.sessionManager.getSessionId(), alias: ctx.model.id, target: selector, idleAt: lastModelActivity(ctx.sessionManager.getBranch()), sourceLeaf: leaf, provider: current?.providerId, account: current?.accountId, revision: current?.revision } };
        return checkedProof(externalCompaction, ctx);
      }
      if (attempt.epoch !== epoch || attempt.proof.session !== ctx.sessionManager.getSessionId() || attempt.proof.alias !== ctx.model.id) throw new Error(`${GUARD_ERROR}: compaction outside guarded attempt`);
      return checkedProof(attempt, ctx);
    },
  };
}
