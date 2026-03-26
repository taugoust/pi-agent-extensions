/**
 * Mac System Theme Extension
 *
 * Syncs pi theme with macOS system appearance (dark/light mode). Polls the
 * system every 2 seconds and switches the pi theme automatically when the
 * appearance changes.
 *
 * Requirements:
 *   - macOS with osascript available
 *   - A "dark" and "light" theme configured in pi
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execAsync = promisify(exec);

async function isDarkMode(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      "osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") {
    throw new Error("mac-system-theme: only supported on macOS");
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Require multiple consecutive readings of a new theme before switching,
    // to avoid flicker from transient/incorrect osascript results.
    const CONFIRM_COUNT = 3;
    let currentTheme = (await isDarkMode()) ? "dark" : "light";
    ctx.ui.setTheme(currentTheme);

    let pendingTheme: string | null = null;
    let pendingCount = 0;

    intervalId = setInterval(async () => {
      const newTheme = (await isDarkMode()) ? "dark" : "light";
      if (newTheme !== currentTheme) {
        if (newTheme === pendingTheme) {
          pendingCount++;
        } else {
          pendingTheme = newTheme;
          pendingCount = 1;
        }
        if (pendingCount >= CONFIRM_COUNT) {
          currentTheme = newTheme;
          pendingTheme = null;
          pendingCount = 0;
          ctx.ui.setTheme(currentTheme);
        }
      } else {
        // Current reading matches active theme — reset any pending switch
        pendingTheme = null;
        pendingCount = 0;
      }
    }, 2000);
  });

  pi.on("session_shutdown", () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
}
