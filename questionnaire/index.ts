/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

type AgentEventPublisher = (
  type: string,
  title: string,
  message: string,
  fields?: Record<string, unknown>,
) => Promise<boolean>;

type QuestionAnswerGetter = (questionnaireId: string) => Promise<unknown | undefined>;

type ExternalQuestionAnswer = {
  questionnaire_id?: string;
  cancelled?: boolean;
  answers?: Answer[];
};

declare global {
  var __PI_AGENTSH_PUBLISH_EVENT__: AgentEventPublisher | undefined;
  var __PI_AGENTSH_GET_QUESTION_ANSWER__: QuestionAnswerGetter | undefined;
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
  }),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Allow 'Type something' option (default: true)",
    }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
});

function errorResult(
  message: string,
  questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

function summarizeQuestions(questions: Question[]) {
  return questions.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExternalAnswer(
  answer: unknown,
  questions: Question[],
): QuestionnaireResult | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const candidate = answer as ExternalQuestionAnswer;
  if (!Array.isArray(candidate.answers)) return undefined;
  const validIds = new Set(questions.map((q) => q.id));
  const answers = candidate.answers
    .filter((a) => a && validIds.has(a.id))
    .map((a) => ({
      id: String(a.id),
      value: String(a.value ?? a.label ?? ""),
      label: String(a.label ?? a.value ?? ""),
      wasCustom: Boolean(a.wasCustom),
      index: typeof a.index === "number" ? a.index : undefined,
    }));
  if (!candidate.cancelled && answers.length === 0) return undefined;
  return { questions, answers, cancelled: Boolean(candidate.cancelled) };
}

async function pollExternalAnswer(
  questionnaireId: string,
  questions: Question[],
  isDone: () => boolean,
) {
  const getAnswer = globalThis.__PI_AGENTSH_GET_QUESTION_ANSWER__;
  if (!getAnswer) return undefined;
  while (!isDone()) {
    const answer = normalizeExternalAnswer(await getAnswer(questionnaireId), questions);
    if (answer) return answer;
    await sleep(1000);
  }
  return undefined;
}

async function publishQuestionnaireEvent(
  type: "agent.question.pending" | "agent.question.answered",
  title: string,
  message: string,
  fields: Record<string, unknown>,
) {
  const publish = globalThis.__PI_AGENTSH_PUBLISH_EVENT__;
  if (!publish) return false;
  try {
    return await publish(type, title, message, fields);
  } catch {
    return false;
  }
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more explicit questions instead of guessing. Use this whenever missing information could materially affect correctness, implementation, scope, risk, user preference, or whether to proceed. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    promptSnippet:
      "questionnaire: Ask the user structured questions when assumptions would affect correctness or scope.",
    promptGuidelines: [
      "Use questionnaire instead of guessing when requirements, preferences, risk tolerance, or go/no-go decisions are unclear.",
      "Prefer a short questionnaire before irreversible, broad, destructive, expensive, or highly opinionated work.",
      "Do not ask questions just to avoid routine work; ask only when the answer would change the result.",
      "Offer clear options and include an 'other' option when the user may need to provide a custom answer.",
    ],
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult(
          "Error: UI not available (running in non-interactive mode)",
        );
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit
      const questionnaireId = `questionnaire-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      await publishQuestionnaireEvent(
        "agent.question.pending",
        questions.length === 1 ? "Pi has a question" : `Pi has ${questions.length} questions`,
        summarizeQuestions(questions),
        {
          questionnaire_id: questionnaireId,
          question_count: questions.length,
          questions: questions.map((q) => ({
            id: q.id,
            label: q.label,
            prompt: q.prompt,
            options: q.options.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.description,
            })),
            allow_other: q.allowOther,
          })),
          cwd: ctx.cwd,
        },
      );

      let completed = false;
      let completeFromExternal: ((answer: QuestionnaireResult) => void) | undefined;

      const uiResult = ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          // State
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionId: string | null = null;
          let cachedLines: string[] | undefined;
          const answers = new Map<string, Answer>();

          // Editor for "Type something" option
          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          // Helpers
          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function finish(result: QuestionnaireResult, abort = false) {
            if (completed) return;
            completed = true;
            if (abort) {
              ctx.abort();
            }
            done(result);
          }

          completeFromExternal = (answer) => finish(answer);

          function submit(cancelled: boolean) {
            finish(
              {
                questions,
                answers: Array.from(answers.values()),
                cancelled,
              },
              cancelled,
            );
          }

          function currentQuestion(): Question | undefined {
            return questions[currentTab];
          }

          function currentOptions(): RenderOption[] {
            const q = currentQuestion();
            if (!q) return [];
            const opts: RenderOption[] = [...q.options];
            if (q.allowOther) {
              opts.push({
                value: "__other__",
                label: "Type something.",
                isOther: true,
              });
            }
            return opts;
          }

          function allAnswered(): boolean {
            return questions.every((q) => answers.has(q.id));
          }

          function advanceAfterAnswer() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) {
              currentTab++;
            } else {
              currentTab = questions.length; // Submit tab
            }
            optionIndex = 0;
            refresh();
          }

          function saveAnswer(
            questionId: string,
            value: string,
            label: string,
            wasCustom: boolean,
            index?: number,
          ) {
            answers.set(questionId, {
              id: questionId,
              value,
              label,
              wasCustom,
              index,
            });
          }

          // Editor submit callback
          editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim() || "(no response)";
            saveAnswer(inputQuestionId, trimmed, trimmed, true);
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            advanceAfterAnswer();
          };

          function handleInput(data: string) {
            // Input mode: route to editor
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionId = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = currentOptions();

            // Tab navigation (multi-question only)
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)
              ) {
                currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
            }

            // Submit tab
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }

            // Option navigation (arrow keys or vi-style j/k)
            if (matchesKey(data, Key.up) || data === "k") {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down) || data === "j") {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            // Select option
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                inputMode = true;
                inputQuestionId = q.id;
                editor.setText("");
                refresh();
                return;
              }
              saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
              advanceAfterAnswer();
              return;
            }

            // Cancel
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const q = currentQuestion();
            const opts = currentOptions();

            // Helper to add truncated line
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "─".repeat(width)));

            // Tab bar (multi-question only)
            if (isMulti) {
              const tabs: string[] = ["← "];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const isAnswered = answers.has(questions[i].id);
                const lbl = questions[i].label;
                const box = isAnswered ? "■" : "□";
                const color = isAnswered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                const styled = isActive
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(color, text);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmitTab = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const submitStyled = isSubmitTab
                ? theme.bg("selectedBg", theme.fg("text", submitText))
                : theme.fg(canSubmit ? "success" : "dim", submitText);
              tabs.push(`${submitStyled} →`);
              add(` ${tabs.join("")}`);
              lines.push("");
            }

            // Helper to render options list
            function renderOptions() {
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const selected = i === optionIndex;
                const isOther = opt.isOther === true;
                const prefix = selected ? theme.fg("accent", "> ") : "  ";
                const color = selected ? "accent" : "text";
                // Mark "Type something" differently when in input mode
                if (isOther && inputMode) {
                  add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
                } else {
                  add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
                }
                if (opt.description) {
                  add(`     ${theme.fg("muted", opt.description)}`);
                }
              }
            }

            // Content
            if (inputMode && q) {
              add(theme.fg("text", ` ${q.prompt}`));
              lines.push("");
              // Show options for reference
              renderOptions();
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              for (const line of editor.render(width - 2)) {
                add(` ${line}`);
              }
              lines.push("");
              add(theme.fg("dim", " Enter to submit • Esc to cancel"));
            } else if (currentTab === questions.length) {
              add(theme.fg("accent", theme.bold(" Ready to submit")));
              lines.push("");
              for (const question of questions) {
                const answer = answers.get(question.id);
                if (answer) {
                  const prefix = answer.wasCustom ? "(wrote) " : "";
                  add(
                    `${theme.fg("muted", ` ${question.label}: `)}${
                      theme.fg("text", prefix + answer.label)
                    }`,
                  );
                }
              }
              lines.push("");
              if (allAnswered()) {
                add(theme.fg("success", " Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((q) => !answers.has(q.id))
                  .map((q) => q.label)
                  .join(", ");
                add(theme.fg("warning", ` Unanswered: ${missing}`));
              }
            } else if (q) {
              add(theme.fg("text", ` ${q.prompt}`));
              lines.push("");
              renderOptions();
            }

            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? " Tab/←→ navigate • ↑↓/jk select • Enter confirm • Esc cancel"
                : " ↑↓/jk navigate • Enter select • Esc cancel";
              add(theme.fg("dim", help));
            }
            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

      void pollExternalAnswer(questionnaireId, questions, () => completed).then(
        (answer) => {
          if (answer && completeFromExternal) {
            completeFromExternal(answer);
          }
        },
      );

      const result = await uiResult;
      completed = true;

      await publishQuestionnaireEvent(
        "agent.question.answered",
        result.cancelled ? "Questionnaire cancelled" : "Questionnaire answered",
        result.cancelled
          ? "The questionnaire was cancelled."
          : "The questionnaire was answered in Pi.",
        {
          questionnaire_id: questionnaireId,
          cancelled: result.cancelled,
          question_count: questions.length,
          answer_count: result.answers.length,
          cwd: ctx.cwd,
        },
      );

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${
            theme.fg("muted", "(wrote) ")
          }${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${
          theme.fg("accent", a.id)
        }: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
