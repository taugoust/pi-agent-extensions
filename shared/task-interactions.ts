import type { TaskInteractionAnswer, TaskInteractionInput } from "./foreground-tasks.ts";

/** Shared validation for authenticated worker interactions, independent of transport. */
export function validInteractionInput(input: any): input is TaskInteractionInput {
  if (!input || Buffer.byteLength(JSON.stringify(input)) > 24 * 1024) return false;
  if (input.kind === "permission") return typeof input.title === "string" && input.title.length > 0 && Buffer.byteLength(input.title) <= 2048
    && Array.isArray(input.options) && input.options.length > 0 && input.options.length <= 12
    && input.options.every((value: any) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256)
    && new Set(input.options).size === input.options.length
    && (input.detail === undefined || typeof input.detail === "string" && Buffer.byteLength(input.detail) <= 8192);
  if (input.kind !== "questionnaire" || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 16) return false;
  const ids = new Set<string>();
  return input.questions.every((question: any) => {
    if (!question || typeof question.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(question.id) || ids.has(question.id)
      || typeof question.prompt !== "string" || !question.prompt.length || Buffer.byteLength(question.prompt) > 4096
      || typeof question.allowOther !== "boolean" || !Array.isArray(question.options) || question.options.length > 12) return false;
    if ((question.background !== undefined && (typeof question.background !== "string" || question.background.length > 2000 || Buffer.byteLength(question.background) > 4096))
      || (question.recommendation !== undefined && (typeof question.recommendation !== "string" || !question.options.some((option: any) => option.value === question.recommendation)))) return false;
    ids.add(question.id);
    const values = new Set<string>();
    return question.options.every((option: any) => option && typeof option.value === "string" && option.value.length > 0
      && Buffer.byteLength(option.value) <= 256 && !values.has(option.value) && (values.add(option.value), true)
      && typeof option.label === "string" && Buffer.byteLength(option.label) <= 512
      && (option.description === undefined || typeof option.description === "string" && Buffer.byteLength(option.description) <= 1024));
  });
}
export function validInteractionAnswer(input: TaskInteractionInput, answer: any): answer is TaskInteractionAnswer {
  if (!answer || typeof answer.cancelled !== "boolean" || answer.kind !== input?.kind) return false;
  if (input.kind === "permission") return answer.cancelled ? answer.value === undefined : typeof answer.value === "string" && input.options.includes(answer.value);
  if (!Array.isArray(answer.answers) || answer.answers.length > input.questions.length
    || (!answer.cancelled && answer.answers.length !== input.questions.length)) return false;
  const answered = new Set<string>();
  return answer.answers.every((entry: any) => {
    const question = input.questions.find(item => item.id === entry?.id);
    if (!question || answered.has(entry.id) || typeof entry.value !== "string" || Buffer.byteLength(entry.value) > 4096
      || typeof entry.wasCustom !== "boolean" || (entry.wasCustom ? !question.allowOther || !entry.value.trim()
        : !question.options.some(option => option.value === entry.value))) return false;
    answered.add(entry.id);
    return true;
  });
}
