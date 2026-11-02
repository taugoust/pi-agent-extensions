/** Executor failure certified to have occurred before any child execution started. */
export class DelegatedGoalNoEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegatedGoalNoEffectError";
  }
}
