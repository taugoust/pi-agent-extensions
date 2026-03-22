/**
 * Pager — open the conversation in an external pager (bat or less).
 *
 * - `/pager` command to open the pager
 * - Ctrl+Shift+K shortcut for quick access
 *
 * The pager uses the alternate screen buffer, so pi's display is restored
 * instantly when you quit — no conversation replay.
 */

import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Conversation extraction
// ---------------------------------------------------------------------------

/**
 * Walk the current session branch and produce a plain-text / light-markdown
 * representation of the conversation.
 */
function extractConversation(ctx: ExtensionContext): string {
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
						parts.push("<thinking>\n" + (block as { thinking: string }).thinking + "\n</thinking>");
					} else if (btype === "toolCall") {
						const tc = block as { name: string; arguments: Record<string, unknown> };
						parts.push(`### Tool call: ${tc.name}\n`);
						try { parts.push("```json\n" + JSON.stringify(tc.arguments, null, 2) + "\n```"); } catch { /* */ }
					}
				}
			}
			parts.push("\n");
		} else if (role === "toolResult") {
			const toolName = msg.toolName as string;
			const isError = msg.isError as boolean;
			parts.push(`### Tool result: ${toolName}${isError ? " (error)" : ""}\n`);
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if ((block as { type: string }).type === "text") parts.push((block as { text: string }).text);
				}
			}
			parts.push("\n");
		} else if (role === "bashExecution") {
			const cmd = msg.command as string;
			const output = msg.output as string;
			parts.push(`## Shell\n\`\`\`\n$ ${cmd}\n${output}\n\`\`\`\n`);
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
 * then falls back to `less -R` (pass-through ANSI).
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
function openPager(tui: TUI, ctx: ExtensionContext): void {
	const text = extractConversation(ctx);
	if (!text.trim()) {
		ctx.ui.notify("Nothing to page — conversation is empty.", "info");
		return;
	}

	const tmpFile = join(tmpdir(), `pi-pager-${Date.now()}.md`);
	try {
		writeFileSync(tmpFile, text, "utf-8");
		const pager = findPager();

		tui.stop();
		try {
			spawnSync(pager.cmd, [...pager.args, tmpFile], {
				stdio: "inherit",
				shell: platform() === "win32",
			});
		} finally {
			tui.start();
			// No requestRender(true) — alternate screen restored the display.
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

	const launch = (ctx: ExtensionContext): void => {
		if (!tui) {
			ctx.ui.notify("Pager not available (no TUI reference).", "error");
			return;
		}
		openPager(tui, ctx);
	};

	pi.registerCommand("pager", {
		description: "Open conversation in an external pager (bat/less)",
		handler: async (_args, ctx) => {
			launch(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+k", {
		description: "Open conversation pager",
		handler: async (ctx) => {
			launch(ctx);
		},
	});

	// Allow other extensions (e.g. modal-editor) to trigger the pager via
	// the shared event bus without depending on this extension directly.
	pi.events.on("pager:open", () => {
		if (sessionCtx) launch(sessionCtx);
	});
}
