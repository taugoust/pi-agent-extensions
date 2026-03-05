/**
 * Modal Editor - vim-like modal editing
 *
 * Normal mode keybindings:
 *   Navigation:  h j k l   w e b   0 ^ $   f{c} t{c} F{c} T{c}
 *   Insert:      i a I A   C s
 *   Editing:     x X   D   p P   u
 *   Operators:   d(d|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c}|iw|iW|aw|aW)
 *                c(c|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c}|iw|iW|aw|aW)
 *                y(y|w|e|b|h|l|0|^|$)   Y
 *   Visual:      v → select with motions → d/c/x/y
 *   Escape:      insert → normal, normal → abort agent
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
	private mode: "normal" | "insert" | "visual" = "insert";

	// Normal-mode operator state
	private pendingOp: string | null = null;
	/** Set when a char-motion (f/t/F/T) is pending its target character. */
	private pendingMotion: string | null = null;
	/** Set when a text-object prefix (i/a) is pending its object character (w/W). */
	private pendingTextObject: string | null = null;

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
	 * Execute a text-object operation (iw, iW, aw, aW) under an operator.
	 *
	 * @param op     - "d" | "c" (y is not supported — individual char-deletes
	 *                 don't populate the editor's kill ring)
	 * @param prefix - "i" (inner) | "a" (around)
	 * @param char   - "w" (word: [a-zA-Z0-9_]) | "W" (WORD: non-whitespace)
	 */
	private executeTextObject(op: string | null, prefix: string, char: string): void {
		if (op === null || op === "y") return; // navigation / yank not supported
		if (char !== "w" && char !== "W") return; // only word objects

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
		// y + char motions: individual char-deletes don't populate the editor's
		// kill ring, so yt/yf/yT/yF are intentionally not supported.
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
			} else if (this.mode === "visual") {
				this.enterNormalMode();
				this.visualAnchor = null;
				this.pendingMotion = null;
				this.pendingTextObject = null;
			} else {
				// normal mode → pass through (abort agent, etc.)
				this.pendingOp = null;
				this.pendingMotion = null;
				this.pendingTextObject = null;
				super.handleInput(data);
			}
			return;
		}

		// ── Insert mode: pass everything through ─────────────────────────────
		if (this.mode === "insert") {
			super.handleInput(data);
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

		// ── Stage 4: pending text-object character (e.g. "w" after "di") ─────
		if (this.pendingTextObject !== null) {
			const prefix = this.pendingTextObject;
			const op = this.pendingOp;
			this.pendingTextObject = null;
			this.pendingOp = null;
			this.executeTextObject(op, prefix, data);
			return;
		}

		// ── Visual mode ───────────────────────────────────────────────────────
		if (this.mode === "visual") {
			switch (data) {
				// Exit visual mode
				case "v":
					this.enterNormalMode();
					this.visualAnchor = null;
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

				// Yank selection — not yet supported.
				// The kill ring is only populated by the editor's own "kill"
				// commands (ctrl+k, alt+d, …) so there is no clean way to push
				// an arbitrary selection into it without direct API access.
				// For now `y` in visual mode simply cancels the selection.
				case "y":
					this.enterNormalMode();
					this.visualAnchor = null;
					return;

				// Char-motions set pendingMotion (no operator)
				case "f": case "t": case "F": case "T":
					this.pendingMotion = data;
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

		// ── Normal mode ───────────────────────────────────────────────────────

		// Resolve pending operator (d / c / y) + motion
		if (this.pendingOp === "d" || this.pendingOp === "c" || this.pendingOp === "y") {
			const op = this.pendingOp;

			// Char-motions need a second character — keep pendingOp and wait
			if (data === "f" || data === "t" || data === "F" || data === "T") {
				// y + char motions are not supported; silently drop
				if (op === "y") { this.pendingOp = null; return; }
				this.pendingMotion = data;
				return;
			}

			// Text-object prefix: i (inner) or a (around) — wait for the object char
			if (data === "i" || data === "a") {
				// y + text objects are not supported; silently drop
				if (op === "y") { this.pendingOp = null; return; }
				this.pendingTextObject = data;
				return; // keep pendingOp set
			}

			this.pendingOp = null;
			// Normalise: dd → "d", cc → "d", yy → "d" (same motion key)
			const motionKey = data === op ? "d" : data;
			const table = op === "y" ? YANK_MOTION : DELETE_MOTION;
			const seqs = table[motionKey];
			if (seqs) {
				for (const s of seqs) super.handleInput(s);
				if (op === "c") this.enterInsertMode();
			}
			return;
		}

		// Enter visual mode
		if (data === "v") {
			this.mode = "visual";
			this.visualAnchor = this.getCursor();
			return;
		}

		// Operators that wait for a motion
		if (data === "d" || data === "c" || data === "y") {
			this.pendingOp = data;
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
			case "C": // change to line end
				super.handleInput("\x0b");    // ctrl+k: delete to line end
				this.enterInsertMode();
				return;
			case "s": // substitute char
				super.handleInput("\x1b[3~"); // delete char forward
				this.enterInsertMode();
				return;
			case "Y": // yank whole line (shortcut for yy)
				for (const s of YANK_MOTION["d"]!) super.handleInput(s);
				return;
		}

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
			p:   "\x19",     // paste after cursor   (ctrl+y)
			P:   "\x19",     // paste before cursor  (ctrl+y — same in line editor)
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
		if (this.mode === "visual" && this.visualAnchor) {
			const cursor = this.getCursor();
			const anchor = this.visualAnchor;

			// Normalise selection endpoints
			let startLine: number, startCol: number, endLine: number, endCol: number;
			if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
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
		} else if (this.mode === "visual") {
			label = " VISUAL ";
		} else if (this.pendingOp && this.pendingMotion) {
			label = ` NORMAL [${this.pendingOp}${this.pendingMotion}] `;
		} else if (this.pendingOp && this.pendingTextObject) {
			label = ` NORMAL [${this.pendingOp}${this.pendingTextObject}] `;
		} else if (this.pendingOp) {
			label = ` NORMAL [${this.pendingOp}] `;
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
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));

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
