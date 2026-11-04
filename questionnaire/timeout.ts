/** One deadline for the entire questionnaire, including every UI/forwarding route. */
export const QUESTIONNAIRE_TIMEOUT_MS = 5 * 60 * 1000;
export const QUESTIONNAIRE_TIMEOUT_REASON = Symbol("questionnaire-timeout");

export async function withQuestionnaireTimeout<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timedOut: () => T,
  aborted: () => T,
): Promise<T> {
  if (signal?.aborted) return aborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const boundary = new Promise<T>((resolve) => {
    abort = () => {
      resolve(aborted());
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      // Resolve first: transport abort errors must not disguise deadline expiry.
      resolve(timedOut());
      controller.abort(QUESTIONNAIRE_TIMEOUT_REASON);
    }, QUESTIONNAIRE_TIMEOUT_MS);
  });
  try {
    // A transport may ignore AbortSignal. The deadline still bounds the tool.
    return await Promise.race([boundary, run(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
