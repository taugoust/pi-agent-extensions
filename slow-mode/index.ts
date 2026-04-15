/**
 * Slow Mode Extension
 *
 * Intercepts write and edit tool calls, letting the user review proposed
 * changes before they are applied.
 *
 * - Write: stages the new file in /tmp, shows content for review.
 * - Edit: stages old/new files in /tmp, shows inline diff for review.
 * - Ctrl+E opens the new file in $VISUAL/$EDITOR for editing (edit operations).
 * - Ctrl+O opens the diff in an external viewer (nvim/vim/diff).
 * - After editing, the diff is regenerated and shown again for approval.
 * - Esc opens a rejection-reason prompt; type a message to send back to the model, or just press Enter to reject silently.
 * - Toggle with /slow-mode command.
 * - Status bar shows "slow ■" when active.
 *
 * When content is edited:
 * - The actual write/edit operation uses the edited content
 * - A note is appended to the tool result indicating content was modified
 * - The collapsed snippet shows the original LLM proposal (not the edited version)
 *   This is intentional - it shows what the LLM wanted vs. what was actually applied
 *
 * In non-interactive mode (no UI), slow mode is a no-op.
 */

import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, relative, extname, isAbsolute } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function slowMode(pi: ExtensionAPI) {
  // State: whether slow mode is currently enabled
  let enabled = false;

  // Track tool calls where content was edited
  // Maps toolCallId -> { originalContent, editedContent }
  const editedCalls = new Map<string, { original: string; edited: string }>();

  // Staging directory: stores proposed file changes for review
  // Uses mkdtempSync for secure, unpredictable temp directory creation
  // to prevent symlink attacks and tmpdir races
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-slow-mode-"));

  // Clean up staging directory on session shutdown
  pi.on("session_shutdown", async () => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  });

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  // Register /slow-mode command — toggle the interception gate on/off
  pi.registerCommand("slow-mode", {
    description: "Toggle slow mode — review write/edit changes before applying",
    handler: async (_args, ctx) => {
      // No-op in headless mode (no TUI available)
      if (!ctx.hasUI) {
        return;
      }

      // Flip the enabled flag
      enabled = !enabled;
      if (enabled) {
        // Show status bar indicator when active
        ctx.ui.setStatus("slow-mode", ctx.ui.theme.fg("warning", "slow ■"));
        ctx.ui.notify("Slow mode enabled — write/edit changes require approval", "info");
      } else {
        // Clear status bar indicator when disabled
        ctx.ui.setStatus("slow-mode", undefined);
        ctx.ui.notify("Slow mode disabled", "info");
      }
    },
  });

  ////----------------------------------------
  ///     Tool call interception
  //------------------------------------------

  // Hook into tool_call event — fires BEFORE tool execution
  // Returning { block: true, reason } prevents the tool from running
  pi.on("tool_call", async (event, ctx) => {
    // Pass through if slow mode is disabled or no UI available
    if (!enabled || !ctx.hasUI) return;

    // Intercept write tool calls
    if (event.toolName === "write") {
      return await reviewWrite(event.toolCallId, event.input, ctx);
    }

    // Intercept edit tool calls
    if (event.toolName === "edit") {
      return await reviewEdit(event.toolCallId, event.input, ctx);
    }

    // All other tools pass through unchanged
  });

  // Hook into tool_result event — fires AFTER tool execution
  // Add a note when content was edited in slow mode
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    const edited = editedCalls.get(event.toolCallId);
    if (!edited) return;

    // Clean up the tracking entry
    editedCalls.delete(event.toolCallId);

    // Calculate diff stats
    const originalLines = edited.original.split('\n').length;
    const editedLines = edited.edited.split('\n').length;
    const lineDiff = editedLines - originalLines;
    const lineDiffText = lineDiff > 0 
      ? `+${lineDiff} lines` 
      : lineDiff < 0 
      ? `${lineDiff} lines` 
      : 'same line count';

    // Add a note to the result indicating content was edited
    const note = {
      type: "text" as const,
      text: `\n\n**Note:** Content was modified in slow mode review before applying (${lineDiffText}).`,
    };

    return {
      content: [...(event.content || []), note],
    };
  });

  ////----------------------------------------
  ///     Write & edit review
  //------------------------------------------

  interface ReplacementEdit {
    oldText: string;
    newText: string;
  }

  /**
   * Resolve a tool path the same way pi's native file tools do:
   * absolute paths pass through, ~/ expands to $HOME, everything else is
   * resolved relative to ctx.cwd.
   */
  function resolveToolPath(ctx: ExtensionContext, filePath: string) {
    if (filePath === "~" || filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(1));
    }
    if (isAbsolute(filePath)) {
      return filePath;
    }
    return resolve(ctx.cwd, filePath);
  }

  /**
   * Return true when targetPath stays within baseDir.
   */
  function isPathInside(baseDir: string, targetPath: string) {
    const rel = relative(baseDir, targetPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /**
   * Prefer a cwd-relative display path for in-repo files, otherwise show the
   * absolute path so outside-cwd reviews are obvious.
   */
  function getDisplayPath(ctx: ExtensionContext, filePath: string) {
    const absolutePath = resolveToolPath(ctx, filePath);
    if (isPathInside(ctx.cwd, absolutePath)) {
      const relPath = relative(ctx.cwd, absolutePath);
      return relPath || absolutePath;
    }
    return absolutePath;
  }

  /**
   * Create a safe temporary staging path inside tmpDir.
   *
   * Never mirror the target path with ../ segments — staging must stay inside
   * the temp directory even when the reviewed file is outside ctx.cwd.
   */
  function createStagePath(targetPath: string, tag: string) {
    const base = basename(targetPath) || "file";
    const ext = extname(base);
    const stem = (ext ? base.slice(0, -ext.length) : base) || "file";
    const safeStem = stem.replace(/[^a-zA-Z0-9._-]+/g, "-") || "file";
    const safeTag = tag.replace(/[^a-zA-Z0-9._-]+/g, "-") || "stage";
    ensureDir(tmpDir);
    return join(tmpDir, `${safeStem}-${safeTag}${ext}`);
  }

  /** Strip UTF-8 BOM if present. */
  function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith("\uFEFF")
      ? { bom: "\uFEFF", text: content.slice(1) }
      : { bom: "", text: content };
  }

  function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /**
   * Match the edit tool's fuzzy normalization so slow-mode previews behave the
   * same way as the real edit tool.
   */
  function normalizeForFuzzyMatch(text: string): string {
    return (
      text
        .normalize("NFKC")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    );
  }

  function countOccurrences(content: string, oldText: string): number {
    const normalizedContent = normalizeForFuzzyMatch(content);
    const normalizedOldText = normalizeForFuzzyMatch(oldText);
    return normalizedContent.split(normalizedOldText).length - 1;
  }

  function findEditMatch(content: string, oldText: string) {
    const exactIndex = content.indexOf(oldText);
    if (exactIndex !== -1) {
      return {
        found: true,
        index: exactIndex,
        matchLength: oldText.length,
        usedFuzzyMatch: false,
      };
    }

    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzyOldText = normalizeForFuzzyMatch(oldText);
    const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
    if (fuzzyIndex === -1) {
      return {
        found: false,
        index: -1,
        matchLength: 0,
        usedFuzzyMatch: false,
      };
    }

    return {
      found: true,
      index: fuzzyIndex,
      matchLength: fuzzyOldText.length,
      usedFuzzyMatch: true,
    };
  }

  /**
   * Normalize edit input the same way the core edit tool does.
   * Supports both legacy oldText/newText and modern edits[].
   */
  function collectEditReplacements(input: Record<string, unknown>): ReplacementEdit[] {
    const edits: ReplacementEdit[] = [];

    if (Array.isArray(input.edits)) {
      for (const candidate of input.edits) {
        if (!candidate || typeof candidate !== "object") continue;
        const oldText = (candidate as Record<string, unknown>).oldText;
        const newText = (candidate as Record<string, unknown>).newText;
        if (typeof oldText === "string" && typeof newText === "string") {
          edits.push({ oldText, newText });
        }
      }
    }

    if (typeof input.oldText === "string" && typeof input.newText === "string") {
      edits.push({ oldText: input.oldText, newText: input.newText });
    }

    return edits;
  }

  /**
   * Apply edit-tool replacements against LF-normalized content.
   * All matches are found on the original content and then applied in reverse
   * order to keep offsets stable.
   */
  function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: ReplacementEdit[],
    path: string,
  ) {
    const normalizedEdits = edits.map((edit) => ({
      oldText: normalizeToLF(edit.oldText),
      newText: normalizeToLF(edit.newText),
    }));

    for (let i = 0; i < normalizedEdits.length; i++) {
      if (normalizedEdits[i].oldText.length === 0) {
        throw new Error(
          normalizedEdits.length === 1
            ? `oldText must not be empty in ${path}.`
            : `edits[${i}].oldText must not be empty in ${path}.`,
        );
      }
    }

    const baseContent = normalizedEdits.some((edit) => findEditMatch(normalizedContent, edit.oldText).usedFuzzyMatch)
      ? normalizeForFuzzyMatch(normalizedContent)
      : normalizedContent;

    const matchedEdits: Array<{
      editIndex: number;
      matchIndex: number;
      matchLength: number;
      newText: string;
    }> = [];

    for (let i = 0; i < normalizedEdits.length; i++) {
      const edit = normalizedEdits[i];
      const match = findEditMatch(baseContent, edit.oldText);
      if (!match.found) {
        throw new Error(
          normalizedEdits.length === 1
            ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
            : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
        );
      }

      const occurrences = countOccurrences(baseContent, edit.oldText);
      if (occurrences > 1) {
        throw new Error(
          normalizedEdits.length === 1
            ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
            : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
        );
      }

      matchedEdits.push({
        editIndex: i,
        matchIndex: match.index,
        matchLength: match.matchLength,
        newText: edit.newText,
      });
    }

    matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
    for (let i = 1; i < matchedEdits.length; i++) {
      const previous = matchedEdits[i - 1];
      const current = matchedEdits[i];
      if (previous.matchIndex + previous.matchLength > current.matchIndex) {
        throw new Error(
          `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. ` +
          "Merge them into one edit or target disjoint regions.",
        );
      }
    }

    let newContent = baseContent;
    for (let i = matchedEdits.length - 1; i >= 0; i--) {
      const edit = matchedEdits[i];
      newContent =
        newContent.substring(0, edit.matchIndex) +
        edit.newText +
        newContent.substring(edit.matchIndex + edit.matchLength);
    }

    if (baseContent === newContent) {
      throw new Error(
        normalizedEdits.length === 1
          ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
          : `No changes made to ${path}. The replacements produced identical content.`,
      );
    }

    return { baseContent, newContent };
  }

  /**
   * Review handler for write tool calls (new files / overwrites).
   */
  async function reviewWrite(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path;
    const content = input.content;

    if (typeof filePath !== "string" || typeof content !== "string") return;

    const absolutePath = resolveToolPath(ctx, filePath);
    const displayPath = getDisplayPath(ctx, filePath);
    const stagePath = createStagePath(absolutePath, `${toolCallId}-write`);

    writeFileSync(stagePath, content, "utf-8");

    pi.events.emit("slow-mode:waiting", undefined);
    const rejection = await showReview(ctx, {
      operation: "WRITE",
      filePath: displayPath,
      stagePath,
      body: content,
      allowEdit: true,
    });
    pi.events.emit("slow-mode:resolved", undefined);

    if (rejection === null) {
      try {
        const editedContent = readFileSync(stagePath, "utf-8");
        if (editedContent !== content) {
          input.content = editedContent;
          editedCalls.set(toolCallId, { original: content, edited: editedContent });
          ctx.ui.notify("Using edited content", "info");
        }
      } catch {
        // If we can't read the file, fall back to the original content.
      }
    }

    cleanup(stagePath);

    if (rejection !== null) {
      const reason = rejection.trim()
        ? `User rejected the write in slow mode review. Reason: ${rejection.trim()}`
        : "User rejected the write in slow mode review.";
      return { block: true, reason };
    }
  }

  /**
   * Review handler for edit tool calls (modifications to existing files).
   *
   * Supports both legacy oldText/newText inputs and the current edits[] form.
   * When the user edits the staged result, the tool input is rewritten to a
   * single full-file replacement so the edited review result is what gets
   * applied.
   */
  async function reviewEdit(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path;
    if (typeof filePath !== "string") return;

    const edits = collectEditReplacements(input);
    if (edits.length === 0) return;

    const absolutePath = resolveToolPath(ctx, filePath);
    const displayPath = getDisplayPath(ctx, filePath);

    let normalizedOriginalContent: string;
    let proposedNewContent: string;

    try {
      const rawContent = readFileSync(absolutePath, "utf-8");
      const { text: contentWithoutBom } = stripBom(rawContent);
      const { baseContent, newContent } = applyEditsToNormalizedContent(
        normalizeToLF(contentWithoutBom),
        edits,
        filePath,
      );
      normalizedOriginalContent = baseContent;
      proposedNewContent = newContent;
    } catch {
      // Fall back to the real edit tool's own validation/error handling.
      return;
    }

    const oldPath = createStagePath(absolutePath, `${toolCallId}-old`);
    const newPath = createStagePath(absolutePath, `${toolCallId}-new`);
    writeFileSync(oldPath, normalizedOriginalContent, "utf-8");
    writeFileSync(newPath, proposedNewContent, "utf-8");

    pi.events.emit("slow-mode:waiting", undefined);

    let approved = false;
    let rejectionReason = "";

    reviewLoop:
    while (true) {
      const currentOldText = readFileSync(oldPath, "utf-8");
      const currentNewText = readFileSync(newPath, "utf-8");
      const diff = generateUnifiedDiff(displayPath, currentOldText, currentNewText);

      const decision = await showEditReview(ctx, {
        filePath: displayPath,
        body: diff,
        oldPath,
        newPath,
      });

      if (decision === "approve") {
        approved = true;
        break reviewLoop;
      }
      if (decision === "edit") {
        openExternalFile(newPath);
        continue;
      }

      rejectionReason = decision.reason;
      approved = false;
      break reviewLoop;
    }

    if (approved) {
      try {
        const editedNewContent = readFileSync(newPath, "utf-8");
        if (editedNewContent !== proposedNewContent) {
          input.edits = [{ oldText: normalizedOriginalContent, newText: editedNewContent }];
          delete input.oldText;
          delete input.newText;
          editedCalls.set(toolCallId, { original: proposedNewContent, edited: editedNewContent });
          ctx.ui.notify("Using edited content", "info");
        }
      } catch {
        // If we can't read the file, fall back to the original tool input.
      }
    }

    pi.events.emit("slow-mode:resolved", undefined);

    cleanup(oldPath);
    cleanup(newPath);

    if (!approved) {
      const reason = rejectionReason.trim()
        ? `User rejected the edit in slow mode review. Reason: ${rejectionReason.trim()}`
        : "User rejected the edit in slow mode review.";
      return { block: true, reason };
    }
  }

  ////----------------------------------------
  ///     Review UI
  //------------------------------------------

  /**
   * Options for the review UI component
   */
  interface ReviewOptions {
    operation: "WRITE" | "EDIT";   // Type of change being reviewed
    filePath: string;               // Relative path to the file
    stagePath: string;              // Path to staged file (for writes and as fallback)
    body: string;                   // Content to display (file content or diff)
    oldPath?: string;               // Staged old file (edits only)
    newPath?: string;               // Staged new file (edits only)
    allowEdit?: boolean;            // Allow editing in external editor (default: false)
  }

  /**
   * Show interactive review UI
   *
   * Displays the proposed change with scrollable preview and key bindings:
   * - Enter: approve change
   * - Esc: open rejection-reason prompt (type reason, Enter to confirm, Esc to cancel)
   * - Ctrl+O: open in external viewer/editor (nvim/vim/diff for edits, $EDITOR for writes)
   * - k/↑: scroll up one line
   * - j/↓: scroll down one line
   * - u/PgUp: scroll up half page (15 lines)
   * - d/PgDn: scroll down half page (15 lines)
   * - gg: go to top
   * - G: go to bottom
   *
   * If allowEdit is true and user edits in external editor, the display is updated
   * to show the modified content/diff.
   *
   * @returns Promise<string | null> - null if approved, string (possibly empty) if rejected
   */
  async function showReview(
    ctx: ExtensionContext,
    opts: ReviewOptions,
  ): Promise<string | null> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      // Scroll state
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;

      // Whether the user is currently typing a rejection reason
      let typing = false;
      let reasonBuffer = "";

      // Current body content (may be updated after external edit)
      let currentBody = opts.body;

      // Content split into lines for scrolling
      let bodyLines = currentBody.split("\n");

      // Max visible content lines — adapt to terminal height.
      // The component output + TUI footer/widgets must fit within the
      // terminal viewport, otherwise the TUI triggers expensive full
      // redraws on every interaction.  Overhead breakdown:
      //   Component chrome (borders, label, path, hints, etc.): ~10 lines
      //   TUI footer: ~3 lines
      //   TUI widget spacer above editor: 1 line
      //   Extra buffer for status/pending messages: 2 lines
      const maxVisible = Math.max(3, tui.terminal.rows - 16);

      // Max scroll position (clamp to avoid scrolling past content)
      let maxScroll = Math.max(0, bodyLines.length - maxVisible);

      // Track last 'g' press for gg binding
      let lastGPress = 0;

      /**
       * Clamp scroll offset to valid range
       */
      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      /**
       * Invalidate render cache and request re-render
       */
      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      /**
       * Open staged files in external viewer/editor
       * For edits: opens nvim/vim diff
       * For writes: opens file in $VISUAL/$EDITOR
       * 
       * If allowEdit is true, reloads content after editing.
       */
      function openExternal() {
        try {
          if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } else {
            openExternalFile(opts.stagePath);
          }
          
          // If editing is allowed, reload and display the updated content
          if (opts.allowEdit) {
            try {
              if (opts.operation === "WRITE") {
                // Reload the edited file content
                const editedContent = readFileSync(opts.stagePath, "utf-8");
                currentBody = editedContent;
              } else if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
                // Reload the edited new file and regenerate diff
                const editedOldText = readFileSync(opts.oldPath, "utf-8");
                const editedNewText = readFileSync(opts.newPath, "utf-8");
                currentBody = generateUnifiedDiff(opts.filePath, editedOldText, editedNewText);
              }

              // Update bodyLines and scroll bounds
              bodyLines = currentBody.split("\n");
              maxScroll = Math.max(0, bodyLines.length - maxVisible);
              scrollOffset = Math.min(scrollOffset, maxScroll);
            } catch {
              // If reload fails, keep showing original content
            }
          }
        } catch {
          // External viewer failed — stay in inline review
          // (e.g., viewer not found, user closed viewer)
        }
        refresh();
      }

      /**
       * Handle keyboard input
       */
      function handleInput(data: string) {
        // While typing a rejection reason
        if (typing) {
          if (matchesKey(data, Key.enter)) {
            done(reasonBuffer);
            return;
          }
          if (matchesKey(data, Key.escape)) {
            // Cancel — go back to reviewing
            typing = false;
            reasonBuffer = "";
            refresh();
            return;
          }
          if (data === "\x7f" || data === "\b") {
            reasonBuffer = reasonBuffer.slice(0, -1);
            refresh();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            reasonBuffer += data;
            refresh();
            return;
          }
          return;
        }

        // Approve change
        if (matchesKey(data, Key.enter)) {
          done(null);
          return;
        }

        // Enter rejection-reason prompt
        if (matchesKey(data, Key.escape)) {
          typing = true;
          refresh();
          return;
        }

        // Open in external viewer
        if (matchesKey(data, Key.ctrl("o"))) {
          openExternal();
          return;
        }

        // Vim-style navigation: k or ↑ - scroll up one line
        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }

        // Vim-style navigation: j or ↓ - scroll down one line
        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }

        // Vim-style navigation: u or PgUp - scroll up half page (15 lines)
        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 15);
          refresh();
          return;
        }

        // Vim-style navigation: d or PgDn - scroll down half page (15 lines)
        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 15);
          refresh();
          return;
        }

        // Vim-style navigation: gg - go to top
        if (data === "g") {
          const now = Date.now();
          // Check if this is a double 'g' within 500ms
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0; // Reset
          } else {
            lastGPress = now;
          }
          return;
        }

        // Vim-style navigation: G - go to bottom
        if (data === "G") {
          scrollOffset = maxScroll;
          refresh();
          return;
        }
      }

      /**
       * Render the review UI
       */
      function render(width: number): string[] {
        // Return cached lines if available (performance optimization)
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        // Top separator
        add(theme.fg("accent", "─".repeat(width)));

        // Operation label (NEW FILE or EDIT)
        const opLabel =
          opts.operation === "WRITE"
            ? theme.fg("warning", " NEW FILE")
            : theme.fg("accent", " EDIT (diff)");
        add(opLabel);

        // File path
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Scrollable content/diff window
        const visible = bodyLines.slice(
          scrollOffset,
          scrollOffset + maxVisible,
        );
        
        for (const line of visible) {
          if (opts.operation === "EDIT") {
            // Manual syntax highlighting for unified diff format
            if (line.startsWith("---") || line.startsWith("+++")) {
              // File headers — dim
              add(` ${theme.fg("dim", line)}`);
            } else if (line.startsWith("@@")) {
              // Hunk headers — accent
              add(` ${theme.fg("accent", line)}`);
            } else if (line.startsWith("+")) {
              // Added lines — green
              add(` ${theme.fg("success", line)}`);
            } else if (line.startsWith("-")) {
              // Removed lines — red
              add(` ${theme.fg("error", line)}`);
            } else {
              // Context lines — normal text
              add(` ${theme.fg("text", line)}`);
            }
          } else {
            // Write operation: no syntax highlighting, just plain text
            add(` ${theme.fg("text", line)}`);
          }
        }

        // Scroll indicator (show if content doesn't fit in window)
        if (bodyLines.length > maxVisible) {
          const total = bodyLines.length;
          const end = Math.min(scrollOffset + maxVisible, total);
          add(
            theme.fg(
              "dim",
              ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`,
            ),
          );
        }

        lines.push("");

        // Key binding hints / rejection reason input
        if (typing) {
          add(theme.fg("warning", ` Reject — type a reason and press Enter, or Esc to cancel:`));
          add(theme.fg("text", ` > ${reasonBuffer}▌`));
        } else {
          const ctrlOHint = opts.allowEdit ? "Ctrl+O edit externally" : "Ctrl+O view externally";
          add(
            theme.fg("dim", ` Enter approve • Esc reject with reason • ${ctrlOHint} • j/k u/d gg/G scroll`),
          );
        }

        // Bottom separator
        add(theme.fg("accent", "─".repeat(width)));

        // Cache the rendered lines
        cachedLines = lines;
        return lines;
      }

      // Return TUI component interface
      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    });
  }

  /**
   * Options for the edit review UI (diff-specific)
   */
  interface EditReviewOptions {
    filePath: string;               // Relative path to the file
    body: string;                   // Unified diff content to display
    oldPath: string;                // Staged old file
    newPath: string;                // Staged new file
  }

  /**
   * Show interactive review UI for edit operations.
   *
   * Like showReview, but returns a three-way decision:
   * - "approve": apply the change
   * - { type: "reject"; reason: string }: block the change, with optional typed reason
   * - "edit": open the new file in an editor (caller should loop)
   *
   * Key bindings:
   * - Enter: approve
   * - Esc: open rejection-reason prompt (type reason, Enter to confirm, Esc to cancel)
   * - Ctrl+E: edit the new file in $VISUAL/$EDITOR
   * - Ctrl+O: view diff in external viewer (nvim/vim/diff)
   * - j/k/u/d/gg/G: scroll
   */
  async function showEditReview(
    ctx: ExtensionContext,
    opts: EditReviewOptions,
  ): Promise<"approve" | "edit" | { type: "reject"; reason: string }> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<"approve" | "edit" | { type: "reject"; reason: string }>((tui, theme, _kb, done) => {
      // Scroll state
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;

      // Whether the user is currently typing a rejection reason
      let typing = false;
      let reasonBuffer = "";

      // Content split into lines for scrolling
      const bodyLines = opts.body.split("\n");

      // Max visible content lines — adapt to terminal height (see showReview).
      const maxVisible = Math.max(3, tui.terminal.rows - 16);
      let maxScroll = Math.max(0, bodyLines.length - maxVisible);

      // Track last 'g' press for gg binding
      let lastGPress = 0;

      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        // While typing a rejection reason
        if (typing) {
          if (matchesKey(data, Key.enter)) {
            done({ type: "reject", reason: reasonBuffer });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            // Cancel — go back to reviewing
            typing = false;
            reasonBuffer = "";
            refresh();
            return;
          }
          if (data === "\x7f" || data === "\b") {
            reasonBuffer = reasonBuffer.slice(0, -1);
            refresh();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            reasonBuffer += data;
            refresh();
            return;
          }
          return;
        }

        // Approve
        if (matchesKey(data, Key.enter)) {
          done("approve");
          return;
        }

        // Enter rejection-reason prompt
        if (matchesKey(data, Key.escape)) {
          typing = true;
          refresh();
          return;
        }

        // Edit: open just the new file in the user's editor
        if (matchesKey(data, Key.ctrl("e"))) {
          done("edit");
          return;
        }

        // View diff externally (read-only)
        if (matchesKey(data, Key.ctrl("o"))) {
          try {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } catch {
            // External viewer failed — stay in inline review
          }
          refresh();
          return;
        }

        // Vim-style navigation
        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }
        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }
        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 15);
          refresh();
          return;
        }
        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 15);
          refresh();
          return;
        }
        if (data === "g") {
          const now = Date.now();
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0;
          } else {
            lastGPress = now;
          }
          return;
        }
        if (data === "G") {
          scrollOffset = maxScroll;
          refresh();
          return;
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", " EDIT (diff)"));
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Scrollable diff window with syntax highlighting
        const visible = bodyLines.slice(scrollOffset, scrollOffset + maxVisible);
        
        for (const line of visible) {
          // Manual syntax highlighting for unified diff format
          if (line.startsWith("---") || line.startsWith("+++")) {
            add(` ${theme.fg("dim", line)}`);
          } else if (line.startsWith("@@")) {
            add(` ${theme.fg("accent", line)}`);
          } else if (line.startsWith("+")) {
            add(` ${theme.fg("success", line)}`);
          } else if (line.startsWith("-")) {
            add(` ${theme.fg("error", line)}`);
          } else {
            add(` ${theme.fg("text", line)}`);
          }
        }

        if (bodyLines.length > maxVisible) {
          const total = bodyLines.length;
          const end = Math.min(scrollOffset + maxVisible, total);
          add(
            theme.fg("dim", ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`),
          );
        }

        lines.push("");
        if (typing) {
          add(theme.fg("warning", ` Reject — type a reason and press Enter, or Esc to cancel:`));
          add(theme.fg("text", ` > ${reasonBuffer}▌`));
        } else {
          add(
            theme.fg("dim", ` Enter approve • Esc reject with reason • Ctrl+E edit • Ctrl+O view diff • j/k u/d gg/G scroll`),
          );
        }
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => { cachedLines = undefined; },
        handleInput,
      };
    });
  }

  ////----------------------------------------
  ///     External viewers
  //------------------------------------------

  /**
   * Open old/new files in an external diff viewer
   *
   * Discovery order:
   * 1. nvim -d (if nvim available)
   * 2. vim -d (if vim available)
   * 3. diff (fallback to plain diff)
   *
   * If no diff tool found, falls back to opening just the new file.
   *
   * @param oldPath - Path to staged old version
   * @param newPath - Path to staged new version
   * @param label - File label (unused currently, for future use)
   */
  function openExternalDiff(oldPath: string, newPath: string, label: string) {
    const diffTool = findDiffTool();

    // No diff tool found — fall back to opening just the new file
    if (!diffTool) {
      openExternalFile(newPath);
      return;
    }

    const { cmd, args } = diffTool;

    // Configure tool-specific arguments
    if (cmd === "nvim" || cmd === "vim") {
      // vim/nvim: open in diff mode
      args.push("-d", oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    } else {
      // Generic diff tool: assume it takes two file arguments
      args.push(oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    }
  }

  /**
   * Open a single file in the user's preferred editor
   *
   * Uses $VISUAL, $EDITOR, or falls back to 'less' for viewing.
   */
  function openExternalFile(filePath: string) {
    const editor = process.env.VISUAL || process.env.EDITOR || "less";
    execFileSync(editor, [filePath], { stdio: "inherit" });
  }

  /**
   * Find an available diff tool on the system
   *
   * @returns { cmd, args } if found, null otherwise
   */
  function findDiffTool(): { cmd: string; args: string[] } | null {
    const candidates = ["nvim", "vim", "diff"];

    for (const cmd of candidates) {
      try {
        // Check if command exists in PATH
        execFileSync("which", [cmd], { stdio: "ignore" });
        return { cmd, args: [] };
      } catch {
        // Command not found, try next candidate
        continue;
      }
    }

    // No diff tool found
    return null;
  }

  ////----------------------------------------
  ///     Diff generation (Myers algorithm)
  //------------------------------------------

  /**
   * Generate a unified diff using the Myers diff algorithm.
   *
   * Replaces the external 'diff' npm package with a zero-dependency
   * implementation. Produces output equivalent to `diff -u` / `git diff`.
   *
   * @param filePath - Relative file path (used in --- / +++ headers)
   * @param oldText - Original text
   * @param newText - Modified text
   * @param contextLines - Number of context lines around changes (default: 3)
   * @returns Unified diff string
   */
  function generateUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
  ): string {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const edits = myersDiff(oldLines, newLines);
    const hunks = buildHunks(edits, contextLines);

    const out: string[] = [];
    out.push(`--- a/${filePath}`);
    out.push(`+++ b/${filePath}`);

    for (const hunk of hunks) {
      out.push(
        `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      );
      for (const line of hunk.lines) {
        out.push(line);
      }
    }

    return out.join("\n");
  }

  /**
   * Edit operation in a diff: keep, insert, or delete a line.
   */
  type Edit =
    | { type: "keep"; line: string }
    | { type: "insert"; line: string }
    | { type: "delete"; line: string };

  /**
   * Myers diff algorithm (linear-space variant).
   *
   * Computes the shortest edit script (SES) between two arrays of lines.
   * Time: O((N+M)D) where D is the edit distance.
   * Space: O((N+M)D) for the trace (acceptable for code diffs).
   *
   * Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its
   * Variations", Algorithmica 1(2), 1986.
   */
  function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
    const n = oldLines.length;
    const m = newLines.length;
    const max = n + m;

    // V[k] = furthest x-position reached on diagonal k
    // Diagonals range from -max..+max, offset by max for array indexing
    const size = 2 * max + 1;
    const v = new Int32Array(size);
    v[max + 1] = 0;

    // Store each V snapshot to reconstruct the path
    const trace: Int32Array[] = [];

    outer:
    for (let d = 0; d <= max; d++) {
      // Save current state before modification
      trace.push(v.slice());

      for (let k = -d; k <= d; k += 2) {
        const kIdx = k + max;

        // Decide whether to move down (insert) or right (delete)
        let x: number;
        if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
          x = v[kIdx + 1]; // move down: take x from diagonal k+1
        } else {
          x = v[kIdx - 1] + 1; // move right: take x from diagonal k-1 and advance
        }
        let y = x - k;

        // Follow the diagonal (matching lines)
        while (x < n && y < m && oldLines[x] === newLines[y]) {
          x++;
          y++;
        }

        v[kIdx] = x;

        // Reached the end of both sequences
        if (x >= n && y >= m) {
          break outer;
        }
      }
    }

    // Backtrack through the trace to reconstruct the edit script
    const edits: Edit[] = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d >= 0; d--) {
      const prev = trace[d];
      const k = x - y;
      const kIdx = k + max;

      // Determine which diagonal we came from
      let prevK: number;
      if (k === -d || (k !== d && prev[kIdx - 1] < prev[kIdx + 1])) {
        prevK = k + 1; // came from above (insert)
      } else {
        prevK = k - 1; // came from left (delete)
      }

      const prevX = prev[prevK + max];
      const prevY = prevX - prevK;

      // Diagonal moves (matching lines) — emit keeps in reverse
      while (x > prevX && y > prevY) {
        x--;
        y--;
        edits.push({ type: "keep", line: oldLines[x] });
      }

      if (d > 0) {
        if (x === prevX) {
          // Vertical move: insert from new
          y--;
          edits.push({ type: "insert", line: newLines[y] });
        } else {
          // Horizontal move: delete from old
          x--;
          edits.push({ type: "delete", line: oldLines[x] });
        }
      }
    }

    edits.reverse();
    return edits;
  }

  /**
   * A hunk in a unified diff.
   */
  interface Hunk {
    oldStart: number;  // 1-based start line in old file
    oldCount: number;  // number of old-file lines in hunk
    newStart: number;  // 1-based start line in new file
    newCount: number;  // number of new-file lines in hunk
    lines: string[];   // prefixed lines (" ", "+", "-")
  }

  /**
   * Group edit operations into unified diff hunks with context lines.
   *
   * Adjacent changes within (2 * contextLines) of each other are merged
   * into a single hunk, matching standard unified diff behavior.
   */
  function buildHunks(edits: Edit[], contextLines: number): Hunk[] {
    if (edits.length === 0) return [];

    // Find indices of all change operations (insert or delete)
    const changeIndices: number[] = [];
    for (let i = 0; i < edits.length; i++) {
      if (edits[i].type !== "keep") {
        changeIndices.push(i);
      }
    }

    if (changeIndices.length === 0) return [];

    // Group changes that are close enough to share context
    const groups: { start: number; end: number }[] = [];
    let groupStart = changeIndices[0];
    let groupEnd = changeIndices[0];

    for (let i = 1; i < changeIndices.length; i++) {
      // If gap between changes is <= 2*contextLines, merge into same group
      if (changeIndices[i] - groupEnd <= 2 * contextLines) {
        groupEnd = changeIndices[i];
      } else {
        groups.push({ start: groupStart, end: groupEnd });
        groupStart = changeIndices[i];
        groupEnd = changeIndices[i];
      }
    }
    groups.push({ start: groupStart, end: groupEnd });

    // Convert groups into hunks
    const hunks: Hunk[] = [];

    for (const group of groups) {
      // Expand to include context lines
      const hunkStart = Math.max(0, group.start - contextLines);
      const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);

      const lines: string[] = [];
      let oldCount = 0;
      let newCount = 0;

      // Compute 1-based starting line numbers
      let oldLine = 1;
      let newLine = 1;
      for (let i = 0; i < hunkStart; i++) {
        if (edits[i].type === "keep" || edits[i].type === "delete") oldLine++;
        if (edits[i].type === "keep" || edits[i].type === "insert") newLine++;
      }

      for (let i = hunkStart; i <= hunkEnd; i++) {
        const edit = edits[i];
        switch (edit.type) {
          case "keep":
            lines.push(` ${edit.line}`);
            oldCount++;
            newCount++;
            break;
          case "delete":
            lines.push(`-${edit.line}`);
            oldCount++;
            break;
          case "insert":
            lines.push(`+${edit.line}`);
            newCount++;
            break;
        }
      }

      hunks.push({
        oldStart: oldLine,
        oldCount,
        newStart: newLine,
        newCount,
        lines,
      });
    }

    return hunks;
  }

  ////----------------------------------------
  ///     Helpers
  //------------------------------------------

  /**
   * Ensure a directory exists, creating parent directories as needed
   */
  function ensureDir(dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Delete a staged file, ignoring errors.
   * Refuses to unlink anything outside the slow-mode temp directory.
   */
  function cleanup(path: string) {
    if (!isPathInside(tmpDir, path)) {
      return;
    }

    try {
      unlinkSync(path);
    } catch {
      // Ignore — tmp cleanup is best-effort
      // File may not exist or may be in use
    }
  }
}
