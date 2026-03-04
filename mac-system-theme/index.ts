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

    let currentTheme = (await isDarkMode()) ? "dark" : "light";
    ctx.ui.setTheme(currentTheme);

    intervalId = setInterval(async () => {
      const newTheme = (await isDarkMode()) ? "dark" : "light";
      if (newTheme !== currentTheme) {
        currentTheme = newTheme;
        ctx.ui.setTheme(currentTheme);
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
