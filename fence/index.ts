/**
 * Fence Extension
 *
 * Blocks write and edit tool calls targeting paths outside the current
 * working directory. Complements the sandbox extension, which restricts
 * bash commands at the OS level, by closing the same gap for pi's native
 * file tools.
 *
 * - Intercepts write and edit tool calls.
 * - Resolves the target path (absolute or relative) against ctx.cwd.
 * - Blocks any call whose resolved path falls outside ctx.cwd.
 * - Returns a clear reason to the LLM so it understands the constraint.
 * - Toggle with /fence command.
 * - Status bar shows "fence ■" (warning colour) when active.
 *
 * In non-interactive mode (no UI), fence still enforces the path check
 * because it is a security control, not a UX feature.
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
    description: "Toggle fence — block write/edit outside the working directory",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("fence", ctx.ui.theme.fg("warning", "fence ■"));
          ctx.ui.notify(
            `Fence enabled — write/edit are restricted to ${ctx.cwd}`,
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

    if (!insideCwd) {
      return {
        block: true,
        reason:
          `Path is outside the working directory (${ctx.cwd}): ${resolvedTarget}. ` +
          `Only paths inside ${ctx.cwd} are allowed while fence is active.`,
      };
    }

    // Path is inside cwd — let the tool proceed
  });
}
