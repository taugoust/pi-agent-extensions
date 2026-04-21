/**
 * Modal Editor - vim-like modal editing
 *
 * Normal mode keybindings:
 *   Navigation:  h j k l   w e b   0 ^ $   f{c} t{c} F{c} T{c}   gg G
 *   Insert:      i a I A   o O   C s
 *   Editing:     x X   D   r{c}   p P   u
 *   Operators:   d(d|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c}|iw|iW|aw|aW|gg|G)
 *                c(c|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c}|iw|iW|aw|aW|gg|G)
 *                y(y|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c}|iw|iW|aw|aW|gg|G)   Y
 *   Reflow:     gq(q|j|k|G|gg)   Q (reflow entire buffer)
 *               In visual/V-line: gq reflows selected lines.
 *   Clipboard:  y/p/P use the system clipboard.  Cmd+V (bracketed paste) still works.
 *   Pager:      K emits pager:open event (opens pager if pager extension is loaded).
 *   Visual:      v → select with motions → d/c/x/y/o/</> (o swaps endpoint)
 *   Visual-line: V → select lines with j/k → d/c/x/y/o/</> (o swaps endpoint)
 *   Escape:      insert → normal, normal → abort agent
 */

import { execSync } from "child_process";
import { platform } from "os";
import { copyToClipboard, CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Word-wrap helper (mirrors Editor's internal wordWrapLine, inlined for
// independence from private API)
// ---------------------------------------------------------------------------

const _segmenter = new Intl.Segmenter();

interface TextChunk {
	text: string;
	startIndex: number; // inclusive, byte index into the logical line
	endIndex: number;   // exclusive
}

function computeWordWrap(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
	if (visibleWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }];

	const chunks: TextChunk[] = [];
	const segments = [..._segmenter.segment(line)];
	let currentWidth = 0;
	let chunkStart = 0;
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = /\s/.test(grapheme);

		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0) {
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		currentWidth += gWidth;
		const next = segments[i + 1];
		if (isWs && next && !/\s/.test(next.segment)) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	return chunks;
}

// ---------------------------------------------------------------------------
// Selection highlight renderer
//
// Inserts ANSI reverse-video (SGR 7 / SGR 27) around the visible column range
// [startCol, endCol) in an already-rendered line (which may contain ANSI codes
// and the CURSOR_MARKER).  Re-applies the highlight after any SGR reset so
// that the cursor's own \x1b[7m…\x1b[0m doesn't prematurely close it.
// ---------------------------------------------------------------------------

function applyHighlight(line: string, startCol: number, endCol: number): string {
	if (startCol >= endCol) return line;

	const chars = [...line]; // iterate by Unicode code-point
	let result = "";
	let visCol = 0;
	let inHL = false;
	let i = 0;

	const startHL = (): void => { result += "\x1b[7m"; inHL = true; };
	const endHL   = (): void => { result += "\x1b[27m"; inHL = false; };

	while (i < chars.length) {
		// Toggle highlight at column boundaries
		if (!inHL && visCol >= startCol && visCol < endCol) startHL();
		if (inHL  && visCol >= endCol)                      endHL();

		// ── ANSI escape sequence ──────────────────────────────────────────
		if (chars[i] === "\x1b") {
			let seq = chars[i]!;
			i++;

			if (i < chars.length && chars[i] === "[") {
				// CSI sequence  (e.g. \x1b[0m, \x1b[7m, \x1b[C …)
				seq += chars[i]!; i++;
				while (i < chars.length && !/[A-Za-z]/.test(chars[i]!)) { seq += chars[i]!; i++; }
				if (i < chars.length) { seq += chars[i]!; i++; }

				// After a full SGR reset, re-open the highlight if we're still in range
				if (seq === "\x1b[0m" && inHL) {
					result += seq + "\x1b[7m"; // reset → keep highlight
				} else {
					result += seq;
				}
			} else if (i < chars.length && chars[i] === "_") {
				// APC sequence – used for CURSOR_MARKER (\x1b_pi:c\x07)
				seq += chars[i]!; i++;
				while (i < chars.length && chars[i] !== "\x07") { seq += chars[i]!; i++; }
				if (i < chars.length) { seq += chars[i]!; i++; }
				result += seq;
			} else {
				result += seq;
			}
			continue;
		}

		// ── Visible character ─────────────────────────────────────────────
		const ch = chars[i]!;
		result += ch;
		visCol += visibleWidth(ch);
		i++;
	}

	if (inHL) endHL();
	return result;
}

// ---------------------------------------------------------------------------
// Delete / yank motion tables (used by normal-mode operators)
// ---------------------------------------------------------------------------

const DELETE_MOTION: Record<string, string[]> = {
	d: ["\x01", "\x0b"],  // dd / cc — line start then delete to end
	c: ["\x01", "\x0b"],  // alias
	w: ["\x1bd"],         // alt+d: delete word forward
	e: ["\x1bd"],         // same
	b: ["\x1b\x7f"],      // alt+backspace: delete word backward
	$: ["\x0b"],          // ctrl+k: delete to line end
	"0": ["\x15"],        // ctrl+u: delete to line start
	"^": ["\x15"],        // same
	h: ["\x7f"],          // backspace: delete char backward
	l: ["\x1b[3~"],       // delete char forward
};

// Yank = phantom delete (loads kill ring) + immediate paste back (restores text)
const YANK_MOTION: Record<string, string[]> = Object.fromEntries(
	Object.entries(DELETE_MOTION).map(([k, seqs]) => [k, [...seqs, "\x19"]])
);

const SHIFT_WIDTH = 4;
const SHIFT_TEXT = " ".repeat(SHIFT_WIDTH);

// ---------------------------------------------------------------------------
// System clipboard helpers
// ---------------------------------------------------------------------------

function readFromClipboard(): string {
	try {
		const p = platform();
		if (p === "darwin") {
			return execSync("pbpaste", { timeout: 5000 }).toString();
		} else if (p === "win32") {
			return execSync("powershell.exe -command Get-Clipboard", { timeout: 5000 }).toString();
		} else {
			try {
				return execSync("wl-paste --no-newline", { timeout: 5000 }).toString();
			} catch {
				try {
					return execSync("xclip -selection clipboard -o", { timeout: 5000 }).toString();
				} catch {
					return execSync("xsel --clipboard --output", { timeout: 5000 }).toString();
				}
			}
		}
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// ModalEditor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cursor shape helpers (DECSCUSR — works in all modern terminals)
// ---------------------------------------------------------------------------

/** The DECSCUSR sequence that was active before this extension took over. */
let originalCursorShape: string | null = null;

function setCursorShape(shape: "block" | "line"): void {
	// 2 = steady block, 6 = steady bar (line)
	process.stdout.write(shape === "block" ? "\x1b[2 q" : "\x1b[6 q");
}

function restoreOriginalCursorShape(): void {
	if (originalCursorShape !== null) {
		process.stdout.write(originalCursorShape);
		originalCursorShape = null;
	}
}

/**
 * Query the terminal for its current cursor shape via DECRQSS and store it,
 * so we can restore it exactly on exit.  Falls back to the standard
 * "reset to terminal default" sequence (\x1b[0 q) if the terminal does not
 * respond within 150 ms.
 */
function captureAndSetCursorShape(initialShape: "block" | "line"): void {
	const FALLBACK = "\x1b[0 q"; // restore terminal's own default
	let resolved = false;

	const finish = (restoreSeq: string): void => {
		if (resolved) return;
		resolved = true;
		process.stdin.off("data", onData);
		clearTimeout(timer);
		originalCursorShape = restoreSeq;
		setCursorShape(initialShape);
	};

	const onData = (chunk: Buffer | string): void => {
		const reply = typeof chunk === "string" ? chunk : chunk.toString("binary");
		// DECRQSS response: \x1bP1$r<value>\x1b\\ where <value> is e.g. "2 q"
		const match = reply.match(/\x1bP[01]\$r(\d* q)\x1b\\/);
		if (match) finish(`\x1b[${match[1]}`);
		// Ignore unrelated stdin data — timer handles non-responding terminals.
	};

	const timer = setTimeout(() => finish(FALLBACK), 150);
	process.stdin.on("data", onData);
	// Send the DECRQSS request for the cursor style parameter ("SP q")
	process.stdout.write("\x1bP$q q\x1b\\");
}

class ModalEditor extends CustomEditor {
	private mode: "normal" | "insert" | "visual" | "visual-line" = "insert";

	/** Layout width used for auto hard-wrapping (updated on each render). */
	private autoWrapWidth = 0;

	// Normal-mode operator state
	private pendingOp: string | null = null;
	/** Set when a char-motion (f/t/F/T) is pending its target character. */
	private pendingMotion: string | null = null;
	/** Set when a text-object prefix (i/a) is pending its object character (w/W). */
	private pendingTextObject: string | null = null;
	/** Set when `g` has been pressed, waiting for the second key (e.g. `g` for `gg`). */
	private pendingG: boolean = false;
	/** Set when `r` has been pressed, waiting for the replacement character. */
	private pendingReplace: boolean = false;

	// Clipboard yank tracking — used to distinguish line-wise vs char-wise paste
	private lastYankText: string | null = null;
	private lastYankLinewise: boolean = false;

	// Normal-mode K handler (wired to pager:open event by the extension entry point)
	onNormalK?: () => void;

	// Visual-mode state
	private visualAnchor: { line: number; col: number } | null = null;

	// ── cursor-shape helpers ─────────────────────────────────────────────────

	private enterInsertMode(): void {
		this.mode = "insert";
		setCursorShape("line");
	}

	private enterNormalMode(): void {
		this.mode = "normal";
		setCursorShape("block");
	}

	// ── auto hard-wrap ──────────────────────────────────────────────────────

	/**
	 * If the current logical line exceeds the layout width, insert a real
	 * newline at the nearest word boundary so each display line becomes its
	 * own logical line.  Called after every insert-mode input.
	 *
	 * Recurses so that a single paste that produces a very long line is
	 * broken into as many lines as needed.
	 */
	private autoWrap(): void {
		if (this.autoWrapWidth <= 0) return;

		const cursor = this.getCursor();
		const lines  = this.getLines();
		const line   = lines[cursor.line] ?? "";

		if (visibleWidth(line) <= this.autoWrapWidth) return;

		const chunks = computeWordWrap(line, this.autoWrapWidth);
		if (chunks.length <= 1) return;

		const breakCol = chunks[0]!.endIndex;   // index of first char of next word
		if (breakCol <= 0 || breakCol >= line.length) return;

		const savedCol = cursor.col;

		// ── navigate cursor to breakCol ──────────────────────────────────────
		if (savedCol > breakCol) {
			for (let i = 0; i < savedCol - breakCol; i++) super.handleInput("\x1b[D");
		} else if (savedCol < breakCol) {
			for (let i = 0; i < breakCol - savedCol; i++) super.handleInput("\x1b[C");
		}

		// ── delete trailing whitespace immediately before breakCol ───────────
		let spacesRemoved = 0;
		for (let i = breakCol - 1; i >= 0 && /\s/.test(line[i]!); i--) {
			super.handleInput("\x7f");   // backspace
			spacesRemoved++;
		}

		// ── insert real newline ──────────────────────────────────────────────
		super.handleInput("\n");
		// cursor is now at col 0 of the new (second) line

		// ── restore cursor position ──────────────────────────────────────────
		if (savedCol >= breakCol) {
			// cursor was on or after the break → stays on the new line
			const targetCol = savedCol - breakCol;
			for (let i = 0; i < targetCol; i++) super.handleInput("\x1b[C");
		} else {
			// cursor was before the break → move back to original line
			super.handleInput("\x1b[A");   // up
			super.handleInput("\x01");     // start of line
			for (let i = 0; i < savedCol; i++) super.handleInput("\x1b[C");
		}

		// ── forward reflow: merge overflow line with the next line ───────────
		// After the split, the overflow text sits on a short new line.  If a
		// next line exists, join them so the recursive autoWrap() can re-split
		// at the correct word boundary, preventing orphaned short lines.
		const updatedCursor = this.getCursor();
		const updatedLines  = this.getLines();
		const overflowLine  = cursor.line + 1; // line index of the overflow text

		if (overflowLine + 1 < updatedLines.length) {
			// Save cursor position, navigate to end of overflow line, delete
			// the newline to merge with the following line, then restore cursor.
			const savedLine2 = updatedCursor.line;
			const savedCol2  = updatedCursor.col;

			// Go to end of overflow line
			super.handleInput("\x01"); // start of current line
			if (savedLine2 < overflowLine) {
				for (let i = 0; i < overflowLine - savedLine2; i++) super.handleInput("\x1b[B");
			} else if (savedLine2 > overflowLine) {
				for (let i = 0; i < savedLine2 - overflowLine; i++) super.handleInput("\x1b[A");
			}
			super.handleInput("\x05"); // end of line (ctrl+e)

			// Delete the newline between overflow line and next line
			super.handleInput("\x1b[3~"); // forward-delete

			// Insert a space to separate the merged text (unless overflow line
			// already ends with whitespace or the next line starts with it)
			const overflowText = updatedLines[overflowLine] ?? "";
			const nextLineText = updatedLines[overflowLine + 1] ?? "";
			if (overflowText.length > 0 && nextLineText.length > 0
				&& !/\s$/.test(overflowText) && !/^\s/.test(nextLineText)) {
				super.handleInput(" ");
			}

			// Restore cursor position
			// After the merge, lines shifted: if cursor was below overflow,
			// its line index decreased by 1.
			const restoredLine = savedLine2 > overflowLine ? savedLine2 - 1 : savedLine2;
			const currentLine  = overflowLine; // cursor is on overflow line after the merge
			super.handleInput("\x01"); // start of line
			if (currentLine > restoredLine) {
				for (let i = 0; i < currentLine - restoredLine; i++) super.handleInput("\x1b[A");
			} else if (currentLine < restoredLine) {
				for (let i = 0; i < restoredLine - currentLine; i++) super.handleInput("\x1b[B");
			}
			// Restore column
			for (let i = 0; i < savedCol2; i++) super.handleInput("\x1b[C");
		}

		// the new (second) line may itself be too long — wrap again
		this.autoWrap();
	}

	// ── reflow (gq / Q) ────────────────────────────────────────────────

	/**
	 * Reflow (re-wrap) a range of logical lines to fit within `autoWrapWidth`.
	 *
	 * Paragraphs (runs of non-empty lines) within the range are joined and
	 * re-wrapped independently; empty lines (paragraph separators) are preserved.
	 * After reformatting, the cursor is placed at the beginning of the range.
	 */
	private reflowLines(startLine: number, endLine: number): void {
		if (this.autoWrapWidth <= 0) return;

		const lines  = this.getLines();
		const cursor = this.getCursor();

		startLine = Math.max(0, startLine);
		endLine   = Math.min(lines.length - 1, endLine);
		if (startLine > endLine) return;

		// ── Build new text, reflowing each paragraph independently ────────
		const newLines: string[] = [];
		let i = startLine;
		while (i <= endLine) {
			const line = lines[i] ?? "";
			if (line.trim() === "") {
				newLines.push("");
				i++;
				continue;
			}
			// Collect consecutive non-empty lines (one paragraph)
			const paraLines: string[] = [];
			while (i <= endLine && (lines[i] ?? "").trim() !== "") {
				paraLines.push(lines[i]!);
				i++;
			}
			// Join, collapse whitespace, re-wrap
			const joined = paraLines.join(" ").replace(/\s+/g, " ").trim();
			const chunks = computeWordWrap(joined, this.autoWrapWidth);
			for (const chunk of chunks) newLines.push(chunk.text);
		}

		const newText = newLines.join("\n");

		// ── Navigate to col 0 of startLine ───────────────────────────────
		super.handleInput("\x01"); // start of current line
		if (cursor.line > startLine) {
			for (let n = 0; n < cursor.line - startLine; n++) super.handleInput("\x1b[A");
		} else if (cursor.line < startLine) {
			for (let n = 0; n < startLine - cursor.line; n++) super.handleInput("\x1b[B");
		}

		// ── Delete old text (all chars + newlines in range) ──────────────
		let totalChars = 0;
		for (let n = startLine; n <= endLine; n++) {
			totalChars += (lines[n]?.length ?? 0);
			if (n < endLine) totalChars += 1; // newline between lines
		}
		for (let n = 0; n < totalChars; n++) super.handleInput("\x1b[3~");

		// ── Insert reformatted text ──────────────────────────────────────
		this.insertTextAtCursor(newText);

		// ── Move cursor back to start of the reflowed region ─────────────
		const afterCursor = this.getCursor();
		super.handleInput("\x01"); // start of current line
		for (let n = 0; n < afterCursor.line - startLine; n++) super.handleInput("\x1b[A");
	}

	/**
	 * Move cursor to the first or last logical line.
	 * Moves to column 0 of the target line.
	 */
	private goToLine(target: "first" | "last"): void {
		const cursor = this.getCursor();
		const lines = this.getLines();

		if (target === "first") {
			// Move to col 0 of current line, then up to line 0
			super.handleInput("\x01"); // ctrl+a
			for (let i = 0; i < cursor.line; i++) super.handleInput("\x1b[A");
		} else {
			// Move to col 0 of current line, then down to last line
			super.handleInput("\x01"); // ctrl+a
			const lastLine = lines.length - 1;
			for (let i = 0; i < lastLine - cursor.line; i++) super.handleInput("\x1b[B");
		}
	}

	/**
	 * Execute a line-wise operator (d/c) from the current line to the first or last line.
	 * Temporarily enters visual-line mode, moves to the target, then performs the operation.
	 */
	private executeLinewiseOp(op: string, target: "first" | "last"): void {
		// Set up a temporary visual-line selection from the current line
		this.visualAnchor = this.getCursor();
		this.goToLine(target);
		this.deleteLineSelection();
		if (op === "c") {
			this.enterInsertMode();
		} else {
			this.enterNormalMode();
		}
	}

	/**
	 * Move cursor to a specific logical line/column.
	 *
	 * Uses editor key sequences (col 0 + vertical movement + horizontal movement),
	 * mirroring the approach used in other modal helpers.
	 */
	private moveCursorTo(line: number, col: number): void {
		const lines = this.getLines();
		if (lines.length === 0) return;

		const targetLine = Math.max(0, Math.min(line, lines.length - 1));
		const cursor = this.getCursor();

		super.handleInput("\x01"); // col 0
		if (cursor.line > targetLine) {
			for (let i = 0; i < cursor.line - targetLine; i++) super.handleInput("\x1b[A");
		} else if (cursor.line < targetLine) {
			for (let i = 0; i < targetLine - cursor.line; i++) super.handleInput("\x1b[B");
		}

		const targetCol = Math.max(0, Math.min(col, (this.getLines()[targetLine] ?? "").length));
		for (let i = 0; i < targetCol; i++) super.handleInput("\x1b[C");
	}

	/**
	 * Compute how many leading characters to remove for one left shift.
	 *
	 * Rules:
	 * - leading tab: remove one tab
	 * - leading spaces: remove up to SHIFT_WIDTH spaces
	 * - mixed leading whitespace: consume up to one shift unit, where a tab
	 *   consumes the remaining width immediately
	 */
	private computeLeftShiftRemoval(line: string): number {
		let removeChars = 0;
		let consumed = 0;

		while (removeChars < line.length && consumed < SHIFT_WIDTH) {
			const ch = line[removeChars]!;
			if (ch === " ") {
				removeChars++;
				consumed++;
				continue;
			}
			if (ch === "\t") {
				removeChars++;
				consumed = SHIFT_WIDTH;
				break;
			}
			break;
		}

		return removeChars;
	}

	/**
	 * Shift selected lines in visual/visual-line mode.
	 *
	 * Like vim visual shift, this is line-wise even for character-wise visual mode.
	 * After shifting, the editor returns to normal mode.
	 */
	private shiftVisualSelection(direction: "left" | "right"): void {
		if (!this.visualAnchor) return;

		const cursor = this.getCursor();
		const anchor = this.visualAnchor;
		const startLine = Math.min(anchor.line, cursor.line);
		const endLine = Math.max(anchor.line, cursor.line);

		let targetLine = cursor.line;
		let targetCol = cursor.col;

		this.moveCursorTo(startLine, 0);

		for (let line = startLine; line <= endLine; line++) {
			if (direction === "right") {
				for (const ch of SHIFT_TEXT) super.handleInput(ch);
				if (line === targetLine) targetCol += SHIFT_WIDTH;
			} else {
				const removeCount = this.computeLeftShiftRemoval(this.getLines()[line] ?? "");
				for (let i = 0; i < removeCount; i++) super.handleInput("\x1b[3~");
				if (line === targetLine) targetCol = Math.max(0, targetCol - removeCount);
			}

			if (line < endLine) {
				super.handleInput("\x01");   // col 0
				super.handleInput("\x1b[B"); // down
				super.handleInput("\x01");   // col 0 again
			}
		}

		targetCol = Math.min(targetCol, (this.getLines()[targetLine] ?? "").length);

		this.enterNormalMode();
		this.visualAnchor = null;
		this.moveCursorTo(targetLine, targetCol);
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	/**
	 * Return the currently selected text (single-line selection only).
	 * Multi-line selections return an empty string.
	 */
	private getSelectedText(): string {
		if (!this.visualAnchor) return "";
		const cursor = this.getCursor();
		const anchor = this.visualAnchor;
		if (cursor.line !== anchor.line) return "";
		const line = this.getLines()[cursor.line] ?? "";
		const s = Math.min(cursor.col, anchor.col);
		const e = Math.max(cursor.col, anchor.col);
		return line.slice(s, e + 1); // inclusive on both ends (vim behaviour)
	}

	/**
	 * Delete the visual selection and clear visualAnchor.
	 * Supports both single-line and multi-line selections.
	 * After deletion the editor is in normal mode (caller switches to insert for `c`).
	 */
	private deleteSelection(): void {
		if (!this.visualAnchor) return;

		const cursor = this.getCursor();
		const anchor = this.visualAnchor;
		this.visualAnchor = null;

		// ── Normalise to (startLine, startCol) … (endLine, endCol) ──────────
		let startLine: number, startCol: number, endLine: number, endCol: number;
		if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
			startLine = anchor.line; startCol = anchor.col;
			endLine   = cursor.line; endCol   = cursor.col;
		} else {
			startLine = cursor.line; startCol = cursor.col;
			endLine   = anchor.line; endCol   = anchor.col;
		}

		// ── Move cursor to (startLine, startCol) ────────────────────────────
		//
		// Current cursor = getCursor() after movements in visual mode = one
		// endpoint of the selection (the one the user moved to).
		//
		// Strategy:
		//   1. Move to col 0 of the current logical line (ctrl+a).
		//   2. Move up to startLine (up arrow = one visual line, but since we
		//      are at col 0 the line is short, so one up-arrow per logical
		//      line is usually correct – good enough for prompt editing).
		//   3. Move right to startCol.
		//
		// This is approximate when word-wrapping is active on the lines above,
		// but that is an uncommon case in a coding-agent prompt editor.

		// Step 1: move to col 0 of current logical line
		super.handleInput("\x01"); // ctrl+a

		// Step 2: move up from cursor.line to startLine
		for (let i = 0; i < cursor.line - startLine; i++) super.handleInput("\x1b[A");

		// Step 3: move right to startCol
		for (let i = 0; i < startCol; i++) super.handleInput("\x1b[C");

		// ── Compute total characters to delete ───────────────────────────────
		const lines = this.getLines();
		let totalChars: number;
		if (startLine === endLine) {
			totalChars = endCol - startCol + 1;
		} else {
			// rest of start line
			totalChars  = (lines[startLine]?.length ?? 0) - startCol;
			totalChars += 1; // the \n after startLine
			// full middle lines
			for (let i = startLine + 1; i < endLine; i++) {
				totalChars += (lines[i]?.length ?? 0) + 1;
			}
			// beginning of end line up to endCol, inclusive
			totalChars += endCol + 1;
		}

		// ── Delete forward ────────────────────────────────────────────────────
		for (let i = 0; i < totalChars; i++) super.handleInput("\x1b[3~");
	}

	/**
	 * Delete the visual-line selection (entire lines from anchor to cursor).
	 * Clears visualAnchor. After deletion, editor is in normal mode.
	 */
	private deleteLineSelection(): void {
		if (!this.visualAnchor) return;

		const cursor = this.getCursor();
		const anchor = this.visualAnchor;
		this.visualAnchor = null;

		const startLine = Math.min(anchor.line, cursor.line);
		const endLine = Math.max(anchor.line, cursor.line);
		const lines = this.getLines();

		// Move cursor to the beginning of startLine
		// First go to col 0 of current line
		super.handleInput("\x01"); // ctrl+a

		// Move up/down to startLine from cursor.line
		if (cursor.line > startLine) {
			for (let i = 0; i < cursor.line - startLine; i++) super.handleInput("\x1b[A");
		} else if (cursor.line < startLine) {
			for (let i = 0; i < startLine - cursor.line; i++) super.handleInput("\x1b[B");
		}

		// Compute total characters to delete (all chars on lines + newlines between them)
		let totalChars = 0;
		for (let i = startLine; i <= endLine; i++) {
			totalChars += (lines[i]?.length ?? 0);
			if (i < endLine) totalChars += 1; // newline between lines
		}

		// If there's a line after the selection, also delete the newline before it
		// (so we consume the line break that separated these lines from the next)
		if (endLine < lines.length - 1) {
			totalChars += 1; // trailing newline
		} else if (startLine > 0) {
			// If deleting the last line(s), consume the newline before startLine
			super.handleInput("\x1b[D"); // move left into the newline of previous line
			totalChars += 1; // leading newline
		}

		// Delete forward
		for (let i = 0; i < totalChars; i++) super.handleInput("\x1b[3~");
	}

	/**
	 * Swap the cursor and the visual anchor (vim `o` / `O` in visual mode).
	 * After the swap the user can extend the selection from the opposite end.
	 */
	private swapVisualEndpoint(): void {
		if (!this.visualAnchor) return;

		const cursor = this.getCursor();
		const anchor = this.visualAnchor;

		// Nothing to do if cursor and anchor are identical
		if (cursor.line === anchor.line && cursor.col === anchor.col) return;

		// Navigate the cursor to the anchor position.
		// Strategy (same as deleteSelection): go to col 0 of current line,
		// move vertically, then right to the target column.

		// Step 1: col 0 of current logical line
		super.handleInput("\x01"); // ctrl+a

		// Step 2: move vertically to anchor.line
		if (cursor.line > anchor.line) {
			for (let i = 0; i < cursor.line - anchor.line; i++) super.handleInput("\x1b[A");
		} else if (cursor.line < anchor.line) {
			for (let i = 0; i < anchor.line - cursor.line; i++) super.handleInput("\x1b[B");
		}

		// Step 3: move right to anchor.col
		for (let i = 0; i < anchor.col; i++) super.handleInput("\x1b[C");

		// Swap: old cursor becomes new anchor
		this.visualAnchor = cursor;
	}

	// ── Clipboard yank / paste helpers ───────────────────────────────────────

	/**
	 * Copy text to the system clipboard and remember whether the yank was
	 * line-wise so that `p`/`P` can decide how to paste.
	 */
	private yankToClipboard(text: string, linewise: boolean): void {
		this.lastYankText = text;
		this.lastYankLinewise = linewise;
		copyToClipboard(text);
	}

	/**
	 * Compute the text that a normal-mode yank motion would select, purely
	 * from cursor position + buffer contents (no editor state mutation).
	 */
	private computeYankText(motionKey: string): { text: string; linewise: boolean } | null {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] ?? "";

		switch (motionKey) {
			case "d": // yy — whole line
				return { text: line + "\n", linewise: true };
			case "$":
				return cursor.col < line.length
					? { text: line.slice(cursor.col), linewise: false }
					: null;
			case "0":
			case "^":
				return cursor.col > 0
					? { text: line.slice(0, cursor.col), linewise: false }
					: null;
			case "h":
				return cursor.col > 0
					? { text: line[cursor.col - 1]!, linewise: false }
					: null;
			case "l":
				return cursor.col < line.length
					? { text: line[cursor.col]!, linewise: false }
					: null;
			case "w": {
				let end = cursor.col;
				if (end >= line.length) return null;
				const ch = line[end]!;
				if (/[a-zA-Z0-9_]/.test(ch)) {
					while (end < line.length && /[a-zA-Z0-9_]/.test(line[end]!)) end++;
				} else if (!/\s/.test(ch)) {
					while (end < line.length && !/\s/.test(line[end]!) && !/[a-zA-Z0-9_]/.test(line[end]!)) end++;
				}
				// include trailing whitespace (vim `yw` behaviour)
				while (end < line.length && /\s/.test(line[end]!)) end++;
				return end > cursor.col ? { text: line.slice(cursor.col, end), linewise: false } : null;
			}
			case "e": {
				if (cursor.col >= line.length) return null;
				let end = cursor.col + 1;
				while (end < line.length && /\s/.test(line[end]!)) end++;
				if (end < line.length) {
					const ch = line[end]!;
					if (/[a-zA-Z0-9_]/.test(ch)) {
						while (end < line.length && /[a-zA-Z0-9_]/.test(line[end]!)) end++;
					} else {
						while (end < line.length && !/\s/.test(line[end]!) && !/[a-zA-Z0-9_]/.test(line[end]!)) end++;
					}
				}
				return end > cursor.col ? { text: line.slice(cursor.col, end), linewise: false } : null;
			}
			case "b": {
				let start = cursor.col;
				if (start <= 0) return null;
				start--;
				while (start > 0 && /\s/.test(line[start]!)) start--;
				const ch = line[start]!;
				if (/[a-zA-Z0-9_]/.test(ch)) {
					while (start > 0 && /[a-zA-Z0-9_]/.test(line[start - 1]!)) start--;
				} else if (!/\s/.test(ch)) {
					while (start > 0 && !/\s/.test(line[start - 1]!) && !/[a-zA-Z0-9_]/.test(line[start - 1]!)) start--;
				}
				return { text: line.slice(start, cursor.col), linewise: false };
			}
			default:
				return null;
		}
	}

	/**
	 * Compute the text that a char-motion yank (yf/yt/yF/yT) would select.
	 */
	private computeCharMotionYankText(motion: string, char: string): { text: string; linewise: boolean } | null {
		const line = (this.getLines()[this.getCursor().line]) ?? "";
		const col = this.getCursor().col;

		if (motion === "f") {
			const idx = line.indexOf(char, col + 1);
			if (idx === -1) return null;
			return { text: line.slice(col, idx + 1), linewise: false };
		} else if (motion === "t") {
			const idx = line.indexOf(char, col + 1);
			if (idx === -1 || idx === col + 1) return null;
			return { text: line.slice(col, idx), linewise: false };
		} else if (motion === "F") {
			const idx = line.lastIndexOf(char, col - 1);
			if (idx === -1) return null;
			return { text: line.slice(idx, col + 1), linewise: false };
		} else { // "T"
			const idx = line.lastIndexOf(char, col - 1);
			if (idx === -1 || idx === col - 1) return null;
			return { text: line.slice(idx + 1, col + 1), linewise: false };
		}
	}

	/**
	 * Compute the text that a text-object yank (yiw/yiW/yaw/yaW) would select.
	 */
	private computeTextObjectYankText(prefix: string, obj: string): { text: string; linewise: boolean } | null {
		if (obj !== "w" && obj !== "W") return null;

		const line = (this.getLines()[this.getCursor().line]) ?? "";
		const col = this.getCursor().col;
		const curChar = line[col] ?? "";

		let charClass: (c: string) => boolean;
		if (obj === "W") {
			charClass = /\s/.test(curChar) ? (c) => /\s/.test(c) : (c) => !/\s/.test(c);
		} else {
			if (/\s/.test(curChar)) charClass = (c) => /\s/.test(c);
			else if (/[a-zA-Z0-9_]/.test(curChar)) charClass = (c) => /[a-zA-Z0-9_]/.test(c);
			else charClass = (c) => !/\s/.test(c) && !/[a-zA-Z0-9_]/.test(c);
		}

		let start = col;
		while (start > 0 && charClass(line[start - 1]!)) start--;
		let end = col;
		while (end < line.length - 1 && charClass(line[end + 1]!)) end++;

		if (prefix === "a") {
			if (end + 1 < line.length && /\s/.test(line[end + 1]!)) {
				while (end + 1 < line.length && /\s/.test(line[end + 1]!)) end++;
			} else if (start > 0 && /\s/.test(line[start - 1]!)) {
				while (start > 0 && /\s/.test(line[start - 1]!)) start--;
			}
		}

		return { text: line.slice(start, end + 1), linewise: false };
	}

	/**
	 * Compute text for a line-wise yank to the first or last line (ygg / yG).
	 */
	private computeLinewiseYankText(target: "first" | "last"): { text: string; linewise: boolean } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const selected = target === "first"
			? lines.slice(0, cursor.line + 1)
			: lines.slice(cursor.line);
		return { text: selected.join("\n") + "\n", linewise: true };
	}

	/**
	 * Get the text of the current visual (or visual-line) selection.
	 */
	private getVisualSelectionText(): { text: string; linewise: boolean } {
		if (!this.visualAnchor) return { text: "", linewise: false };

		const cursor = this.getCursor();
		const anchor = this.visualAnchor;
		const lines = this.getLines();

		if (this.mode === "visual-line") {
			const startLine = Math.min(anchor.line, cursor.line);
			const endLine = Math.max(anchor.line, cursor.line);
			return { text: lines.slice(startLine, endLine + 1).join("\n") + "\n", linewise: true };
		}

		// Character-wise visual mode
		let startLine: number, startCol: number, endLine: number, endCol: number;
		if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
			startLine = anchor.line; startCol = anchor.col;
			endLine   = cursor.line; endCol   = cursor.col;
		} else {
			startLine = cursor.line; startCol = cursor.col;
			endLine   = anchor.line; endCol   = anchor.col;
		}

		if (startLine === endLine) {
			return { text: (lines[startLine] ?? "").slice(startCol, endCol + 1), linewise: false };
		}

		let text = (lines[startLine] ?? "").slice(startCol);
		for (let i = startLine + 1; i < endLine; i++) text += "\n" + (lines[i] ?? "");
		text += "\n" + (lines[endLine] ?? "").slice(0, endCol + 1);
		return { text, linewise: false };
	}

	/**
	 * Paste text from the system clipboard.
	 *
	 * If the clipboard contents match the last yank AND that yank was line-wise,
	 * paste as a new line below (`p`) or above (`P`).  Otherwise paste inline.
	 *
	 * Cmd+V (bracketed paste) is unaffected — it is handled by the underlying
	 * editor before this code runs.
	 */
	private pasteFromClipboard(after: boolean): void {
		const text = readFromClipboard();
		if (!text) return;

		const isLinewise = this.lastYankLinewise && text === this.lastYankText;

		if (isLinewise) {
			const pasteText = text.endsWith("\n") ? text.slice(0, -1) : text;
			if (after) {
				super.handleInput("\x05"); // ctrl+e  → end of line
				super.handleInput("\n");   // newline → open line below
				this.insertTextAtCursor(pasteText);
			} else {
				super.handleInput("\x01"); // ctrl+a → start of line
				this.insertTextAtCursor(pasteText + "\n");
				// Move cursor back up to the first pasted line
				const n = pasteText.split("\n").length;
				for (let i = 0; i < n; i++) super.handleInput("\x1b[A");
				super.handleInput("\x01"); // start of line
			}
		} else {
			if (after) {
				const cursor = this.getCursor();
				const line = this.getLines()[cursor.line] ?? "";
				if (line.length > 0 && cursor.col < line.length) {
					super.handleInput("\x1b[C"); // move right one char
				}
			}
			this.insertTextAtCursor(text);
		}
	}

	/**
	 * Execute a text-object operation (iw, iW, aw, aW) under an operator.
	 *
	 * @param op     - "d" | "c" (y is not supported — individual char-deletes
	 *                 don't populate the editor's kill ring)
	 * @param prefix - "i" (inner) | "a" (around)
	 * @param char   - "w" (word: [a-zA-Z0-9_]) | "W" (WORD: non-whitespace)
	 */
	private executeTextObject(op: string | null, prefix: string, char: string): void {
		if (op === null) return; // navigation not supported
		if (char !== "w" && char !== "W") return; // only word objects

		if (op === "y") {
			const result = this.computeTextObjectYankText(prefix, char);
			if (result) this.yankToClipboard(result.text, result.linewise);
			return;
		}

		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] ?? "";
		const col = cursor.col;
		const curChar = line[col] ?? "";

		// Determine the character-class predicate for the object at the cursor.
		let charClass: (c: string) => boolean;
		if (char === "W") {
			// WORD: any non-whitespace run (or whitespace run if cursor is on space)
			if (/\s/.test(curChar)) {
				charClass = (c) => /\s/.test(c);
			} else {
				charClass = (c) => !/\s/.test(c);
			}
		} else {
			// word: depends on the character under the cursor
			if (/\s/.test(curChar)) {
				charClass = (c) => /\s/.test(c);
			} else if (/[a-zA-Z0-9_]/.test(curChar)) {
				charClass = (c) => /[a-zA-Z0-9_]/.test(c);
			} else {
				// punctuation / special characters form their own "word"
				charClass = (c) => !/\s/.test(c) && !/[a-zA-Z0-9_]/.test(c);
			}
		}

		// Extend left to the start of the word.
		let start = col;
		while (start > 0 && charClass(line[start - 1]!)) start--;

		// Extend right to the end of the word.
		let end = col;
		while (end < line.length - 1 && charClass(line[end + 1]!)) end++;

		// "around" (a): also consume adjacent whitespace.
		// Prefer trailing whitespace; fall back to leading.
		if (prefix === "a") {
			if (end + 1 < line.length && /\s/.test(line[end + 1]!)) {
				while (end + 1 < line.length && /\s/.test(line[end + 1]!)) end++;
			} else if (start > 0 && /\s/.test(line[start - 1]!)) {
				while (start > 0 && /\s/.test(line[start - 1]!)) start--;
			}
		}

		// Move cursor left to the start of the selection.
		const moveLeft = col - start;
		for (let i = 0; i < moveLeft; i++) super.handleInput("\x1b[D");

		// Delete the selection forward.
		const deleteCount = end - start + 1;
		for (let i = 0; i < deleteCount; i++) super.handleInput("\x1b[3~");

		if (op === "c") this.enterInsertMode();
	}

	/**
	 * Execute a character-search motion (f/t/F/T), optionally under an operator.
	 *
	 * @param op    - "d" | "c" | null (null = navigation only; y is unsupported)
	 * @param motion - "f" | "t" | "F" | "T"
	 * @param char  - the target character to search for
	 */
	private executeCharMotion(op: string | null, motion: string, char: string): void {
		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] ?? "";

		let distance: number;
		let isForward: boolean;

		if (motion === "f") {
			const idx = line.indexOf(char, cursor.col + 1);
			if (idx === -1) return;
			distance = idx - cursor.col;
			isForward = true;
		} else if (motion === "t") {
			const idx = line.indexOf(char, cursor.col + 1);
			if (idx === -1) return;
			distance = idx - cursor.col - 1;
			isForward = true;
			if (distance <= 0) return;
		} else if (motion === "F") {
			const idx = line.lastIndexOf(char, cursor.col - 1);
			if (idx === -1) return;
			distance = cursor.col - idx;
			isForward = false;
		} else {
			// "T"
			const idx = line.lastIndexOf(char, cursor.col - 1);
			if (idx === -1) return;
			distance = cursor.col - idx - 1;
			isForward = false;
			if (distance <= 0) return;
		}

		if (op === null) {
			const arrow = isForward ? "\x1b[C" : "\x1b[D";
			for (let i = 0; i < distance; i++) super.handleInput(arrow);
		} else if (op === "d" || op === "c") {
			if (isForward) {
				for (let i = 0; i < distance; i++) super.handleInput("\x1b[3~");
			} else {
				for (let i = 0; i < distance; i++) super.handleInput("\x7f");
			}
			if (op === "c") this.enterInsertMode();
		}
		if (op === "y") {
			const result = this.computeCharMotionYankText(motion, char);
			if (result) this.yankToClipboard(result.text, result.linewise);
		}
	}

	// ── input handling ───────────────────────────────────────────────────────

	handleInput(data: string): void {
		// ── Escape ───────────────────────────────────────────────────────────
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.enterNormalMode();
				this.pendingOp = null;
				this.pendingMotion = null;
				this.pendingTextObject = null;
				this.pendingG = false;
				this.pendingReplace = false;
			} else if (this.mode === "visual" || this.mode === "visual-line") {
				this.enterNormalMode();
				this.visualAnchor = null;
				this.pendingMotion = null;
				this.pendingTextObject = null;
				this.pendingG = false;
				this.pendingReplace = false;
			} else {
				// normal mode → pass through (abort agent, etc.)
				this.pendingOp = null;
				this.pendingMotion = null;
				this.pendingTextObject = null;
				this.pendingG = false;
				this.pendingReplace = false;
				super.handleInput(data);
			}
			return;
		}

		// ── Insert mode: pass everything through ─────────────────────────────
		if (this.mode === "insert") {
			super.handleInput(data);
			this.autoWrap();
			return;
		}

		// ── Stage 3: pending char-motion target character ─────────────────────
		// Works for both normal and visual modes (in visual: op is always null)
		if (this.pendingMotion !== null) {
			const motion = this.pendingMotion;
			const op = this.pendingOp;
			this.pendingMotion = null;
			this.pendingOp = null;
			this.executeCharMotion(op, motion, data);
			return;
		}

		// ── Stage 3b: pending replace character (r{c}) ───────────────────────
		if (this.pendingReplace) {
			this.pendingReplace = false;
			// Replace the character under the cursor, stay in normal mode
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				super.handleInput("\x1b[3~"); // delete char forward
				super.handleInput(data);      // insert replacement
				super.handleInput("\x1b[D");  // move back (cursor stays on replaced char)
			}
			return;
		}

		// ── Stage 4: pending text-object character (e.g. "w" after "di") ─────
		if (this.pendingTextObject !== null) {
			const prefix = this.pendingTextObject;
			const op = this.pendingOp;
			this.pendingTextObject = null;
			this.pendingOp = null;
			this.executeTextObject(op, prefix, data);
			return;
		}

		// ── Stage 5: pending `g` — waiting for second key ─────────────────────
		if (this.pendingG) {
			this.pendingG = false;

			// gq — start the reflow operator (or handle gqgg / visual gq)
			if (data === "q") {
				// In visual / visual-line: reflow the selected line range
				if ((this.mode === "visual" || this.mode === "visual-line") && this.visualAnchor) {
					const cur = this.getCursor();
					const anc = this.visualAnchor;
					const sl  = Math.min(anc.line, cur.line);
					const el  = Math.max(anc.line, cur.line);
					this.visualAnchor = null;
					this.enterNormalMode();
					this.reflowLines(sl, el);
					return;
				}

				// gqgg completion (pendingOp is already "gq" from earlier)
				if (this.pendingOp === "gq") {
					// This can't happen (gqg sets pendingG, then "g" not "q"),
					// but guard for safety.
					this.pendingOp = null;
					return;
				}

				// Normal mode: start gq operator — wait for motion
				this.pendingOp = "gq";
				return;
			}

			if (data === "g") {
				// gg (or dgg/cgg/ygg/gqgg): go to first line
				if (this.pendingOp === "gq") {
					// gqgg: reflow from first line to current line
					this.pendingOp = null;
					this.reflowLines(0, this.getCursor().line);
					return;
				}
				if (this.pendingOp) {
					const op = this.pendingOp;
					this.pendingOp = null;
					if (op === "y") {
						const result = this.computeLinewiseYankText("first");
						this.yankToClipboard(result.text, result.linewise);
					} else {
						this.executeLinewiseOp(op, "first");
					}
				} else {
					this.goToLine("first");
				}
				return;
			}
			// Unknown g-sequence: clear pending operator too
			this.pendingOp = null;
			return;
		}

		// ── Visual mode (character-wise) ──────────────────────────────────────
		if (this.mode === "visual") {
			switch (data) {
				// Exit visual mode
				case "v":
					this.enterNormalMode();
					this.visualAnchor = null;
					return;

				// Switch to visual-line mode
				case "V":
					this.mode = "visual-line";
					// Keep the same anchor but ignore col for line selection
					return;

				// Delete selection
				case "d":
				case "x":
					this.deleteSelection();
					this.enterNormalMode();
					return;

				// Change selection (delete + insert)
				case "c":
					this.deleteSelection();
					this.enterInsertMode();
					return;

				// Yank selection to system clipboard
				case "y": {
					const sel = this.getVisualSelectionText();
					if (sel.text) this.yankToClipboard(sel.text, sel.linewise);
					this.enterNormalMode();
					this.visualAnchor = null;
					return;
				}

				// Shift selected lines right / left
				case ">":
					this.shiftVisualSelection("right");
					return;
				case "<":
					this.shiftVisualSelection("left");
					return;

				// Swap cursor ↔ anchor (go to Other end of selection)
				case "o":
				case "O":
					this.swapVisualEndpoint();
					return;

				// Char-motions set pendingMotion (no operator)
				case "f": case "t": case "F": case "T":
					this.pendingMotion = data;
					return;
			}

			// G: jump to last line
			if (data === "G") {
				this.goToLine("last");
				return;
			}
			// g: start gg sequence
			if (data === "g") {
				this.pendingG = true;
				return;
			}

			// Movement keys: same sequences as normal mode — move cursor, selection follows
			const visualMoveSeq: Record<string, string> = {
				h: "\x1b[D", l: "\x1b[C",
				j: "\x1b[B", k: "\x1b[A",
				b: "\x1bb",  w: "\x1bf", e: "\x1bf",
				"0": "\x01", "^": "\x01", $: "\x05",
			};
			if (data in visualMoveSeq) {
				super.handleInput(visualMoveSeq[data]!);
				return;
			}

			// Ignore everything else in visual mode
			return;
		}

		// ── Visual-line mode ──────────────────────────────────────────────────
		if (this.mode === "visual-line") {
			switch (data) {
				// Exit visual-line mode
				case "V":
					this.enterNormalMode();
					this.visualAnchor = null;
					return;

				// Switch to character-wise visual mode
				case "v":
					this.mode = "visual";
					// Keep anchor, now col matters again
					return;

				// Delete entire selected lines
				case "d":
				case "x":
					this.deleteLineSelection();
					this.enterNormalMode();
					return;

				// Change entire selected lines (delete + insert)
				case "c":
					this.deleteLineSelection();
					this.enterInsertMode();
					return;

				// Yank selected lines to system clipboard
				case "y": {
					const sel = this.getVisualSelectionText();
					if (sel.text) this.yankToClipboard(sel.text, sel.linewise);
					this.enterNormalMode();
					this.visualAnchor = null;
					return;
				}

				// Shift selected lines right / left
				case ">":
					this.shiftVisualSelection("right");
					return;
				case "<":
					this.shiftVisualSelection("left");
					return;

				// Swap cursor ↔ anchor (go to Other end of selection)
				case "o":
				case "O":
					this.swapVisualEndpoint();
					return;
			}

			// G: jump to last line
			if (data === "G") {
				this.goToLine("last");
				return;
			}
			// g: start gg sequence
			if (data === "g") {
				this.pendingG = true;
				return;
			}

			// Movement keys: only vertical movement matters for line selection,
			// but horizontal is allowed too (cursor moves, selection stays line-based)
			const vlMoveSeq: Record<string, string> = {
				j: "\x1b[B", k: "\x1b[A",
				h: "\x1b[D", l: "\x1b[C",
				"0": "\x01", "^": "\x01", $: "\x05",
				w: "\x1bf",  b: "\x1bb",  e: "\x1bf",
			};
			if (data in vlMoveSeq) {
				super.handleInput(vlMoveSeq[data]!);
				return;
			}

			// Ignore everything else in visual-line mode
			return;
		}

		// ── Normal mode ───────────────────────────────────────────────────────

		// Resolve pending gq operator + motion
		if (this.pendingOp === "gq") {
			// g: start gg sequence under gq operator (gqgg)
			if (data === "g") {
				this.pendingG = true;
				return; // keep pendingOp set
			}

			this.pendingOp = null;
			const gqCursor = this.getCursor();
			const gqLines  = this.getLines();

			if (data === "q") {
				// gqq — reflow current paragraph (consecutive non-empty lines)
				let sl = gqCursor.line;
				let el = gqCursor.line;
				while (sl > 0 && (gqLines[sl - 1]?.trim() ?? "") !== "") sl--;
				while (el < gqLines.length - 1 && (gqLines[el + 1]?.trim() ?? "") !== "") el++;
				this.reflowLines(sl, el);
			} else if (data === "j") {
				this.reflowLines(gqCursor.line, Math.min(gqCursor.line + 1, gqLines.length - 1));
			} else if (data === "k") {
				this.reflowLines(Math.max(gqCursor.line - 1, 0), gqCursor.line);
			} else if (data === "G") {
				this.reflowLines(gqCursor.line, gqLines.length - 1);
			}
			// else: unsupported motion — silently ignore
			return;
		}

		// Resolve pending operator (d / c / y) + motion
		if (this.pendingOp === "d" || this.pendingOp === "c" || this.pendingOp === "y") {
			const op = this.pendingOp;

			// Char-motions need a second character — keep pendingOp and wait
			if (data === "f" || data === "t" || data === "F" || data === "T") {
				this.pendingMotion = data;
				return;
			}

			// Text-object prefix: i (inner) or a (around) — wait for the object char
			if (data === "i" || data === "a") {
				this.pendingTextObject = data;
				return; // keep pendingOp set
			}

			// G: line-wise motion to last line (dG, cG, yG)
			if (data === "G") {
				this.pendingOp = null;
				if (op === "y") {
					const result = this.computeLinewiseYankText("last");
					this.yankToClipboard(result.text, result.linewise);
					return;
				}
				this.executeLinewiseOp(op, "last");
				return;
			}

			// g: start gg sequence under operator (dgg, cgg)
			if (data === "g") {
				this.pendingG = true;
				return; // keep pendingOp set
			}

			this.pendingOp = null;
			// Normalise: dd → "d", cc → "d", yy → "d" (same motion key)
			const motionKey = data === op ? "d" : data;

			if (op === "y") {
				// Yank → compute text and copy to system clipboard (no editor mutation)
				const result = this.computeYankText(motionKey);
				if (result) this.yankToClipboard(result.text, result.linewise);
			} else if (op === "d" && motionKey === "d") {
				// dd — delete entire line including newline (line-wise)
				this.visualAnchor = this.getCursor();
				this.deleteLineSelection();
			} else {
				const seqs = DELETE_MOTION[motionKey];
				if (seqs) {
					for (const s of seqs) super.handleInput(s);
					if (op === "c") this.enterInsertMode();
				}
			}
			return;
		}

		// Enter visual mode
		if (data === "v") {
			this.mode = "visual";
			this.visualAnchor = this.getCursor();
			return;
		}

		// Enter visual-line mode
		if (data === "V") {
			this.mode = "visual-line";
			this.visualAnchor = this.getCursor();
			return;
		}

		// Operators that wait for a motion
		if (data === "d" || data === "c" || data === "y") {
			this.pendingOp = data;
			return;
		}

		// Q: reflow entire buffer
		if (data === "Q") {
			const allLines = this.getLines();
			if (allLines.length > 0) this.reflowLines(0, allLines.length - 1);
			return;
		}

		// G: jump to last line
		if (data === "G") {
			this.goToLine("last");
			return;
		}

		// g: start gg sequence (navigation only)
		if (data === "g") {
			this.pendingG = true;
			return;
		}

		// Open conversation pager (K — vim uses K for "look up")
		// Emits an event so the pager extension handles it if loaded.
		if (data === "K") {
			this.onNormalK?.();
			return;
		}

		// Replace single character (r{c})
		if (data === "r") {
			this.pendingReplace = true;
			return;
		}

		// Standalone char-motions (navigation)
		if (data === "f" || data === "t" || data === "F" || data === "T") {
			this.pendingMotion = data;
			return;
		}

		// Mode-switching commands
		switch (data) {
			case "i": // insert before cursor
				this.enterInsertMode();
				return;
			case "a": // append after cursor
				this.enterInsertMode();
				super.handleInput("\x1b[C");  // move right
				return;
			case "I": // insert at line start
				super.handleInput("\x01");    // ctrl+a: line start
				this.enterInsertMode();
				return;
			case "A": // append at line end
				super.handleInput("\x05");    // ctrl+e: line end
				this.enterInsertMode();
				return;
			case "o": // open line below
				super.handleInput("\x05");    // ctrl+e: line end
				super.handleInput("\n");      // newline: creates new line below
				this.enterInsertMode();
				return;
			case "O": // open line above
				super.handleInput("\x01");    // ctrl+a: line start
				super.handleInput("\n");      // newline: splits, cursor moves to next line
				super.handleInput("\x1b[A");  // up: back to the new empty line
				this.enterInsertMode();
				return;
			case "C": // change to line end
				super.handleInput("\x0b");    // ctrl+k: delete to line end
				this.enterInsertMode();
				return;
			case "s": // substitute char
				super.handleInput("\x1b[3~"); // delete char forward
				this.enterInsertMode();
				return;
			case "Y": { // yank whole line to system clipboard
				const result = this.computeYankText("d");
				if (result) this.yankToClipboard(result.text, result.linewise);
				return;
			}
		}

		// Paste from system clipboard
		if (data === "p") { this.pasteFromClipboard(true);  return; }
		if (data === "P") { this.pasteFromClipboard(false); return; }

		// Simple motion / edit mappings
		const seq: Record<string, string> = {
			// Horizontal navigation
			h:   "\x1b[D",   // left
			l:   "\x1b[C",   // right
			b:   "\x1bb",    // word left  (alt+b)
			w:   "\x1bf",    // word right (alt+f)
			e:   "\x1bf",    // word end   (alt+f)
			"0": "\x01",     // line start (ctrl+a)
			"^": "\x01",     // first non-blank (ctrl+a)
			$:   "\x05",     // line end   (ctrl+e)
			// Vertical navigation
			j:   "\x1b[B",   // down
			k:   "\x1b[A",   // up
			// Editing
			x:   "\x1b[3~",  // delete char forward
			X:   "\x7f",     // delete char backward (backspace)
			D:   "\x0b",     // delete to line end   (ctrl+k)
			u:   "\x1f",     // undo                 (ctrl+-)
		};

		if (data in seq) {
			super.handleInput(seq[data]!);
			return;
		}

		// Pass control sequences through, silently drop printable chars
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	// ── rendering ────────────────────────────────────────────────────────────

	render(width: number): string[] {
		// Update auto-wrap width (must match the base Editor's layout width)
		const paddingX = this.getPaddingX();
		const contentWidth = Math.max(1, width - paddingX * 2);
		this.autoWrapWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		const rendered = super.render(width);

		// In INSERT mode, strip the fake block cursor (\x1b[7m...\x1b[0m) that
		// the editor always renders. The hardware cursor (a line/bar via DECSCUSR)
		// will show at the CURSOR_MARKER position instead, giving a visual line
		// cursor. In NORMAL/VISUAL mode we keep the fake block as-is.
		if (this.mode === "insert") {
			for (let i = 0; i < rendered.length; i++) {
				const line = rendered[i]!;
				if (line.includes("\x1b[7m")) {
					// Replace the fake cursor (reverse-video char + reset) with just the char.
					// Pattern: CURSOR_MARKER? + \x1b[7m + <char(s)> + \x1b[0m
					rendered[i] = line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/, "$1");
				}
			}
		}

		// ── Visual selection highlight ────────────────────────────────────────
		if ((this.mode === "visual" || this.mode === "visual-line") && this.visualAnchor) {
			const cursor = this.getCursor();
			const anchor = this.visualAnchor;

			// Normalise selection endpoints
			let startLine: number, startCol: number, endLine: number, endCol: number;
			if (this.mode === "visual-line") {
				// Line-wise: always select full lines
				startLine = Math.min(anchor.line, cursor.line);
				startCol = 0;
				endLine = Math.max(anchor.line, cursor.line);
				const logLines = this.getLines();
				endCol = (logLines[endLine]?.length ?? 1) - 1;
				if (endCol < 0) endCol = 0;
			} else if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
				startLine = anchor.line; startCol = anchor.col;
				endLine   = cursor.line; endCol   = cursor.col;
			} else {
				startLine = cursor.line; startCol = cursor.col;
				endLine   = anchor.line; endCol   = anchor.col;
			}

			// layoutWidth used by the editor when paddingX=0 (default for this extension)
			const layoutWidth = Math.max(1, width - 1);
			const logicalLines = this.getLines();

			// Walk through logical lines, compute the visual-line offset so we can
			// locate the correct rendered content line (rendered[0] = top border).
			let visualLineOffset = 0;

			outer: for (let li = 0; li < logicalLines.length; li++) {
				const logLine = logicalLines[li] ?? "";
				const chunks = computeWordWrap(logLine, layoutWidth);

				for (const chunk of chunks) {
					const renderedIdx = 1 + visualLineOffset; // +1 for top border
					if (renderedIdx >= rendered.length - 1) break outer; // past bottom border

					if (li >= startLine && li <= endLine) {
						// Is the entire chunk outside the selection?
						const chunkBeforeStart = li === startLine && chunk.endIndex <= startCol;
						const chunkAfterEnd    = li === endLine   && chunk.startIndex > endCol;

						if (!chunkBeforeStart && !chunkAfterEnd) {
							// Compute which visible columns within this rendered chunk to highlight.
							// A chunk's first visible column corresponds to logical col chunk.startIndex,
							// so the visible offset within the chunk = logicalCol - chunk.startIndex.
							let hlStart = 0;
							let hlEnd   = visibleWidth(chunk.text); // exclusive

							if (li === startLine && startCol > chunk.startIndex) {
								hlStart = visibleWidth(logLine.slice(chunk.startIndex, startCol));
							}
							if (li === endLine && endCol < chunk.endIndex - 1) {
								hlEnd = visibleWidth(logLine.slice(chunk.startIndex, endCol + 1));
							}

							if (hlStart < hlEnd) {
								rendered[renderedIdx] = applyHighlight(rendered[renderedIdx]!, hlStart, hlEnd);
							}
						}
					}

					visualLineOffset++;
				}

				// No need to process lines after the selection ends
				if (li >= endLine) break;
			}
		}

		// ── Status label ─────────────────────────────────────────────────────
		if (rendered.length === 0) return rendered;

		let label: string;
		if (this.mode === "insert") {
			label = " INSERT ";
		} else if (this.mode === "visual-line") {
			label = " V-LINE ";
		} else if (this.mode === "visual") {
			label = " VISUAL ";
		} else if (this.pendingOp && this.pendingG) {
			label = ` NORMAL [${this.pendingOp}g] `;
		} else if (this.pendingOp && this.pendingMotion) {
			label = ` NORMAL [${this.pendingOp}${this.pendingMotion}] `;
		} else if (this.pendingOp && this.pendingTextObject) {
			label = ` NORMAL [${this.pendingOp}${this.pendingTextObject}] `;
		} else if (this.pendingOp) {
			label = ` NORMAL [${this.pendingOp}] `;
		} else if (this.pendingG) {
			label = ` NORMAL [g] `;
		} else if (this.pendingReplace) {
			label = ` NORMAL [r] `;
		} else if (this.pendingMotion) {
			label = ` NORMAL [${this.pendingMotion}] `;
		} else {
			label = " NORMAL ";
		}

		const last = rendered.length - 1;
		if (visibleWidth(rendered[last]!) >= label.length) {
			rendered[last] = truncateToWidth(rendered[last]!, width - label.length, "") + label;
		}

		return rendered;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new ModalEditor(tui, theme, kb);
			editor.onNormalK = () => pi.events.emit("pager:open");
			return editor;
		});

		// Restore the original cursor shape on clean exit and on signals.
		// Register these once, before the async capture, so they're in place early.
		const cleanup = (): void => restoreOriginalCursorShape();
		process.once("exit", cleanup);
		process.once("SIGINT",  () => { cleanup(); process.exit(130); });
		process.once("SIGTERM", () => { cleanup(); process.exit(143); });

		// Defer the cursor capture + set until after ui.start() has run its full
		// screen clear/redraw, which would otherwise overwrite our escape sequence.
		setImmediate(() => captureAndSetCursorShape("line"));
	});
}
