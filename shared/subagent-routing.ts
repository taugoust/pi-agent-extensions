import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CONTROLS_KEY, type AccountControlsService } from "./account-controls.js";
import {
  getSessionRoutingProfile, routingProfilePath, sessionRoutingEnvironment,
  validateRoutingProfile, writeSessionRoutingProfile, type RoutingContext,
} from "./session-routing.ts";

export const SUBAGENT_ROUTING_KEY = "__paeSubagentRoutingV1";
export const SUBAGENT_ROUTING_ENTRY = "pi-subagent-routing-v1";
export interface SubagentRoutingSelection {
  providerId: string;
  /** null selects the provider's default login, not the session's account. */
  accountId: string | null;
}
type SelectionContext = RoutingContext & {
  sessionManager: RoutingContext["sessionManager"] & { getBranch?(): readonly any[] };
};
export interface SubagentRoutingSnapshot {
  protocol: 1;
  sessionId: string;
  serviceEpoch: string;
  revision: number;
  /** null follows the owning session. */
  selection: SubagentRoutingSelection | null;
}
export interface SubagentRoutingService {
  protocol: 1;
  sessionId: string;
  serviceEpoch: string;
  getSnapshot(request: { sessionId: string }): Promise<SubagentRoutingSnapshot>;
  set(request: {
    expectedSessionId: string;
    expectedServiceEpoch: string;
    expectedRevision: number;
    selection: SubagentRoutingSelection | null;
  }): Promise<SubagentRoutingSnapshot>;
}

export function validateSubagentRoutingSelection(value: unknown): SubagentRoutingSelection | null {
  if (value === null) return null;
  const selection = value as SubagentRoutingSelection;
  const profile = validateRoutingProfile({ ...selection, version: 1, ownerSessionId: "subagents", revision: 0 });
  // Named accounts are currently managed only for Codex. Other providers can
  // still use their normal default authentication without account controls.
  if (profile.accountId !== null && profile.providerId !== "openai-codex") throw new Error("unsupported-account-provider");
  return { providerId: profile.providerId, accountId: profile.accountId };
}

function selectionEntry(ctx: SelectionContext): any {
  return ctx.sessionManager.getBranch?.().findLast(entry => entry.type === "custom" && entry.customType === SUBAGENT_ROUTING_ENTRY);
}

/** Read the active branch, including after reload, resume or tree navigation. */
export function readSubagentRoutingSelection(ctx: SelectionContext): SubagentRoutingSelection | null {
  const entry = selectionEntry(ctx);
  if (!entry) return null;
  if (entry.data?.version !== 1) throw new Error("invalid-subagent-routing-state");
  return validateSubagentRoutingSelection(entry.data.selection);
}

/** A fresh private descriptor freezes the account for this launch. Never publish
 * changes to the session's own routing file or an already-running child's binding. */
export function subagentRoutingEnvironment(ctx: SelectionContext, model: string | undefined, agentDir: string): Record<string, string> {
  const slash = model?.indexOf("/") ?? -1;
  const provider = slash > 0 ? model!.slice(0, slash) : undefined;
  const selection = readSubagentRoutingSelection(ctx);
  if (selection && provider === selection.providerId) {
    const ownerSessionId = ctx.sessionManager.getSessionId();
    const file = routingProfilePath(agentDir, `${ownerSessionId}/subagents/${randomUUID()}`);
    writeSessionRoutingProfile(file, { version: 1, ownerSessionId, ...selection, revision: 0 });
    return { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: ownerSessionId };
  }
  if (provider) {
    // Preserve existing cross-provider/default and fail-closed routing behavior.
    let routed: string | undefined;
    try { routed = getSessionRoutingProfile(ctx)?.providerId; } catch { routed = undefined; }
    if (routed !== undefined && routed !== provider) return {};
  }
  return sessionRoutingEnvironment(ctx);
}

/** AgentSH binds one descriptor per request rather than one per child. Keep
 * unset requests unchanged; reject only groups needing the configured route
 * alongside another provider so no child silently gets the wrong account. */
export function subagentRequestRoutingEnvironment(ctx: SelectionContext, models: readonly (string | undefined)[], agentDir: string): Record<string, string> {
  const selection = readSubagentRoutingSelection(ctx);
  if (!selection || !models.length) return sessionRoutingEnvironment(ctx);
  const providers = new Set(models.map(model => model?.split("/")[0]));
  if (providers.has(selection.providerId) && providers.size > 1) throw new Error("Split this AgentSH launch by provider to preserve subagent account routing");
  return providers.size === 1 ? subagentRoutingEnvironment(ctx, models[0], agentDir) : sessionRoutingEnvironment(ctx);
}

/** Paseo-facing, lifetime-owned session control. No credentials or model calls. */
export function registerSubagentRoutingControls(pi: ExtensionAPI): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  let context: ExtensionContext | undefined;
  let entry: unknown;
  let revision = 0;
  const serviceEpoch = randomUUID();
  const assertCurrent = (sessionId: string) => {
    if (globals[SUBAGENT_ROUTING_KEY] !== service) throw new Error("stale-service");
    if (!context || context.sessionManager.getSessionId() !== sessionId || service.sessionId !== sessionId) throw new Error("stale-session");
    return context;
  };
  const snapshot = (sessionId: string): SubagentRoutingSnapshot => {
    const ctx = assertCurrent(sessionId);
    const currentEntry = selectionEntry(ctx);
    const selection = readSubagentRoutingSelection(ctx);
    if (currentEntry !== entry) { entry = currentEntry; revision += 1; }
    return { protocol: 1, sessionId, serviceEpoch, revision, selection };
  };
  const service: SubagentRoutingService = {
    protocol: 1, sessionId: "", serviceEpoch,
    async getSnapshot(request) { return snapshot(request?.sessionId); },
    async set(request) {
      const ctx = assertCurrent(request?.expectedSessionId);
      const check = () => {
        if (assertCurrent(request.expectedSessionId) !== ctx) throw new Error("stale-session");
        if (request.expectedServiceEpoch !== serviceEpoch) throw new Error("stale-service");
        if (snapshot(request.expectedSessionId).revision !== request.expectedRevision) throw new Error("stale-selection");
      };
      check();
      const selection = validateSubagentRoutingSelection(request.selection);
      if (selection) {
        if (!ctx.modelRegistry.getAll().some(model => model.provider === selection.providerId && model.api !== "pi-virtual")) throw new Error("unknown-provider");
        if (selection.accountId !== null) {
          const accounts = globals[ACCOUNT_CONTROLS_KEY] as AccountControlsService | undefined;
          if (!accounts) throw new Error("account-controls-unavailable");
          const available = await accounts.getSnapshot({ sessionId: request.expectedSessionId, providerId: "openai-codex" });
          if (!available.accounts.some(account => account.id === selection.accountId)) throw new Error("unknown-account");
        }
      }
      check();
      // The concrete session manager targets this owner even when a sibling
      // session is active in an SDK host. Factory-bound appendEntry does not.
      (ctx.sessionManager as ExtensionContext["sessionManager"] & { appendCustomEntry(type: string, data: unknown): string })
        .appendCustomEntry(SUBAGENT_ROUTING_ENTRY, { version: 1, selection });
      return snapshot(request.expectedSessionId);
    },
  };
  globals[SUBAGENT_ROUTING_KEY] = service;
  pi.on("session_start", async (_event, ctx) => {
    context = ctx; service.sessionId = ctx.sessionManager.getSessionId(); entry = undefined; revision += 1;
    globals[SUBAGENT_ROUTING_KEY] = service;
  });
  pi.on("session_shutdown", async () => {
    context = undefined; service.sessionId = "";
    if (globals[SUBAGENT_ROUTING_KEY] === service) delete globals[SUBAGENT_ROUTING_KEY];
  });
  pi.registerCommand("subagent-provider", {
    description: "Show or set the provider and account for new subagents and Goal coordinators",
    handler: async (args, ctx) => {
      try {
        let state = await service.getSnapshot({ sessionId: ctx.sessionManager.getSessionId() });
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts.length) {
          if (parts.length > 2 || (parts[0] === "clear" && parts.length !== 1)) throw new Error("Use /subagent-provider [provider [account] | clear]");
          const selection = parts[0] === "clear" ? null : { providerId: parts[0], accountId: parts[1] ?? null };
          state = await service.set({ expectedSessionId: state.sessionId, expectedServiceEpoch: state.serviceEpoch, expectedRevision: state.revision, selection });
        }
        if (ctx.hasUI) ctx.ui.notify(state.selection ? `${state.selection.providerId} (${state.selection.accountId ?? "default login"})` : "Subagents follow this session", "info");
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "Subagent routing unavailable", "error"); }
    },
  });
}
