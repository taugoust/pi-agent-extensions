/**
 * Per-session provider and account for new subagents and Goal coordinators.
 *
 * Unset, subagents follow the session. Set, their tiers resolve on the chosen
 * provider and they log in with the chosen account. The choice is stored as a
 * custom entry on the session branch, so it survives reload and resume.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CONTROLS_KEY, type AccountControlsService } from "./account-controls.js";
import {
  getSessionRoutingProfile,
  routingProfilePath,
  sessionRoutingEnvironment,
  validateRoutingProfile,
  writeSessionRoutingProfile,
  type RoutingContext,
} from "./session-routing.ts";

export const SUBAGENT_ROUTING_KEY = "__paeSubagentRoutingV1";
export const SUBAGENT_ROUTING_ENTRY = "pi-subagent-routing-v1";

/** Named accounts are only managed for Codex. */
const NAMED_ACCOUNT_PROVIDER = "openai-codex";

export interface SubagentRoutingSelection {
  providerId: string;
  /** null selects the provider's default login, not the session's account. */
  accountId: string | null;
}

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

type SelectionContext = RoutingContext & {
  sessionManager: RoutingContext["sessionManager"] & {
    getBranch?(): readonly any[];
  };
};

type Environment = Record<string, string>;

export function validateSubagentRoutingSelection(
  value: unknown,
): SubagentRoutingSelection | null {
  if (value === null) return null;
  // Reuse the session routing validation for the provider and account fields.
  const profile = validateRoutingProfile({
    ...(value as SubagentRoutingSelection),
    version: 1,
    ownerSessionId: "subagents",
    revision: 0,
  });
  if (profile.accountId !== null && profile.providerId !== NAMED_ACCOUNT_PROVIDER) {
    throw new Error("unsupported-account-provider");
  }
  return { providerId: profile.providerId, accountId: profile.accountId };
}

function latestSelectionEntry(ctx: SelectionContext): any {
  const branch = ctx.sessionManager.getBranch?.() ?? [];
  return branch.findLast(
    (entry) => entry.type === "custom" && entry.customType === SUBAGENT_ROUTING_ENTRY,
  );
}

/** Reads the active branch, so it is right after reload, resume or tree navigation. */
export function readSubagentRoutingSelection(
  ctx: SelectionContext,
): SubagentRoutingSelection | null {
  const entry = latestSelectionEntry(ctx);
  if (!entry) return null;
  if (entry.data?.version !== 1) throw new Error("invalid-subagent-routing-state");
  return validateSubagentRoutingSelection(entry.data.selection);
}

/**
 * A branch holding only the current selection. Launch snapshots outlive Pi's
 * reload-scoped context, so they carry the choice made at launch time.
 */
export function frozenSelectionBranch(ctx: SelectionContext): () => readonly any[] {
  const selection = readSubagentRoutingSelection(ctx);
  const entry = {
    type: "custom",
    customType: SUBAGENT_ROUTING_ENTRY,
    data: { version: 1, selection },
  };
  return () => [entry];
}

function providerOf(model: string | undefined): string | undefined {
  const slash = model?.indexOf("/") ?? -1;
  return slash > 0 ? model!.slice(0, slash) : undefined;
}

/**
 * Writes a fresh routing file for one launch. The child keeps that file, so
 * changing the setting later never reroutes a running child.
 */
function launchRoutingEnvironment(
  ctx: SelectionContext,
  selection: SubagentRoutingSelection,
  agentDir: string,
): Environment {
  const ownerSessionId = ctx.sessionManager.getSessionId();
  const name = `${ownerSessionId}/subagents/${randomUUID()}`;
  const file = routingProfilePath(agentDir, name);
  writeSessionRoutingProfile(file, {
    version: 1,
    ownerSessionId,
    ...selection,
    revision: 0,
  });
  return {
    PI_SESSION_ROUTING_FILE: file,
    PI_SESSION_ROUTING_OWNER_SESSION: ownerSessionId,
  };
}

function sessionProviderOrUndefined(ctx: SelectionContext): string | undefined {
  try {
    return getSessionRoutingProfile(ctx)?.providerId;
  } catch {
    return undefined;
  }
}

/**
 * Account routing for one child, given its resolved model.
 *
 * - The child's provider is the subagent setting: use the setting's account.
 * - The child's provider is the session's: use the session's account.
 * - Any other provider: no routing, so it uses its own default login.
 */
export function subagentRoutingEnvironment(
  ctx: SelectionContext,
  model: string | undefined,
  agentDir: string,
): Environment {
  const provider = providerOf(model);
  const selection = readSubagentRoutingSelection(ctx);
  if (selection && provider === selection.providerId) {
    return launchRoutingEnvironment(ctx, selection, agentDir);
  }
  if (provider) {
    const sessionProvider = sessionProviderOrUndefined(ctx);
    if (sessionProvider !== undefined && sessionProvider !== provider) return {};
  }
  // An unready or broken session profile still fails closed here.
  return sessionRoutingEnvironment(ctx);
}

/**
 * AgentSH binds one routing file per request, not per child. Requests that mix
 * the configured provider with another one are refused, so no child silently
 * runs on the wrong account. Without a setting nothing changes.
 */
export function subagentRequestRoutingEnvironment(
  ctx: SelectionContext,
  models: readonly (string | undefined)[],
  agentDir: string,
): Environment {
  const selection = readSubagentRoutingSelection(ctx);
  if (!selection || models.length === 0) return sessionRoutingEnvironment(ctx);
  const providers = new Set(models.map((model) => model?.split("/")[0]));
  if (providers.has(selection.providerId) && providers.size > 1) {
    throw new Error("Split this AgentSH launch by provider to preserve subagent account routing");
  }
  if (providers.size > 1) return sessionRoutingEnvironment(ctx);
  return subagentRoutingEnvironment(ctx, models[0], agentDir);
}

async function assertKnownSelection(
  ctx: ExtensionContext,
  sessionId: string,
  selection: SubagentRoutingSelection,
): Promise<void> {
  const knownProvider = ctx.modelRegistry
    .getAll()
    .some((model) => model.provider === selection.providerId && model.api !== "pi-virtual");
  if (!knownProvider) throw new Error("unknown-provider");
  if (selection.accountId === null) return;

  const globals = globalThis as unknown as Record<string, unknown>;
  const accounts = globals[ACCOUNT_CONTROLS_KEY] as AccountControlsService | undefined;
  if (!accounts) throw new Error("account-controls-unavailable");
  const snapshot = await accounts.getSnapshot({
    sessionId,
    providerId: NAMED_ACCOUNT_PROVIDER,
  });
  if (!snapshot.accounts.some((account) => account.id === selection.accountId)) {
    throw new Error("unknown-account");
  }
}

function describeSelection(selection: SubagentRoutingSelection | null): string {
  if (!selection) return "Subagents follow this session";
  return `${selection.providerId} (${selection.accountId ?? "default login"})`;
}

/** Parses `/subagent-provider [provider [account] | clear]`. undefined means show. */
function parseCommand(args: string): SubagentRoutingSelection | null | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts[0] === "clear" && parts.length === 1) return null;
  if (parts[0] === "clear" || parts.length > 2) {
    throw new Error("Use /subagent-provider [provider [account] | clear]");
  }
  return { providerId: parts[0], accountId: parts[1] ?? null };
}

/**
 * Publishes the setting for Paseo on globalThis and adds `/subagent-provider`.
 * The service never exposes credentials or makes model calls.
 */
export function registerSubagentRoutingControls(pi: ExtensionAPI): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const serviceEpoch = randomUUID();
  let context: ExtensionContext | undefined;
  let seenEntry: unknown;
  let revision = 0;

  function currentContext(sessionId: string): ExtensionContext {
    if (globals[SUBAGENT_ROUTING_KEY] !== service) throw new Error("stale-service");
    const live = context?.sessionManager.getSessionId();
    if (!context || live !== sessionId || service.sessionId !== sessionId) {
      throw new Error("stale-session");
    }
    return context;
  }

  // The revision moves whenever the latest entry changes, including tree navigation.
  function snapshot(sessionId: string): SubagentRoutingSnapshot {
    const ctx = currentContext(sessionId);
    const entry = latestSelectionEntry(ctx);
    const selection = readSubagentRoutingSelection(ctx);
    if (entry !== seenEntry) {
      seenEntry = entry;
      revision += 1;
    }
    return { protocol: 1, sessionId, serviceEpoch, revision, selection };
  }

  const service: SubagentRoutingService = {
    protocol: 1,
    sessionId: "",
    serviceEpoch,

    async getSnapshot(request) {
      return snapshot(request?.sessionId);
    },

    async set(request) {
      const ctx = currentContext(request?.expectedSessionId);
      const assertUnchanged = () => {
        if (currentContext(request.expectedSessionId) !== ctx) throw new Error("stale-session");
        if (request.expectedServiceEpoch !== serviceEpoch) throw new Error("stale-service");
        if (snapshot(request.expectedSessionId).revision !== request.expectedRevision) {
          throw new Error("stale-selection");
        }
      };

      assertUnchanged();
      const selection = validateSubagentRoutingSelection(request.selection);
      if (selection) await assertKnownSelection(ctx, request.expectedSessionId, selection);
      // The account lookup is async, so check again before writing.
      assertUnchanged();

      // Write through this session's manager. The extension-level appendEntry
      // can target a sibling session in an SDK host.
      const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
        appendCustomEntry(type: string, data: unknown): string;
      };
      manager.appendCustomEntry(SUBAGENT_ROUTING_ENTRY, { version: 1, selection });
      return snapshot(request.expectedSessionId);
    },
  };

  globals[SUBAGENT_ROUTING_KEY] = service;

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    service.sessionId = ctx.sessionManager.getSessionId();
    seenEntry = undefined;
    revision += 1;
    globals[SUBAGENT_ROUTING_KEY] = service;
  });

  pi.on("session_shutdown", async () => {
    context = undefined;
    service.sessionId = "";
    if (globals[SUBAGENT_ROUTING_KEY] === service) delete globals[SUBAGENT_ROUTING_KEY];
  });

  pi.registerCommand("subagent-provider", {
    description: "Show or set the provider and account for new subagents and Goal coordinators",
    handler: async (args, ctx) => {
      const notify = (message: string, level: "info" | "error") => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        let state = await service.getSnapshot({ sessionId });
        const selection = parseCommand(args);
        if (selection !== undefined) {
          state = await service.set({
            expectedSessionId: state.sessionId,
            expectedServiceEpoch: state.serviceEpoch,
            expectedRevision: state.revision,
            selection,
          });
        }
        notify(describeSelection(state.selection), "info");
      } catch (error) {
        notify(error instanceof Error ? error.message : "Subagent routing unavailable", "error");
      }
    },
  });
}
