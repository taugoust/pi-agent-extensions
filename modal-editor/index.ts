/**
 * Modal Editor - vim-like modal editing
 *
 * Normal mode keybindings:
 *   Navigation:  h j k l   w e b   0 ^ $
 *   Insert:      i a I A   C s
 *   Editing:     x X   D   p u
 *   Operators:   d(d|w|e|b|h|l|0|^|$)   c(c|w|e|b|h|l|0|^|$)
 *   Escape:      insert → normal, normal → abort agent
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// Sequences emitted by each delete motion (operator d or c)
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

class ModalEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private pendingOp: string | null = null;

	handleInput(data: string): void {
		// Escape: insert → normal, normal → pass through (abort agent, etc.)
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pendingOp = null;
			} else {
				this.pendingOp = null;
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

		// Resolve pending operator (d / c) + motion
		if (this.pendingOp === "d" || this.pendingOp === "c") {
			const op = this.pendingOp;
			this.pendingOp = null;
			// Normalise: dd → "d", cc → "d" (same motion key)
			const motionKey = data === op ? "d" : data;
			const seqs = DELETE_MOTION[motionKey];
			if (seqs) {
				for (const s of seqs) super.handleInput(s);
				if (op === "c") this.mode = "insert";
			}
			return;
		}

		// Operators that wait for a motion
		if (data === "d" || data === "c") {
			this.pendingOp = data;
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
			p:   "\x19",     // paste / yank         (ctrl+y)
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

		const label = this.mode === "insert"
			? " INSERT "
			: this.pendingOp
				? ` NORMAL [${this.pendingOp}] `
				: " NORMAL ";

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
