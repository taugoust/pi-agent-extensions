/**
 * Direnv Extension
 *
 * Unsupervised Pi retains the traditional shell-hook behaviour: run
 * `direnv export json` locally and apply its result to the parent process.
 * Supervised Pi instead asks the exact attached AgentSH session to refresh its
 * server-owned environment. Project code and environment values never cross
 * into the trusted parent process in that mode.
 */

import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { DirenvRefreshResult } from "../sandbox/api.js";

const DIAGNOSTIC_LIMIT = 500;

export default function (pi: ExtensionAPI) {
  let pending: Promise<void> | null = null;
  const supervised = process.env.PI_SUPERVISED === "1"
    || Boolean(process.env.AGENTSH_SESSION_SUPERVISOR)
    || process.env.PI_AGENTSH_ENABLE === "1"
    || Boolean(process.env.PI_AGENTSH_MOCK_SUPERVISOR);

  async function loadDirenv(cwd: string, ctx: ExtensionContext) {
    // Chain before awaiting so any number of simultaneous tool_result handlers
    // are serialized rather than all resuming behind the same predecessor.
    const previous = pending;
    const current = (async () => {
      if (previous) await previous;
      if (ctx.hasUI) {
        ctx.ui.setStatus("direnv", ctx.ui.theme.fg("warning", "direnv …"));
      }
      await (supervised ? runSupervisedDirenv(cwd, ctx) : runDirenv(cwd, ctx));
    })();
    pending = current;
    try {
      await current;
    } finally {
      if (pending === current) pending = null;
    }
  }

  async function runSupervisedDirenv(cwd: string, ctx: ExtensionContext) {
    const api = globalThis.__AGENTSH_PI__;
    if (!api?.refreshDirenv) {
      reportFailure(ctx, "AgentSH direnv refresh is unavailable; supervised mode will not run direnv in the parent");
      return;
    }

    try {
      const result = await api.refreshDirenv({
        cwd,
        actor: { kind: "extension", label: "Pi direnv refresh" },
      });
      renderSupervisedResult(result, ctx);
    } catch (error) {
      reportFailure(ctx, `AgentSH direnv refresh failed: ${errorMessage(error)}`);
    }
  }

  function renderSupervisedResult(result: DirenvRefreshResult, ctx: ExtensionContext) {
    switch (result.state) {
      case "no_envrc":
        if (ctx.hasUI) ctx.ui.setStatus("direnv", undefined);
        return;
      case "loaded":
      case "unchanged":
        if (ctx.hasUI) ctx.ui.setStatus("direnv", ctx.ui.theme.fg("success", "direnv ✓"));
        return;
      case "not_allowed":
        reportFailure(ctx, "direnv environment is not allowed; run `direnv allow` through bash in this supervised session", "warning");
        return;
      case "policy_denied":
        reportFailure(ctx, "AgentSH policy denied direnv refresh");
        return;
      case "timed_out":
        reportFailure(ctx, "AgentSH direnv refresh timed out");
        return;
      case "invalid_output":
        reportFailure(ctx, "AgentSH rejected invalid or oversized direnv output");
        return;
      case "unavailable":
        reportFailure(ctx, "direnv is unavailable in the AgentSH execution session");
        return;
      default:
        reportFailure(ctx, "AgentSH returned an unknown direnv refresh state");
    }
  }

  function reportFailure(ctx: ExtensionContext, message: string, level: "warning" | "error" = "error") {
    const bounded = message.replace(/[\r\n]+/g, " ").slice(0, DIAGNOSTIC_LIMIT);
    if (ctx.hasUI) {
      ctx.ui.setStatus("direnv", ctx.ui.theme.fg(level === "warning" ? "warning" : "error", "direnv ✗"));
      ctx.ui.notify(bounded, level);
    } else {
      process.stderr.write(`[direnv] ${bounded}\n`);
    }
  }

  function runDirenv(cwd: string, ctx: ExtensionContext) {
    const proc = spawn("direnv", ["export", "json"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const done = new Promise<void>((resolve) => {
      proc.on("close", (code) => {
        if (code !== 0) {
          if (ctx.hasUI) {
            ctx.ui.setStatus(
              "direnv",
              ctx.ui.theme.fg("error", "direnv ✗"),
            );
          }
          resolve();
          return;
        }

        applyEnv(stdout, ctx);
        // No env changes means everything is in sync — still a success
        if (ctx.hasUI && !stdout.trim()) {
          ctx.ui.setStatus("direnv", ctx.ui.theme.fg("success", "direnv ✓"));
        }
        resolve();
      });

      proc.on("error", () => {
        if (ctx.hasUI) {
          ctx.ui.setStatus("direnv", ctx.ui.theme.fg("error", "direnv ✗"));
        }
        resolve();
      });
    });

    // Preserve the existing unsupervised behaviour: wait up to ten seconds,
    // then let a slow local direnv process complete in the background.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    return Promise.race([done, timeout]);
  }

  function applyEnv(output: string, ctx: ExtensionContext) {
    if (!output.trim()) return;

    try {
      const env = JSON.parse(output);
      let loadedCount = 0;
      for (const [key, value] of Object.entries(env)) {
        if (value === null) {
          delete process.env[key];
        } else {
          process.env[key] = value as string;
          loadedCount++;
        }
      }

      if (ctx.hasUI && loadedCount > 0) {
        ctx.ui.setStatus("direnv", ctx.ui.theme.fg("success", "direnv ✓"));
      }
    } catch {
      if (ctx.hasUI) {
        ctx.ui.setStatus("direnv", ctx.ui.theme.fg("error", "direnv ✗"));
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await loadDirenv(ctx.cwd, ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    await loadDirenv(ctx.cwd, ctx);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
