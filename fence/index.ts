/**
 * Fence Extension
 *
 * Intercepts write and edit tool calls targeting paths outside the current
 * working directory and prompts the user for confirmation before allowing
 * them. Complements the sandbox extension, which restricts bash commands at
 * the OS level, by closing the same gap for pi's native file tools.
 *
 * - Intercepts write and edit tool calls.
 * - Resolves the target path (absolute or relative) against ctx.cwd.
 * - For paths outside ctx.cwd: prompts the user to allow or block.
 * - In headless mode (no UI): hard-blocks with a clear reason.
 * - Toggle with /fence command.
 * - Status bar shows "fence ■" (warning colour) when active.
 */

import { resolve, normalize } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function fence(pi: ExtensionAPI) {
  // State: whether fence is currently enabled
  let enabled = false;

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  // Register /fence command — toggle path enforcement on/off
  pi.registerCommand("fence", {
    description: "Toggle fence — prompt before write/edit outside the working directory",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("fence", ctx.ui.theme.fg("warning", "fence ■"));
          ctx.ui.notify(
            `Fence enabled — write/edit outside ${ctx.cwd} will require approval`,
            "info",
          );
        }
      } else {
        if (ctx.hasUI) {
          ctx.ui.setStatus("fence", undefined);
          ctx.ui.notify("Fence disabled", "info");
        }
      }
    },
  });

  ////----------------------------------------
  ///     Tool call interception
  //------------------------------------------

  // Hook into tool_call event — fires BEFORE tool execution.
  // Returning { block: true, reason } prevents the tool from running.
  pi.on("tool_call", async (event, ctx) => {
    // Pass through if fence is disabled
    if (!enabled) return;

    // Only intercept write and edit
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = event.input.path as string | undefined;

    // If there is no path parameter, let the tool handle it normally
    if (!rawPath) return;

    // Resolve and normalise both paths to handle '..' traversal attempts
    // and mixed absolute/relative inputs.
    //
    // ctx.cwd is the session working directory set by pi — always absolute.
    // We use ctx.cwd as the base for relative paths instead of process.cwd()
    // because the two can differ when pi is invoked from a different directory.
    const resolvedTarget = normalize(resolve(ctx.cwd, rawPath));
    const resolvedCwd = normalize(ctx.cwd);

    // A path is "inside cwd" when it equals cwd or starts with cwd + separator.
    // The separator check prevents "/workspace-other" from matching "/workspace".
    const insideCwd =
      resolvedTarget === resolvedCwd ||
      resolvedTarget.startsWith(resolvedCwd + "/");

    if (insideCwd) return;

    // Path is outside cwd — prompt the user if UI is available, otherwise
    // hard-block (no way to ask in headless mode).
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `Path is outside the working directory (${ctx.cwd}): ${resolvedTarget}. ` +
          `Blocked in headless mode — no UI available for confirmation.`,
      };
    }

    pi.events.emit("fence:waiting");

    const choice = await ctx.ui.select(
      `⚠️  Write outside working directory:\n\n  ${resolvedTarget}\n\n  (cwd: ${ctx.cwd})\n\nAllow?`,
      ["Yes", "No"],
    );

    pi.events.emit("fence:resolved");

    if (choice !== "Yes") {
      return {
        block: true,
        reason: `Blocked by user — path is outside the working directory (${ctx.cwd}): ${resolvedTarget}.`,
      };
    }

    // User approved — let the tool proceed
  });
}
