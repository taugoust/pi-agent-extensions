import { Text } from "@earendil-works/pi-tui";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { writeProgress, GOAL_PROGRESS_EVENT } from "../shared/goal-progress.ts";
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
  let unsubscribeGoalProgress: (() => void) | undefined;

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
    executionMode: "sequential",
    description:
      "Update the existing checklist with the full steps array. Tasks default to the current goal; use goal_id:null for standalone work. Keep at most one in_progress step. Never remove unfinished goal tasks silently; only an explicitly authorized goal scope change may remove them.",
    promptSnippet: "Show users what has been done, what is happening now, and what is planned next",
    promptGuidelines: [
      "Use update_progress for multi-step work when meaningful progress changes; skip simple tasks and avoid redundant updates.",
      "Report actual progress. Use blocked when work depends on an external action or condition, include what is needed to continue in the step text, and do not mark blocked work completed.",
      "For a goal, maintain its required tasks here and mark completed only with evidence. Keep existing task IDs when refining wording or adding blocker details; omit IDs for new tasks. Include unfinished tasks in every update; goal_complete rejects unfinished linked tasks. Standalone work remains valid with goal_id:null.",
    ],
    parameters: ProgressParameters,
    prepareArguments: prepareProgressArguments,
    renderCall(args, theme) {
      const summary = Array.isArray(args.steps)
        ? (args.steps as unknown[]).filter(
            (step): step is ProgressStep =>
              typeof step === "object" && step !== null && "status" in step &&
              ["pending", "in_progress", "completed", "blocked"].includes(String(step.status)),
          )
        : [];
      const completed = summary.filter((step) => step.status === "completed").length;
      const blocked = summary.filter((step) => step.status === "blocked").length;
      const total = Array.isArray(args.steps) ? args.steps.length : 0;
      const remaining = Math.max(0, total - completed - blocked);
      const counts = [Array.isArray(args.steps) && total === 0 ? "∅ cleared" : `✓ ${completed}/${total} completed`];
      if (blocked > 0) counts.push(`⊘ ${blocked} blocked`);
      if (remaining > 0) counts.push(`… ${remaining} remaining`);
      return new Text(theme.fg("toolTitle", theme.bold("update_progress: ")) + counts.join("; "), 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (context.isError) {
        const message = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        return new Text(theme.fg("error", message || "Progress update failed"), 0, 0);
      }
      if (isPartial) return new Text(theme.fg("warning", "Updating progress…"), 0, 0);
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ownsSession(ctx)) {
        throw new Error("Cannot update progress because the session changed.");
      }
      const validated = validateProgressArguments(params);
      const scoped = writeProgress(pi, ctx, validated.steps, validated.goal_id, false, false);
      const nextSteps = scoped.steps;
      const wasComplete = allProgressCompleted(steps);
      cancelCompletionSummary();
      widgetHidden = false;
      steps = cloneProgressSteps(nextSteps);
      const becameComplete = steps.length > 0 && allProgressCompleted(steps) && !wasComplete;
      if (becameComplete) publishCompletionSummary(ctx);
      else publish(ctx);

      const details: ProgressDetails = {
        version: PROGRESS_DETAILS_VERSION,
        steps: steps.map(({ text, status }) => ({ text, status })),
        ...(scoped.goalId ? { goalId: scoped.goalId } : {}),
      };
      if (steps.length === 0) {
        return {
          content: [{ type: "text", text: "Progress cleared." }],
          details,
        };
      }

      const completed = steps.filter((step) => step.status === "completed").length;
      const blocked = steps.filter((step) => step.status === "blocked").length;
      const pending = steps.length - completed - blocked;
      const counts = [`✓ ${completed}/${steps.length} completed`];
      if (blocked > 0) counts.push(`⊘ ${blocked} blocked`);
      if (pending > 0) counts.push(`… ${pending} remaining`);
      return {
        content: [{ type: "text", text: `update_progress: ${counts.join("; ")}` }],
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
    unsubscribeGoalProgress?.();
    unsubscribeGoalProgress = pi.events.on(GOAL_PROGRESS_EVENT, (event: any) => {
      if (!ownsSession(ctx) || (event?.sessionId && event.sessionId !== ctx.sessionManager.getSessionId())) return;
      cancelCompletionSummary();
      restoreBranchState(ctx);
      widgetHidden = allProgressCompleted(steps);
      publish(ctx);
    });
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
    restoreBranchState(ctx);
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
    unsubscribeGoalProgress?.();
    unsubscribeGoalProgress = undefined;
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
