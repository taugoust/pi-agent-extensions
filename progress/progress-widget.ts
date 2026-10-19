import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderCompletionSummary, renderProgressWidget, sanitizeProgressText } from "./progress-renderer.js";
import { showProgressSettings } from "./progress-settings-ui.js";
import {
  allProgressCompleted,
  cloneProgressSteps,
  leadingSummaryEpoch,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE,
  PROGRESS_RESTORED_BOUNDARY_VERSION,
  type ProgressDetails,
  ProgressParameters,
  type ProgressStep,
  prepareProgressArguments,
  progressBoundaryContent,
  reconcileProgressContext,
  reconstructProgress,
  reconstructRestoredProgressBoundary,
  TOOL_NAME,
  validateProgressArguments,
} from "./progress-state.js";
import {
  DEFAULT_PROGRESS_SETTINGS,
  loadProgressSettings,
  type ProgressSettings,
  type ProgressSettingsLoadResult,
  progressSettingsPath,
  saveProgressSettings,
} from "./settings.js";

export const WIDGET_KEY = "progress";
export const COMPLETION_SUMMARY_MS = 3_000;
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
// RPC provides no terminal dimensions and ignores component factories.
const RPC_WIDGET_WIDTH = 80;

export interface ProgressWidgetDependencies {
  loadSettings?: typeof loadProgressSettings;
  saveSettings?: typeof saveProgressSettings;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export default function progressWidgetExtension(pi: ExtensionAPI, dependencies: ProgressWidgetDependencies = {}): void {
  const readSettings = dependencies.loadSettings ?? loadProgressSettings;
  const writeSettings = dependencies.saveSettings ?? saveProgressSettings;
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let activeWidgetOwner: { sessionManager: ExtensionContext["sessionManager"]; clear(): void } | undefined;
  let steps: ProgressStep[] = [];
  let settings = cloneDefaultSettings();
  let restoredBoundary: { summaryEpoch: string; content: string } | undefined;
  let settingsController = new AbortController();
  let settingsReady = false;
  let settingsScreenOpen = false;
  const settingsTasks = new Set<Promise<void>>();
  let generation = 0;
  let completionTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let completionToken = 0;
  let widgetHidden = false;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const clearActiveWidget = (): void => {
    activeWidgetOwner?.clear();
    activeWidgetOwner = undefined;
  };

  const cancelCompletionSummary = (): void => {
    completionToken += 1;
    if (completionTimer !== undefined) cancelTimeout(completionTimer);
    completionTimer = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx) || !ctx.hasUI) return;
    if (!settings.enabled || steps.length === 0 || widgetHidden) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const snapshot = cloneProgressSteps(steps);
    const widgetSettings = { ...settings };
    if (ctx.mode === "rpc") {
      ctx.ui.setWidget(
        WIDGET_KEY,
        renderProgressWidget(snapshot, ctx.ui.theme, RPC_WIDGET_WIDTH, { settings: widgetSettings }),
        WIDGET_OPTIONS,
      );
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => ({
        render: (width) =>
          renderProgressWidget(snapshot, theme, width, {
            settings: widgetSettings,
            terminalRows: tui.terminal.rows,
          }),
        invalidate: () => {},
      }),
      WIDGET_OPTIONS,
    );
  };

  const publishCompletionSummary = (ctx: ExtensionContext): void => {
    cancelCompletionSummary();
    widgetHidden = false;
    if (!ownsSession(ctx) || !ctx.hasUI || !settings.enabled) {
      publish(ctx);
      return;
    }

    const total = steps.length;
    if (ctx.mode === "rpc") {
      ctx.ui.setWidget(WIDGET_KEY, renderCompletionSummary(total, ctx.ui.theme, RPC_WIDGET_WIDTH), WIDGET_OPTIONS);
    } else {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
          render: (width) => renderCompletionSummary(total, theme, width),
          invalidate: () => {},
        }),
        WIDGET_OPTIONS,
      );
    }
    const ownerSession = activeSession;
    const token = completionToken;
    completionTimer = scheduleTimeout(() => {
      if (
        completionToken !== token ||
        activeSession !== ownerSession ||
        ctx.sessionManager !== ownerSession ||
        !settings.enabled ||
        !allProgressCompleted(steps)
      ) {
        return;
      }
      completionTimer = undefined;
      widgetHidden = true;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }, COMPLETION_SUMMARY_MS);
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Progress",
    description:
      "Replace the current session progress state with the complete supplied steps using update_progress. Keep at most one step in_progress; send an empty steps array only to intentionally clear the state.",
    promptSnippet: "Show users what has been done, what is happening now, and what is planned next",
    promptGuidelines: [
      "Use update_progress for multi-step work when meaningful progress changes; skip simple tasks and avoid redundant updates.",
      "Report actual progress. Use blocked when work depends on an external action or condition, include what is needed to continue in the step text, and do not mark blocked work completed.",
      "Progress reporting does not prescribe the workflow or require tool calls before work or replies.",
    ],
    parameters: ProgressParameters,
    prepareArguments: prepareProgressArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ownsSession(ctx)) {
        throw new Error("Cannot update progress because the session changed.");
      }
      const nextSteps = validateProgressArguments(params).steps;
      const wasComplete = allProgressCompleted(steps);
      cancelCompletionSummary();
      widgetHidden = false;
      steps = cloneProgressSteps(nextSteps);
      const becameComplete = steps.length > 0 && allProgressCompleted(steps) && !wasComplete;
      if (becameComplete) publishCompletionSummary(ctx);
      else publish(ctx);

      const details: ProgressDetails = {
        version: PROGRESS_DETAILS_VERSION,
        steps: cloneProgressSteps(steps),
      };
      if (steps.length === 0) {
        return {
          content: [{ type: "text", text: "Progress cleared." }],
          details,
        };
      }

      const completed = steps.filter((step) => step.status === "completed").length;
      const inProgress = steps.some((step) => step.status === "in_progress");
      const blocked = steps.filter((step) => step.status === "blocked").length;
      const suffixes = [...(inProgress ? ["1 in progress"] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
      return {
        content: [
          {
            type: "text",
            text: `Progress updated: ${completed} of ${steps.length} complete${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}.`,
          },
        ],
        details,
      };
    },
  });

  const openSettings = async (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<"back" | "close" | "stale"> => {
    if (signal.aborted || !isCurrent()) return "stale";
    if (ctx.mode !== "tui") {
      ctx.ui.notify(sanitizeProgressText(`Edit settings manually: ${progressSettingsPath()}; then /reload.`), "info");
      return "back";
    }
    return showProgressSettings(ctx, {
      signal,
      isCurrent,
      get: () => cloneSettings(settings),
      save: (patch, ownedSignal) => writeSettings(patch, undefined, ownedSignal),
      apply: (next) => {
        // A committed save still applies after the interaction closes, not after owner replacement.
        if (!isCurrent()) return;
        settings = cloneSettings(next);
        if (!settings.enabled) cancelCompletionSummary();
        if (completionTimer === undefined) publish(ctx);
      },
    });
  };

  const hideWidget = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx)) return;
    cancelCompletionSummary();
    widgetHidden = true;
    publish(ctx);
    ctx.ui.notify("Progress widget cleared. Saved progress is unchanged.", "info");
  };

  pi.registerCommand("progress", {
    description: "Manage the progress widget",
    getArgumentCompletions: (prefix) => {
      const matches = [
        { value: "clear", label: "clear", description: "Hide the widget without changing saved progress" },
        { value: "settings", label: "settings", description: "Configure progress display settings" },
      ].filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/progress requires TUI or RPC mode.");
      const route = args.trim();
      if (route !== "" && route !== "clear" && route !== "settings") {
        ctx.ui.notify("Usage: /progress | /progress clear | /progress settings", "warning");
        return;
      }
      if (!ownsSession(ctx)) {
        ctx.ui.notify("Cannot manage progress because the session changed.", "warning");
        return;
      }
      if (route === "clear") {
        hideWidget(ctx);
        return;
      }
      if (!settingsReady || settingsScreenOpen) {
        ctx.ui.notify("Progress controls are loading or already open.", "warning");
        return;
      }
      settingsScreenOpen = true;
      const ownerGeneration = generation;
      const ownerSignal = settingsController.signal;
      const isCurrent = () => ownsSession(ctx) && generation === ownerGeneration && !ownerSignal.aborted;
      const task = (async () => {
        if (route === "settings") {
          await openSettings(ctx, ownerSignal, isCurrent);
          return;
        }
        const { showProgressMenu } = await import("./progress-menu.js");
        if (!isCurrent()) return;
        await showProgressMenu(ctx, {
          signal: ownerSignal,
          isCurrent,
          getState: () => ({
            settings: cloneSettings(settings),
            settingsPath: progressSettingsPath(),
            widget: !settings.enabled ? "disabled" : widgetHidden ? "hidden" : steps.length === 0 ? "empty" : "visible",
            total: steps.length,
            completed: steps.filter((step) => step.status === "completed").length,
            inProgress: steps.filter((step) => step.status === "in_progress").length,
            blocked: steps.filter((step) => step.status === "blocked").length,
          }),
          hideWidget: () => {
            if (isCurrent()) hideWidget(ctx);
          },
          showSettings: (signal) => openSettings(ctx, signal, isCurrent),
        });
      })();
      settingsTasks.add(task);
      try {
        await task;
      } finally {
        settingsTasks.delete(task);
        if (isCurrent()) settingsScreenOpen = false;
      }
    },
  });

  const restoreBranchState = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    steps = reconstructProgress(branch);
    restoredBoundary = reconstructRestoredProgressBoundary(branch);
  };

  pi.on("session_start", async (_event, ctx) => {
    settingsController.abort();
    cancelCompletionSummary();
    clearActiveWidget();

    settingsReady = false;
    settingsScreenOpen = false;
    settingsController = new AbortController();
    const ownerController = settingsController;
    generation += 1;
    const ownerGeneration = generation;
    activeSession = ctx.sessionManager;
    if (ctx.hasUI) {
      const ownerSession = ctx.sessionManager;
      activeWidgetOwner = {
        sessionManager: ownerSession,
        clear: () => ctx.ui.setWidget(WIDGET_KEY, undefined),
      };
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    widgetHidden = false;
    settings = cloneDefaultSettings();
    restoreBranchState(ctx);
    // The completion summary is a live transition. Do not reopen a finished snapshot.
    if (allProgressCompleted(steps)) widgetHidden = true;

    let loaded: ProgressSettingsLoadResult;
    try {
      loaded = await readSettings(undefined, ownerController.signal);
    } catch (error) {
      if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) return;
      loaded = {
        kind: "invalid",
        path: "pi-progress.json",
        settings: cloneDefaultSettings(),
        issue: error instanceof Error ? error.message : String(error),
      };
    }
    if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) return;
    settings = cloneSettings(loaded.settings);
    settingsReady = true;
    if (loaded.kind === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        sanitizeProgressText(`Invalid progress settings at ${loaded.path}; using defaults. ${loaded.issue}`),
        "warning",
      );
    }
    publish(ctx);
  });

  pi.on("context", (event: ContextEvent, ctx) => {
    if (!ownsSession(ctx)) return;
    const summaryEpoch = leadingSummaryEpoch(event.messages);
    if (restoredBoundary?.summaryEpoch !== summaryEpoch) restoredBoundary = undefined;
    const messages = reconcileProgressContext(event.messages, steps, restoredBoundary?.content);
    if (restoredBoundary === undefined && summaryEpoch) {
      const content = progressBoundaryContent(messages);
      if (content !== undefined) {
        restoredBoundary = { summaryEpoch, content };
        pi.appendEntry(PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE, {
          version: PROGRESS_RESTORED_BOUNDARY_VERSION,
          ...restoredBoundary,
        });
      }
    }
    if (messages !== event.messages) return { messages };
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cancelCompletionSummary();
    widgetHidden = false;
    restoreBranchState(ctx);
    publish(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    settingsController.abort();
    settingsReady = false;
    settingsScreenOpen = false;
    generation += 1;
    cancelCompletionSummary();
    if (activeWidgetOwner?.sessionManager === ctx.sessionManager) clearActiveWidget();
    steps = [];
    settings = cloneDefaultSettings();
    restoredBoundary = undefined;
    widgetHidden = false;
    activeSession = undefined;
    await Promise.allSettled([...settingsTasks]);
  });
}

export {
  LEGACY_TODO_CONTEXT_MESSAGE_TYPE,
  LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
  MAX_PROGRESS_STEPS,
  MAX_PROGRESS_TEXT_LENGTH,
  PROGRESS_CONTEXT_MESSAGE_TYPE,
  PROGRESS_CONTEXT_VERSION,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE,
  type ProgressDetails,
  type ProgressStep,
  reconcileProgressContext,
  TOOL_NAME,
  validateProgressArguments,
} from "./progress-state.js";
export { renderProgressWidget, sanitizeProgressText as sanitizeProgressStep };

function cloneDefaultSettings(): ProgressSettings {
  return { ...DEFAULT_PROGRESS_SETTINGS };
}

function cloneSettings(value: Readonly<ProgressSettings>): ProgressSettings {
  return { ...value };
}
