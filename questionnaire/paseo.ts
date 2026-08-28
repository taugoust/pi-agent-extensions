const PASEO_REMOTE_UI_KEY = "__piPaseoRemoteUiV1";

export interface PaseoQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface PaseoQuestion {
  id: string;
  label: string;
  prompt: string;
  options: PaseoQuestionOption[];
}

export interface PaseoAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: false;
  index: number;
}

export type PaseoQuestionnaireOutcome =
  | { kind: "answered"; answers: PaseoAnswer[] }
  | { kind: "cancelled" }
  | { kind: "terminal" };

type PaseoRemoteUi = {
  isConnected(): boolean;
  select(
    title: string,
    options: string[],
    settings?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
};

const TERMINAL_CHOICE = "Answer in terminal";
const CANCEL_CHOICE = "Cancel questionnaire";

function getRemoteUi(): PaseoRemoteUi | null | undefined {
  const bridge = (globalThis as Record<string, unknown>)[PASEO_REMOTE_UI_KEY] as
    | PaseoRemoteUi
    | undefined;
  if (!bridge || typeof bridge.isConnected !== "function" || typeof bridge.select !== "function") {
    return null;
  }
  try {
    return bridge.isConnected() ? bridge : null;
  } catch {
    return undefined;
  }
}

function optionChoice(option: PaseoQuestionOption, index: number): string {
  return `${index + 1}. ${option.label}`;
}

function questionTitle(question: PaseoQuestion, index: number, total: number): string {
  const lines = [
    total === 1
      ? `Question · ${question.label}`
      : `Question ${index + 1} of ${total} · ${question.label}`,
    "",
    question.prompt,
  ];
  const describedOptions = question.options.filter((option) => option.description);
  if (describedOptions.length > 0) {
    lines.push("", "Options:");
    for (const [optionIndex, option] of question.options.entries()) {
      lines.push(optionChoice(option, optionIndex));
      if (option.description) lines.push(`   ${option.description}`);
    }
  }
  return lines.join("\n");
}

export async function answerQuestionnaireInPaseo(
  questions: PaseoQuestion[],
  signal?: AbortSignal,
): Promise<PaseoQuestionnaireOutcome | null> {
  const bridge = getRemoteUi();
  if (bridge === null) return null;
  if (bridge === undefined) return { kind: "cancelled" };

  const answers: PaseoAnswer[] = [];
  for (const [questionIndex, question] of questions.entries()) {
    const optionChoices = question.options.map(optionChoice);
    const choices = [...optionChoices, TERMINAL_CHOICE, CANCEL_CHOICE];
    let choice: string | undefined;
    try {
      choice = await bridge.select(
        questionTitle(question, questionIndex, questions.length),
        choices,
        { signal },
      );
    } catch {
      return { kind: "cancelled" };
    }

    if (choice === TERMINAL_CHOICE) return { kind: "terminal" };
    if (choice === CANCEL_CHOICE || choice === undefined) return { kind: "cancelled" };
    const optionIndex = optionChoices.indexOf(choice);
    if (optionIndex < 0) return { kind: "cancelled" };
    const option = question.options[optionIndex];
    answers.push({
      id: question.id,
      value: option.value,
      label: option.label,
      wasCustom: false,
      index: optionIndex + 1,
    });
  }

  return { kind: "answered", answers };
}
