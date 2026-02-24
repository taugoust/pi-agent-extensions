/**
 * Modal Editor - vim-like modal editing
 *
 * Normal mode keybindings:
 *   Navigation:  h j k l   w e b   0 ^ $   f{c} t{c} F{c} T{c}
 *   Insert:      i a I A   C s
 *   Editing:     x X   D   p P   u
 *   Operators:   d(d|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c})
 *                c(c|w|e|b|h|l|0|^|$|f{c}|t{c}|F{c}|T{c})
 *                y(y|w|e|b|h|l|0|^|$)   Y
 *   Escape:      insert → normal, normal → abort agent
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Sequences emitted by each delete motion (operators d and c)
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
// After yy/yw/y$/… the kill ring holds the yanked text; p/P paste it.
const YANK_MOTION: Record<string, string[]> = Object.fromEntries(
	Object.entries(DELETE_MOTION).map(([k, seqs]) => [k, [...seqs, "\x19"]])
);

class ModalEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pendingOp: string | null = null;
	/** Set when a char-motion (f/t/F/T) is pending its target character. */
	private pendingMotion: string | null = null;

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
			// Navigation only — move cursor
			const arrow = isForward ? "\x1b[C" : "\x1b[D";
			for (let i = 0; i < distance; i++) super.handleInput(arrow);
		} else if (op === "d" || op === "c") {
			if (isForward) {
				for (let i = 0; i < distance; i++) super.handleInput("\x1b[3~"); // delete forward
			} else {
				for (let i = 0; i < distance; i++) super.handleInput("\x7f"); // backspace
			}
			if (op === "c") this.mode = "insert";
		}
		// y + char motions: individual char-deletes don't populate the kill ring,
		// so yt/yf/yT/yF are intentionally not supported.
	}

	handleInput(data: string): void {
		// Escape: insert → normal, normal → pass through (abort agent, etc.)
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pendingOp = null;
				this.pendingMotion = null;
			} else {
				this.pendingOp = null;
				this.pendingMotion = null;
				super.handleInput(data);
			}
			return;
		}

		// Insert mode: pass everything through unchanged
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// --- Normal mode ---

		// Stage 3: pending char-motion target character
		if (this.pendingMotion !== null) {
			const motion = this.pendingMotion;
			const op = this.pendingOp;
			this.pendingMotion = null;
			this.pendingOp = null;
			this.executeCharMotion(op, motion, data);
			return;
		}

		// Resolve pending operator (d / c / y) + motion
		if (this.pendingOp === "d" || this.pendingOp === "c" || this.pendingOp === "y") {
			const op = this.pendingOp;

			// Char-motions need a second character — keep pendingOp and wait
			if (data === "f" || data === "t" || data === "F" || data === "T") {
				// y + char motions are not supported; silently drop
				if (op === "y") {
					this.pendingOp = null;
					return;
				}
				this.pendingMotion = data;
				return;
			}

			this.pendingOp = null;
			// Normalise: dd → "d", cc → "d", yy → "d" (same motion key)
			const motionKey = data === op ? "d" : data;
			const table = op === "y" ? YANK_MOTION : DELETE_MOTION;
			const seqs = table[motionKey];
			if (seqs) {
				for (const s of seqs) super.handleInput(s);
				if (op === "c") this.mode = "insert";
			}
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
				this.mode = "insert";
				return;
			case "a": // append after cursor
				this.mode = "insert";
				super.handleInput("\x1b[C");  // move right
				return;
			case "I": // insert at line start
				super.handleInput("\x01");    // ctrl+a: line start
				this.mode = "insert";
				return;
			case "A": // append at line end
				super.handleInput("\x05");    // ctrl+e: line end
				this.mode = "insert";
				return;
			case "C": // change to line end
				super.handleInput("\x0b");    // ctrl+k: delete to line end
				this.mode = "insert";
				return;
			case "s": // substitute char
				super.handleInput("\x1b[3~"); // delete char forward
				this.mode = "insert";
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

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		let label: string;
		if (this.mode === "insert") {
			label = " INSERT ";
		} else if (this.pendingOp && this.pendingMotion) {
			label = ` NORMAL [${this.pendingOp}${this.pendingMotion}] `;
		} else if (this.pendingOp) {
			label = ` NORMAL [${this.pendingOp}] `;
		} else if (this.pendingMotion) {
			label = ` NORMAL [${this.pendingMotion}] `;
		} else {
			label = " NORMAL ";
		}

		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
