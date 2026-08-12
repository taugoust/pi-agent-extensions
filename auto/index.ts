import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentSHSupervisorMetadata, AgentSHSupervisorStatus } from "../sandbox/api.js";
import { type AutoAction, writeAutoActionRequest } from "./request.js";

type DraftIdentity = {
  sessionId: string;
  requestPath: string;
  authorization: string;
  status: AgentSHSupervisorStatus | "unavailable";
  metadata?: AgentSHSupervisorMetadata;
};

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function draftIdentity(): DraftIdentity {
  if (env("PI_AUTO") !== "1" || env("PI_AGENTSH_WORKSPACE_MODE") !== "shadow") {
    throw new Error("This Pi process is not running in a Pi Auto Draft");
  }
  if (env("AGENTSH_SUBAGENT_ID")) throw new Error("Draft actions are unavailable in subagents");

  const sessionId = env("AGENTSH_SESSION_ID");
  const requestPath = env("PI_AUTO_ACTION_REQUEST");
  const authorization = env("PI_AUTO_ACTION_TOKEN");
  if (!sessionId) throw new Error("Draft session identity is unavailable");
  if (!requestPath || !authorization) throw new Error("Draft action control is unavailable");
  if (!/^[0-9a-f]{64}$/.test(authorization)) throw new Error("Draft action authorization is malformed");

  const state = globalThis.__AGENTSH_PI__?.getSupervisorState();
  const metadata = globalThis.__AGENTSH_PI__?.getSupervisorMetadata() ?? state?.metadata;
  if (state?.sessionId && state.sessionId !== sessionId) {
    throw new Error("Live AgentSH session does not match this Draft");
  }
  const metadataSession = metadata?.session_id ?? metadata?.sessionId;
  if (metadataSession && metadataSession !== sessionId) {
    throw new Error("Live AgentSH metadata does not match this Draft");
  }
  if (metadata?.workspace_mode && metadata.workspace_mode !== "shadow") {
    throw new Error("Live AgentSH workspace is not a Draft workspace");
  }
  return { sessionId, requestPath, authorization, status: state?.status ?? "unavailable", metadata };
}

function displayProject(identity: DraftIdentity) {
  return identity.metadata?.real_workspace
    ?? identity.metadata?.workspace_roots?.[0]?.real
    ?? env("PI_AUTO_REAL_DIR")
    ?? "current project";
}

function statusText(identity: DraftIdentity, pending?: AutoAction) {
  if (pending) return `auto · ${pending} requested`;
  if (identity.status === "connected" || identity.status === "pending") return "auto · Draft ready";
  if (identity.status === "connecting" || identity.status === "starting") return "auto · reconnecting";
  return "auto · Draft safe · connection degraded";
}

function setStatus(ctx: ExtensionContext, pending?: AutoAction) {
  if (!ctx.hasUI) return;
  try {
    const identity = draftIdentity();
    const warning = pending || !(identity.status === "connected" || identity.status === "pending");
    ctx.ui.setStatus("auto", ctx.ui.theme.fg(warning ? "warning" : "success", statusText(identity, pending)));
  } catch {
    ctx.ui.setStatus("auto", ctx.ui.theme.fg("error", "auto · unavailable"));
  }
}

function notifyError(ctx: ExtensionCommandContext, error: unknown) {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

export default function autoExtension(pi: ExtensionAPI) {
  if (env("PI_AUTO") !== "1") return;

  let busy = false;
  let committed = false;

  pi.on("session_start", (_event, ctx) => setStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("auto", undefined);
  });

  pi.registerCommand("auto", {
    description: "Review, apply, discard, or pause this Pi Auto Draft",
    handler: async (args, ctx) => {
      if (args.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Use /auto without arguments", "warning");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI || env("AGENTSH_SUBAGENT_ID")) {
        if (ctx.hasUI) ctx.ui.notify("/auto is available only in top-level interactive Pi Auto", "error");
        return;
      }
      if (committed) {
        ctx.ui.notify("A Draft action is already pending; shutting down…", "info");
        ctx.shutdown();
        return;
      }
      if (busy) return;
      busy = true;
      try {
        await ctx.waitForIdle();
        const identity = draftIdentity();
        const project = displayProject(identity);
        const selection = await ctx.ui.select(
          [
            "Pi Auto Draft",
            `Project: ${project}`,
            `Connection: ${identity.status}`,
            "Your project is unchanged until you Apply.",
          ].join("\n"),
          ["Review", "Apply and exit", "Discard and exit", "Pause and exit"],
        );
        if (!selection) return;

        const action: AutoAction = selection === "Review"
          ? "review"
          : selection === "Apply and exit"
            ? "apply"
            : selection === "Discard and exit"
              ? "discard"
              : "pause";

        if (action === "apply") {
          const confirmed = await ctx.ui.confirm(
            "Apply Draft changes?",
            `A fresh change summary will be shown before file content is applied to ${project}. Git history, index, and branches are not applied.`,
          );
          if (!confirmed) return;
        } else if (action === "discard") {
          const confirmed = await ctx.ui.confirm(
            "Discard this Draft?",
            `Draft changes will be previewed before they are permanently discarded. ${project} will remain unchanged.`,
          );
          if (!confirmed) return;
        }

        await ctx.waitForIdle();
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          throw new Error("Pi still has pending work; wait for it to settle before finalizing the Draft");
        }
        const finalIdentity = draftIdentity();
        writeAutoActionRequest(
          finalIdentity.requestPath,
          finalIdentity.sessionId,
          action,
          finalIdentity.authorization,
        );
        committed = true;
        setStatus(ctx, action);
        ctx.ui.notify(`${selection} requested; shutting down safely…`, "info");
        ctx.shutdown();
      } catch (error) {
        notifyError(ctx, error);
        setStatus(ctx);
      } finally {
        busy = false;
      }
    },
  });
}
