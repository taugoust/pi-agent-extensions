/**
 * Pager — open the conversation in an external pager (bat or less).
 *
 * - `/pager` command:      tool output truncated to 10 lines
 * - `/pager-full` command: full tool output
 * - Ctrl+Shift+K shortcut (truncated mode)
 * - K in modal-editor normal mode via the `pager:open` event (truncated mode)
 *
 * The pager uses the alternate screen buffer, so pi's display is restored
 * instantly when you quit — no conversation replay.
 */

import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_MAX_LINES = 10;

/** Cap text to `maxLines` lines; append "..." if truncated. */
function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + "\n...";
}

/** Hard-wrap every line in `text` to `width` columns. */
function wrapText(text: string, width: number): string {
	if (width <= 0) return text;
	const lines = text.split("\n");
	const result: string[] = [];
	for (const line of lines) {
		if (line.length <= width) {
			result.push(line);
		} else {
			let remaining = line;
			while (remaining.length > width) {
				// Try to break at a space within the last 20% of the width
				let breakAt = remaining.lastIndexOf(" ", width);
				if (breakAt <= width * 0.8 || breakAt === -1) breakAt = width;
				result.push(remaining.slice(0, breakAt));
				remaining = remaining.slice(breakAt).replace(/^ /, "");
			}
			if (remaining) result.push(remaining);
		}
	}
	return result.join("\n");
}

// ---------------------------------------------------------------------------
// Conversation extraction
// ---------------------------------------------------------------------------

interface ExtractOptions {
	hideThinking: boolean;
	/** When false, tool call arguments and tool result output are truncated. */
	full: boolean;
}

/**
 * Walk the current session branch and produce a markdown representation
 * of the conversation.
 */
function extractConversation(ctx: ExtensionContext, opts: ExtractOptions): string {
	const { hideThinking, full } = opts;
	const entries = ctx.sessionManager.getBranch();
	const parts: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as Record<string, unknown>;
		const role = msg.role as string;

		if (role === "user") {
			parts.push("## User\n");
			const content = msg.content;
			if (typeof content === "string") {
				parts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if ((block as { type: string }).type === "text") parts.push((block as { text: string }).text);
					else if ((block as { type: string }).type === "image") parts.push("[image]");
				}
			}
			parts.push("\n");

		} else if (role === "assistant") {
			parts.push("## Assistant\n");
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					const btype = (block as { type: string }).type;
					if (btype === "text") {
						parts.push((block as { text: string }).text);
					} else if (btype === "thinking") {
						if (!hideThinking) {
							parts.push("<thinking>\n" + (block as { thinking: string }).thinking + "\n</thinking>");
						}
					} else if (btype === "toolCall") {
						const tc = block as { name: string; arguments: Record<string, unknown> };
						let body: string;
						try { body = JSON.stringify(tc.arguments, null, 2); } catch { body = "{}"; }
						if (!full) body = truncateLines(body, TOOL_OUTPUT_MAX_LINES);
						parts.push(`### Tool call: ${tc.name}\n\`\`\`json\n${body}\n\`\`\``);
					}
				}
			}
			parts.push("\n");

		} else if (role === "toolResult") {
			const toolName = msg.toolName as string;
			const isError = msg.isError as boolean;
			let body = "";
			const content = msg.content;
			if (Array.isArray(content)) {
				const texts: string[] = [];
				for (const block of content) {
					if ((block as { type: string }).type === "text") texts.push((block as { text: string }).text);
				}
				body = texts.join("\n");
			}
			if (!full) body = truncateLines(body, TOOL_OUTPUT_MAX_LINES);
			parts.push(`### Tool result: ${toolName}${isError ? " (error)" : ""}\n${body}\n`);

		} else if (role === "bashExecution") {
			const cmd = msg.command as string;
			const output = msg.output as string;
			let body = output;
			if (!full) body = truncateLines(body, TOOL_OUTPUT_MAX_LINES);
			parts.push(`## Shell\n\`\`\`\n$ ${cmd}\n${body}\n\`\`\`\n`);

		} else if (role === "compactionSummary") {
			parts.push("## Compaction summary\n");
			parts.push((msg.summary as string) ?? "");
			parts.push("\n");

		} else if (role === "branchSummary") {
			parts.push("## Branch summary\n");
			parts.push((msg.summary as string) ?? "");
			parts.push("\n");
		}
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Pager selection & launch
// ---------------------------------------------------------------------------

/**
 * Pick the best available pager.  Prefers `bat` (syntax-highlighted markdown)
 * then falls back to `less -R`.
 */
function findPager(): { cmd: string; args: string[] } {
	try {
		execSync("command -v bat", { stdio: "ignore" });
		return { cmd: "bat", args: ["--language", "md", "--style", "plain", "--paging", "always"] };
	} catch { /* bat not found */ }
	return { cmd: "less", args: ["-R"] };
}

/**
 * Open the conversation in an external pager.
 *
 * Uses the alternate screen buffer (via less/bat) so the terminal restores
 * pi's output when the pager exits.  We intentionally skip a forced
 * re-render — the screen is already correct after alternate-screen restore
 * and the non-forced differential render triggered by tui.start() is a no-op.
 */
function openPager(tui: TUI, ctx: ExtensionContext, full: boolean): void {
	const hideThinking = SettingsManager.create().getHideThinkingBlock();
	const text = extractConversation(ctx, { hideThinking, full });
	if (!text.trim()) {
		ctx.ui.notify("Nothing to page — conversation is empty.", "info");
		return;
	}

	const width = process.stdout.columns || 80;
	const wrapped = wrapText(text, width);

	const tmpFile = join(tmpdir(), `pi-pager-${Date.now()}.md`);
	try {
		writeFileSync(tmpFile, wrapped, "utf-8");
		const pager = findPager();

		tui.stop();
		try {
			spawnSync(pager.cmd, [...pager.args, tmpFile], {
				stdio: "inherit",
				shell: platform() === "win32",
			});
		} finally {
			tui.start();
		}
	} finally {
		try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let tui: TUI | null = null;
	let sessionCtx: ExtensionContext | null = null;

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;

		// Grab the TUI reference via a one-shot custom component.
		// The factory receives tui, we capture it and immediately close.
		ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
			tui = _tui;
			done();
			return { render: () => [], invalidate: () => {} };
		});
	});

	const launch = (ctx: ExtensionContext, full: boolean): void => {
		if (!tui) {
			ctx.ui.notify("Pager not available (no TUI reference).", "error");
			return;
		}
		openPager(tui, ctx, full);
	};

	pi.registerCommand("pager", {
		description: "Open conversation in a pager (tool output truncated to 10 lines)",
		handler: async (_args, ctx) => {
			launch(ctx, false);
		},
	});

	pi.registerCommand("pager-full", {
		description: "Open conversation in a pager (full tool output)",
		handler: async (_args, ctx) => {
			launch(ctx, true);
		},
	});

	pi.registerShortcut("ctrl+shift+k", {
		description: "Open conversation pager",
		handler: async (ctx) => {
			launch(ctx, false);
		},
	});

	// Allow other extensions (e.g. modal-editor) to trigger the pager via
	// the shared event bus without depending on this extension directly.
	pi.events.on("pager:open", () => {
		if (sessionCtx) launch(sessionCtx, false);
	});
}
