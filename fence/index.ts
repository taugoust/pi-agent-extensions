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
 * - Follows symlinks for the target path and its existing parent chain.
 * - For paths outside ctx.cwd: prompts the user to allow or block.
 * - In headless mode (no UI): hard-blocks with a clear reason.
 * - Toggle with /fence command.
 * - Status bar shows "fence ■" (warning colour) when active.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeAtPrefix(filePath);

  if (normalized === "~") {
    return homedir();
  }

  if (normalized.startsWith("~/")) {
    return resolve(homedir(), normalized.slice(2));
  }

  return normalized;
}

function resolveToolPath(cwd: string, filePath: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const relPath = relative(baseDir, targetPath);
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function resolveThroughExistingPath(targetPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = resolve(targetPath);

  while (true) {
    try {
      const resolvedPath = await realpath(currentPath);
      return missingSegments.length === 0
        ? resolvedPath
        : resolve(resolvedPath, ...missingSegments.reverse());
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return missingSegments.length === 0
          ? currentPath
          : resolve(currentPath, ...missingSegments.reverse());
      }

      missingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function resolveFencePaths(cwd: string, filePath: string) {
  const absoluteCwd = resolve(cwd);
  const absoluteTarget = resolveToolPath(cwd, filePath);
  const resolvedCwd = await resolveThroughExistingPath(absoluteCwd);
  const resolvedTarget = await resolveThroughExistingPath(absoluteTarget);

  return {
    absoluteTarget,
    resolvedCwd,
    resolvedTarget,
  };
}

function formatResolvedPath(rawPath: string, absolutePath: string, resolvedPath: string): string {
  if (resolvedPath === absolutePath) {
    return resolvedPath;
  }

  return `${rawPath} → ${resolvedPath}`;
}

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

    const rawPath = event.input.path;

    // If there is no path parameter, let the tool handle it normally
    if (typeof rawPath !== "string" || rawPath.length === 0) return;

    let absoluteTarget: string;
    let resolvedTarget: string;
    let resolvedCwd: string;

    try {
      ({ absoluteTarget, resolvedTarget, resolvedCwd } = await resolveFencePaths(ctx.cwd, rawPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        block: true,
        reason:
          `Fence could not resolve the target path safely: ${rawPath}. ` +
          `Blocked until the path can be reviewed (${message}).`,
      };
    }

    if (isPathInside(resolvedCwd, resolvedTarget)) return;

    const targetDisplay = formatResolvedPath(rawPath, absoluteTarget, resolvedTarget);

    // Path is outside cwd — prompt the user if UI is available, otherwise
    // hard-block (no way to ask in headless mode).
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `Path is outside the working directory (${resolvedCwd}): ${targetDisplay}. ` +
          `Blocked in headless mode — no UI available for confirmation.`,
      };
    }

    pi.events.emit("fence:waiting", undefined);

    const choice = await ctx.ui.select(
      `⚠️  Write outside working directory:\n\n  ${targetDisplay}\n\n  (cwd: ${resolvedCwd})\n\nAllow?`,
      ["Yes", "No"],
    );

    pi.events.emit("fence:resolved", undefined);

    if (choice !== "Yes") {
      return {
        block: true,
        reason: `Blocked by user — path is outside the working directory (${resolvedCwd}): ${targetDisplay}.`,
      };
    }

    // User approved — let the tool proceed
  });
}
