import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  readExtensionDefaults,
  readPreferenceDocument,
  mergeExtensionSettings,
} from "../shared/extension-defaults.js";
import { getSessionRoutingProfile, onSessionRoutingChanged } from "../shared/session-routing.ts";
import { installWakeAdmission } from "../shared/idle-admission.ts";
import {
  AdmissionLane,
  type AdmissionDetails,
  type Choice,
  type PendingAdmission,
} from "./admission.ts";
import { FORCE_CHEAP_COMPACTION_KEY, registerCompaction } from "./compaction.ts";
import { lastModelActivity, shouldWarn, warningTitle, type Config } from "./policy.ts";
export { lastModelActivity, shouldWarn } from "./policy.ts";
export const REMOTE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
const globals = globalThis as Record<string, any>;
const DEFAULTS: Config = { idleMinutes: 30, contextPercent: 20 };
function configPath(): string {
  const canonical = join(getAgentDir(), "idle-context-warning.json");
  return existsSync(canonical)
    ? canonical
    : join(getAgentDir(), "extensions", "idle-context-warning.json");
}
export function readConfig(path = configPath(), strict = false): Config {
  try {
    const parsed = mergeExtensionSettings(
      readExtensionDefaults("idle-context-warning"),
      readPreferenceDocument(path),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Configuration must be an object");
    const valid = (value: unknown, fallback: number, max: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= max
        ? value
        : fallback;
    return {
      idleMinutes: valid(parsed.idleMinutes, 30, 1440),
      contextPercent: valid(parsed.contextPercent, 20, 100),
      cheapCompactionModel:
        "cheapCompactionModel" in parsed ? parsed.cheapCompactionModel : "cheap",
    };
  } catch (error) {
    if (strict) throw new Error(`Cannot read idle-context-warning.json: ${String(error)}`);
    return DEFAULTS;
  }
}
function isWorker(): boolean {
  return !!process.env.PI_SUBAGENT_ID || !!process.env.AGENTSH_SUBAGENT_ID;
}
function details(
  ctx: ExtensionContext,
  settings: Config,
  origin: AdmissionDetails["origin"],
): AdmissionDetails | undefined {
  const idleAt = lastModelActivity(ctx.sessionManager.getBranch()),
    usage = ctx.getContextUsage(),
    now = Date.now();
  if (!shouldWarn(idleAt, now, usage?.percent, settings)) return;
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";
  return {
    session: ctx.sessionManager.getSessionId(),
    model,
    idleMinutes: Math.floor((now - idleAt!) / 60_000),
    contextPercent: Math.round(usage!.percent!),
    origin,
    title: warningTitle(model, idleAt!, now, {
      tokens: usage!.tokens,
      contextWindow: usage!.contextWindow,
      percent: usage!.percent!,
    }),
  };
}
function decisionPort(
  ctx: ExtensionContext,
  info: AdmissionDetails,
): ((signal: AbortSignal) => Promise<Choice>) | undefined {
  if (isWorker()) {
    const parent = globals.__piIdleContextParentV1;
    return typeof parent?.request === "function"
      ? (signal) =>
          parent.request(
            {
              model: info.model,
              idleMinutes: info.idleMinutes,
              contextPercent: info.contextPercent,
            },
            signal,
          )
      : undefined;
  }
  const remote = globals.__piPaseoRemoteUiV1;
  if (!ctx.hasUI && !(remote?.isConnected?.() && remote.selectMirrored)) return;
  return async (signal) => {
    const local = (dialogSignal: AbortSignal): Promise<string | undefined> => {
      const combined = AbortSignal.any([signal, dialogSignal]);
      if (combined.aborted) return Promise.resolve(undefined);
      if (!ctx.hasUI)
        return new Promise((resolve) =>
          combined.addEventListener("abort", () => resolve(undefined), { once: true }),
        );
      return ctx.ui.select(info.title, ["Cancel", "Ignore", "Compact"], { signal: combined });
    };
    const response =
      remote?.isConnected?.() && remote.selectMirrored
        ? await remote.selectMirrored(info.title, ["Cancel", "Ignore", "Compact"], local, {
            signal,
          })
        : await local(signal);
    return response === "Ignore" ? "ignore" : response === "Compact" ? "compact" : "cancel";
  };
}

export default function (pi: ExtensionAPI, options: { readSettings?: () => Config } = {}) {
  const settings = options.readSettings ?? (() => readConfig(configPath(), true));
  registerCompaction(pi, settings);
  let active: ExtensionContext | undefined;
  let epoch = 0,
    lifecycle = new AbortController();
  let removeRouting: (() => void) | undefined, removeWake: (() => void) | undefined;
  let replay: { text: string; images: unknown; epoch: number } | undefined;
  type Submission = {
    id: string;
    text: string;
    images?: any[];
    streamingBehavior?: "steer" | "followUp";
  };
  let submission: Submission | undefined;
  const persistSubmission = (
    item: Submission,
    state: "pending" | "released" | "cancelled" | "failed",
    error?: string,
  ) => {
    try {
      pi.appendEntry("idle-context-submission", {
        version: 1,
        state,
        ...item,
        ...(error ? { error } : {}),
      });
      return true;
    } catch {
      return false;
    }
  };
  const lane = new AdmissionLane((pending) => {
    try {
      if (active?.hasUI)
        active.ui.setStatus(
          "idle-context",
          pending ? `idle decision ${pending.state}: /idle-context` : undefined,
        );
    } catch {
      /* Status cannot approve. */
    }
    try {
      pi.events?.emit?.("idle-context:pending", {
        session: active?.sessionManager.getSessionId(),
        pending,
      });
    } catch {
      /* Optional observers cannot affect admission. */
    }
  });
  const failureMessage = (error: unknown) =>
    (error == null ? "" : error instanceof Error ? error.message : String(error))
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
  const restoreDraft = (ctx: ExtensionContext, item: Submission) => {
    try {
      if (
        !ctx.hasUI ||
        !item.text ||
        typeof ctx.ui.getEditorText !== "function" ||
        ctx.ui.getEditorText() !== ""
      )
        return;
      ctx.ui.setEditorText(item.text);
    } catch {
      /* Durable failed records remain available through /idle-context recover. */
    }
  };
  const reportSubmissionFailure = (ctx: ExtensionContext, item: Submission, error: unknown) => {
    const message = failureMessage(error) || "Unknown submission failure";
    const saved = persistSubmission(item, "failed", message);
    restoreDraft(ctx, item);
    const recovery = saved ? ` Recover with /idle-context recover ${item.id}.` : "";
    try {
      const notice = `Idle-approved message was not submitted: ${message}.${recovery}`;
      if (ctx.hasUI) ctx.ui.notify(notice, "error");
      else process.stderr.write(`[idle-context-warning] ${notice}\n`);
    } catch {
      /* The persisted record and editor draft provide recovery if notification fails. */
    }
  };
  const reportStaleDispatchFailure = (sessionId: string, item: Submission, error: unknown) => {
    try {
      process.stderr.write(
        `[idle-context-warning] Dispatch failed after context change: ${failureMessage(error)}. ` +
          `Original session ${sessionId}, prompt ${item.id}; run /idle-context recover ${item.id} ` +
          "there only after checking whether it was already delivered.\n",
      );
    } catch {
      /* Never write into a stale session; stderr is best-effort diagnostics. */
    }
  };
  const invalidate = (preserveSubmission = false) => {
    if (submission && !preserveSubmission) persistSubmission(submission, "cancelled");
    submission = undefined;
    epoch++;
    replay = undefined;
    lifecycle.abort();
    lane.invalidate();
    lifecycle = new AbortController();
  };
  const identity = (ctx: ExtensionContext) =>
    JSON.stringify([
      epoch,
      ctx.sessionManager.getSessionId(),
      ctx.model?.provider,
      ctx.model?.id,
      ctx.thinkingLevel,
      getSessionRoutingProfile(ctx),
    ]);
  const contextRevision = (ctx: ExtensionContext) =>
    ctx.sessionManager
      .getBranch()
      .findLast((entry) =>
        ["message", "custom_message", "compaction", "branch_summary", "context_edit"].includes(
          entry.type,
        ),
      )?.id;
  const SAFE_COMPACTION_INTERLEAVINGS = new Set(["custom_message", "usage", "session_info"]);
  function hasSafeCompactionContext(branch: SessionEntry[], capturedLeaf: string | null): boolean {
    const leafIndex = branch.findIndex((entry) => entry.id === capturedLeaf);
    if (leafIndex < 0) return false;
    // getBranch() is the active parent chain. Reject navigation and any
    // context-changing entry; benign entries do not replace prepared history.
    for (let index = 1; index < branch.length; index += 1) {
      if (branch[index].parentId !== branch[index - 1].id) return false;
    }
    for (let index = leafIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry.type !== "compaction" && !SAFE_COMPACTION_INTERLEAVINGS.has(entry.type))
        return false;
    }
    return true;
  }
  function hasSafeCompactionBranch(branch: SessionEntry[], capturedLeaf: string | null): boolean {
    if (!hasSafeCompactionContext(branch, capturedLeaf)) return false;
    const leafIndex = branch.findIndex((entry) => entry.id === capturedLeaf);
    const compactionIndexes = branch.flatMap((entry, index) =>
      index > leafIndex && entry.type === "compaction" ? [index] : [],
    );
    if (compactionIndexes.length !== 1) return false;
    const compactionIndex = compactionIndexes[0];
    const entry = branch[compactionIndex];
    if (entry.type !== "compaction" || entry.parentId !== branch[compactionIndex - 1]?.id)
      return false;
    if (entry.firstKeptEntryId !== entry.id) {
      const firstKeptIndex = branch.findIndex(
        (candidate) => candidate.id === entry.firstKeptEntryId,
      );
      if (firstKeptIndex < 0 || firstKeptIndex > leafIndex) return false;
    }
    return true;
  }
  type CompactOutcome =
    | { kind: "complete"; entryId: string }
    | { kind: "cancel" }
    | { kind: "error"; reason: string };
  const compactAndWait = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<CompactOutcome> => {
    if (signal.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return { kind: "cancel" };
    const initial = identity(ctx),
      leaf = ctx.sessionManager.getLeafId(),
      sessionId = ctx.sessionManager.getSessionId(),
      token = randomUUID();
    const forced = { sessionId, token };
    globals[FORCE_CHEAP_COMPACTION_KEY] = forced;
    try {
      const outcome = await new Promise<CompactOutcome>((resolve) => {
        let finished = false;
        const finish = (result: CompactOutcome) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve(signal.aborted || identity(ctx) !== initial ? { kind: "cancel" } : result);
        };
        const abort = () => finish({ kind: "cancel" });
        const timer = setTimeout(
          () => finish({ kind: "error", reason: "Compaction timed out" }),
          120_000,
        );
        signal.addEventListener("abort", abort, { once: true });
        try {
          ctx.compact({
            onError: (error: unknown) => {
              finish(
                signal.aborted
                  ? { kind: "cancel" }
                  : {
                      kind: "error",
                      reason: failureMessage(error) || "Pi reported a compaction failure",
                    },
              );
            },
            onComplete: (result: any) => {
              const branch = ctx.sessionManager.getBranch();
              const leafIndex = branch.findIndex((item) => item.id === leaf);
              if (!hasSafeCompactionContext(branch, leaf)) {
                finish({ kind: "cancel" });
                return;
              }
              const entries = branch.filter(
                (item, index) => index > leafIndex && item.type === "compaction",
              );
              if (entries.length !== 1) {
                finish({
                  kind: "error",
                  reason: `Expected one new compaction entry, found ${entries.length}`,
                });
                return;
              }
              const entry = entries[0];
              if (
                entry.type !== "compaction" ||
                entry.summary !== result?.summary ||
                entry.firstKeptEntryId !== result?.firstKeptEntryId ||
                entry.tokensBefore !== result?.tokensBefore
              ) {
                finish({
                  kind: "error",
                  reason: "Compaction callback does not match the new branch entry",
                });
                return;
              }
              if (!hasSafeCompactionBranch(branch, leaf)) {
                finish({ kind: "error", reason: "Compaction entry failed boundary safety checks" });
                return;
              }
              finish({ kind: "complete", entryId: entry.id });
            },
          });
        } catch (error) {
          finish(
            signal.aborted
              ? { kind: "cancel" }
              : {
                  kind: "error",
                  reason: failureMessage(error) || "Pi rejected the compaction request",
                },
          );
        }
      });
      // Pi may append cache-usage or other entries before ctx.compact() fully
      // settles after onComplete. Recheck the active chain at the await boundary.
      if (signal.aborted || identity(ctx) !== initial) return { kind: "cancel" };
      if (outcome.kind !== "complete") return outcome;
      const branch = ctx.sessionManager.getBranch();
      return !signal.aborted &&
        identity(ctx) === initial &&
        branch.some((entry) => entry.type === "compaction" && entry.id === outcome.entryId) &&
        hasSafeCompactionBranch(branch, leaf)
        ? outcome
        : { kind: "cancel" };
    } finally {
      if (globals[FORCE_CHEAP_COMPACTION_KEY] === forced)
        delete globals[FORCE_CHEAP_COMPACTION_KEY];
    }
  };
  const check = async (
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    origin: AdmissionDetails["origin"] = "submission",
  ): Promise<"continue" | "cancel"> => {
    const currentSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    if (origin !== "submission") await lane.waitForIdle(currentSignal);
    if (currentSignal.aborted || !active) {
      if (origin !== "submission" && !signal?.aborted)
        throw new DOMException("Idle admission invalidated", "AbortError");
      return "cancel";
    }
    let info: AdmissionDetails | undefined;
    try {
      info = details(ctx, settings(), origin);
    } catch (error) {
      if (origin === "submission")
        throw new Error(`Idle prompt preflight failed: ${failureMessage(error)}`);
      throw new DOMException(`Idle notification admission failed: ${String(error)}`, "AbortError");
    }
    if (!info) return "continue";
    const initial = identity(ctx);
    let revision = contextRevision(ctx),
      compactFailed = false,
      compactCancelled = false,
      compactFailure = "No matching safe compaction was produced";
    const result = await lane.run(
      info,
      origin === "autonomous" ? async (): Promise<Choice> => "compact" : decisionPort(ctx, info),
      currentSignal,
      async (compactSignal) => {
        if (compactSignal.aborted) {
          compactCancelled = true;
          return false;
        }
        if (identity(ctx) !== initial || contextRevision(ctx) !== revision) return false;
        const outcome = await compactAndWait(ctx, compactSignal);
        if (outcome.kind === "complete") revision = contextRevision(ctx);
        else if (outcome.kind === "cancel") compactCancelled = true;
        else {
          compactFailed = true;
          compactFailure = outcome.reason;
        }
        return outcome.kind === "complete";
      },
    );
    if (currentSignal.aborted && origin !== "submission" && !signal?.aborted)
      throw new DOMException("Idle admission invalidated", "AbortError");
    if (currentSignal.aborted || compactCancelled) return "cancel";
    if (compactFailed) {
      if (origin === "submission")
        throw new Error(`Idle prompt compaction failed: ${compactFailure}`);
      throw new DOMException(
        `Idle notification compaction failed: ${compactFailure}`,
        "AbortError",
      );
    }
    if (currentSignal.aborted || identity(ctx) !== initial || contextRevision(ctx) !== revision) {
      if (origin !== "submission" && !signal?.aborted)
        throw new DOMException("Idle admission invalidated", "AbortError");
      return "cancel";
    }
    return result;
  };
  const capability = {
    ready: false,
    check: (signal?: AbortSignal) =>
      active ? check(active, signal) : Promise.resolve("cancel" as const),
    get pending(): PendingAdmission | undefined {
      return lane.pending;
    },
    decide: (id: string, choice: Choice) => lane.decide(id, choice),
    retainPrompt: (payload: Omit<Submission, "id">, reason: string) => {
      if (typeof payload?.text !== "string" || typeof reason !== "string") return false;
      return persistSubmission({ id: randomUUID(), ...payload }, "failed", failureMessage(reason));
    },
  };
  const retryDecisionChannel = async () => {
    const pending = lane.pending,
      ctx = active;
    if (!pending || pending.state !== "pending" || !ctx) return;
    const port = decisionPort(ctx, pending);
    if (port) {
      try {
        lane.decide(pending.id, await port(lifecycle.signal));
      } catch {
        /* Still pending; a reconnect is not consent. */
      }
    }
  };
  const removeChannelListener = pi.events?.on?.("idle-context:decision-channel-ready", () => {
    void retryDecisionChannel();
  });
  globals[REMOTE_PREFLIGHT_KEY] = capability;
  pi.registerCommand("idle-context", {
    description:
      "Resolve idle admission or recover a failed prompt with /idle-context recover [id]",
    handler: async (args, ctx) => {
      const [action, requestedId] = args.trim().split(/\s+/);
      if (action === "recover") {
        const failed = ctx.sessionManager
          .getBranch()
          .filter(
            (entry) => entry.type === "custom" && entry.customType === "idle-context-submission",
          )
          .map((entry) => entry.data as Submission & { state?: string })
          .findLast((item) =>
            requestedId
              ? item.id === requestedId && ["failed", "released"].includes(item.state ?? "")
              : item.state === "failed",
          );
        if (!failed) {
          if (ctx.hasUI) ctx.ui.notify("No matching failed idle prompt to recover.", "warning");
          return;
        }
        if (!ctx.hasUI) throw new Error(`Failed prompt ${failed.id}: ${failed.text}`);
        if (typeof ctx.ui.getEditorText !== "function" || ctx.ui.getEditorText() !== "") {
          ctx.ui.notify("Clear the editor before recovering the saved prompt.", "warning");
          return;
        }
        ctx.ui.setEditorText(failed.text);
        const releasedWarning =
          failed.state === "released"
            ? " It was released for dispatch and may already have been delivered; verify before resending."
            : "";
        const attachmentNote = failed.images?.length
          ? ` ${failed.images.length} image(s) and delivery settings remain saved, not restored.`
          : "";
        ctx.ui.notify(
          `Saved text restored; review it${releasedWarning}${attachmentNote} Submit manually.`,
          failed.state === "released" ? "warning" : "info",
        );
        return;
      }
      const pending = lane.pending;
      if (!pending) {
        if (ctx.hasUI) ctx.ui.notify("No pending idle decision.", "info");
        return;
      }
      if (isWorker()) {
        if (ctx.hasUI)
          ctx.ui.notify("The owning parent decides this worker's idle warning.", "warning");
        return;
      }
      const [choice, id = pending.id] = args.trim().split(/\s+/);
      if (["ignore", "compact", "cancel"].includes(choice)) {
        lane.decide(id, choice as Choice);
        return;
      }
      const port = decisionPort(ctx, pending);
      if (port) {
        try {
          lane.decide(pending.id, await port(lifecycle.signal));
        } catch {
          /* Keep pending if channel disconnects. */
        }
      } else if (ctx.hasUI)
        ctx.ui.notify(
          `Pending idle decision ${pending.id}: Ignore, Compact or Cancel required.`,
          "warning",
        );
    },
  });
  const revoke = () => invalidate();
  pi.on("model_select", revoke);
  pi.on("thinking_level_select", revoke);
  pi.on("session_before_switch", revoke);
  pi.on("session_before_fork", revoke);
  pi.on("session_before_tree", revoke);
  pi.on("session_start", (_event, ctx) => {
    invalidate();
    active = ctx;
    capability.ready = true;
    globals[REMOTE_PREFLIGHT_KEY] = capability;
    removeRouting?.();
    removeRouting = onSessionRoutingChanged(ctx, revoke);
    removeWake?.();
    removeWake = installWakeAdmission(ctx.sessionManager.getSessionId(), {
      check: (signal, origin) => check(ctx, signal, origin),
    });
    const latest = new Map<string, any>();
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === "idle-context-submission") {
        const data = entry.data as any;
        if (data?.version === 1 && typeof data.id === "string") latest.set(data.id, data);
      }
    const saved = [...latest.values()].findLast(
      (data) => data.state === "pending" && typeof data.text === "string",
    );
    if (saved)
      scheduleSubmission(ctx, {
        id: saved.id,
        text: saved.text,
        images: saved.images,
        streamingBehavior: saved.streamingBehavior,
      });
  });
  pi.on("session_shutdown", (event) => {
    invalidate(event.reason === "reload");
    active = undefined;
    capability.ready = false;
    removeRouting?.();
    removeWake?.();
    removeChannelListener?.();
    if (globals[REMOTE_PREFLIGHT_KEY] === capability) delete globals[REMOTE_PREFLIGHT_KEY];
  });
  const scheduleSubmission = (ctx: ExtensionContext, item: Submission) => {
    submission = item;
    const initialEpoch = epoch,
      initialSessionId = ctx.sessionManager.getSessionId(),
      initial = identity(ctx),
      signal = lifecycle.signal;
    const isCurrent = () => {
      if (signal.aborted || epoch !== initialEpoch) return false;
      try {
        return identity(ctx) === initial;
      } catch {
        return false;
      }
    };
    setTimeout(() => {
      if (initialEpoch !== epoch || signal.aborted || submission !== item) return;
      void check(ctx, signal)
        .then((result) => {
          if (signal.aborted || identity(ctx) !== initial || submission !== item) return;
          submission = undefined;
          // Durable reservation before send prevents duplicate replay after a
          // process crash. A released-but-unsent request requires user resubmission.
          if (result !== "continue") {
            persistSubmission(item, "cancelled");
            return;
          }
          if (!persistSubmission(item, "released")) {
            reportSubmissionFailure(ctx, item, new Error("Could not reserve the approved prompt"));
            return;
          }
          replay = { text: item.text, images: item.images, epoch };
          const content = item.images?.length
            ? [{ type: "text" as const, text: item.text }, ...item.images]
            : item.text;
          const options = { deliverAs: item.streamingBehavior, expandPromptTemplates: false };
          void (async () => {
            try {
              // Newer supervised Pi builds expose submitUserMessage(), whose
              // receipt resolves at the real prompt-admission boundary. Stock Pi
              // 1.4's sendUserMessage() is fire-and-forget at the extension facade.
              const submit = (pi as any).submitUserMessage;
              if (typeof submit === "function") {
                const receipt = await submit.call(pi, content, options);
                if (!receipt || !["started", "queued"].includes(receipt.disposition))
                  throw new Error(
                    `Prompt was not admitted (${receipt?.disposition ?? "invalid receipt"})`,
                  );
              } else {
                const delivery = pi.sendUserMessage(content, options);
                if (delivery && typeof delivery.then === "function") await delivery;
              }
            } catch (error) {
              if (replay?.epoch === epoch && replay.text === item.text) replay = undefined;
              // Dispatch rejection is definitive; retain the exact prompt without replaying it.
              if (isCurrent()) reportSubmissionFailure(ctx, item, error);
              else reportStaleDispatchFailure(initialSessionId, item, error);
            }
          })();
        })
        .catch((error) => {
          if (!signal.aborted && identity(ctx) === initial && submission === item) {
            submission = undefined;
            reportSubmissionFailure(ctx, item, error);
          }
        });
    }, 0);
  };
  pi.on("input", async (event, ctx) => {
    // The bridge's explicit preflight owns extension-origin submissions. Internal
    // continuation/direct calls have no universal stock input gate. A replay is
    // one exact payload, not a process-wide 'ignore next warning' authorization.
    if (event.source === "extension") {
      if (replay && replay.epoch === epoch && replay.text === event.text) replay = undefined;
      return;
    }
    let info: AdmissionDetails | undefined;
    try {
      info = details(ctx, settings(), "submission");
    } catch (error) {
      const item: Submission = {
        id: randomUUID(),
        text: event.text,
        images: event.images,
        streamingBehavior: event.streamingBehavior,
      };
      reportSubmissionFailure(
        ctx,
        item,
        new Error(`Idle prompt preflight failed: ${failureMessage(error)}`),
      );
      return { action: "handled" as const };
    }
    if (!info) return;
    if (lane.pending || submission) {
      const item: Submission = {
        id: randomUUID(),
        text: event.text,
        images: event.images,
        streamingBehavior: event.streamingBehavior,
      };
      reportSubmissionFailure(ctx, item, new Error("An idle decision is already pending"));
      return { action: "handled" as const };
    }
    const item: Submission = {
      id: randomUUID(),
      text: event.text,
      images: event.images,
      streamingBehavior: event.streamingBehavior,
    };
    // Consume first: no pending input operation is held across a missing channel
    // or Compact. Keep the payload durable for reload, but never restore approval.
    if (persistSubmission(item, "pending")) scheduleSubmission(ctx, item);
    else reportSubmissionFailure(ctx, item, new Error("Could not save the intercepted prompt"));
    return { action: "handled" as const };
  });
}
