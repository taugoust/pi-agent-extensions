/**
 * Reload on deploy
 *
 * Reloads Pi once it is idle after a deploy changes the Nix-managed config
 * and extensions in its agent directory, so running sessions pick up the new
 * code without a manual /reload.
 *
 * A supervised Pi runs from a private copy of the agent directory made at
 * startup, so reloading would load the old files again. There the extension
 * watches the real directory and asks for a restart instead.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigChangeDetector, readConfigFingerprint } from "./fingerprint.js";

const POLL_MS = 10_000;
const COMMAND = "reload-after-deploy";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** The directory a supervised Pi copied its agent directory from, if any. */
function supervisedSource(): string | null {
  const source = process.env.PI_UNSAFE_AGENT_DIR;
  return source && source !== agentDir() ? source : null;
}

export default function reloadOnDeploy(pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let detector: ConfigChangeDetector | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let requested = false;

  const ready = (current: ExtensionContext) => current.isIdle() && !current.hasPendingMessages();

  const supervised = supervisedSource();
  const watchedDir = supervised ?? agentDir();
  let restartNoticeShown = false;

  const poll = () => {
    if (!ctx || !detector || requested) return;
    try {
      if (!detector.observe(readConfigFingerprint(watchedDir))) return;
      if (supervised) {
        if (!restartNoticeShown && ctx.hasUI) {
          ctx.ui.notify("A deploy changed Pi's config. Restart this session to use it.", "info");
        }
        restartNoticeShown = true;
        return;
      }
      // Wait for the current turn and anything queued behind it.
      if (!ready(ctx)) return;
      requested = true;
      pi.sendUserMessage(`/${COMMAND}`, { expandPromptTemplates: true });
    } catch {
      requested = false;
    }
  };

  pi.on("session_start", async (_event, current) => {
    ctx = current;
    detector = new ConfigChangeDetector(readConfigFingerprint(watchedDir));
    requested = false;
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = null;
    ctx = null;
  });

  pi.registerCommand(COMMAND, {
    description: "Reload Pi after a deploy changed its config (runs automatically when idle)",
    handler: async (_args, current) => {
      if (!ready(current)) {
        // Something started in between. The next poll asks again.
        requested = false;
        return;
      }
      if (current.hasUI) current.ui.notify("A deploy changed Pi's config, reloading.", "info");
      try {
        // The old runtime, including this closure, is invalid after reload.
        await current.reload();
      } catch (error) {
        requested = false;
        if (current.hasUI)
          current.ui.notify(`Reload after deploy failed: ${String(error)}`, "error");
      }
    },
  });
}
