import type { JobResult } from "./types.ts";

// Hints for output that a pipe through tail, grep or sort has held back or
// dropped. They look at when and how much output arrived, not at the command.

const LONG_JOB_MS = 60_000;
const QUIET_RUNNING_MS = 3 * 60_000;
const SPARSE_JOB_MS = 5 * 60_000;
const SPARSE_LINES = 5;
export const COMPLETION_TAIL_LINES = 20;
const COMPLETION_TAIL_BYTES = 1500;

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return `${value} minute${value === 1 ? "" : "s"}`;
}

/** A note about output that only showed up at exit, or very little output. */
export function completionHint(result: JobResult, lineCount: number): string | undefined {
  const timing = result.output;
  if (!timing || timing.durationMs < LONG_JOB_MS || timing.bytes === 0) return undefined;
  if (timing.finalSecondBytes >= timing.bytes * 0.9) {
    return `Almost all output arrived in the last second of a run that took ${minutes(timing.durationMs)}, `
      + "probably held back by | tail or | sort. Output is captured in full, so run commands unfiltered.";
  }
  if (timing.durationMs >= SPARSE_JOB_MS && lineCount <= SPARSE_LINES) {
    return `Only ${lineCount} line${lineCount === 1 ? "" : "s"} of output after ${minutes(timing.durationMs)}. `
      + "If the command was filtered with | grep, the rest was not kept.";
  }
  return undefined;
}

/** A note for a running job that has printed nothing for a while. */
export function quietRunningHint(startedAt: number, lastOutputAt: number, now = Date.now()): string | undefined {
  const quietFor = now - Math.max(startedAt, lastOutputAt);
  if (now - startedAt < QUIET_RUNNING_MS || quietFor < QUIET_RUNNING_MS) return undefined;
  return `No new output for ${minutes(quietFor)}. If the command pipes through tail, sort or another `
    + "filter that waits for the end, progress stays hidden until it exits.";
}

/** The last lines of output, bounded for a notification. */
export function outputTail(text: string): { tail: string; lineCount: number } {
  const lines = text.replace(/\n$/, "").split("\n").filter((line, index, all) => line || index < all.length - 1);
  let tail = lines.slice(-COMPLETION_TAIL_LINES).join("\n");
  if (Buffer.byteLength(tail) > COMPLETION_TAIL_BYTES) {
    tail = `…${Buffer.from(tail).subarray(-COMPLETION_TAIL_BYTES).toString("utf8").replace(/^\uFFFD+/, "")}`;
  }
  return { tail, lineCount: text.trim() ? lines.length : 0 };
}

/** The message attached to a job's completion notification. */
export function completionMessage(result: JobResult, outputText: string): string {
  const { tail, lineCount } = outputTail(outputText);
  const status = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.exitCode}`;
  const hint = completionHint(result, lineCount);
  return [
    status,
    ...(hint ? [hint] : []),
    tail ? `Last lines:\n${tail}` : "No output.",
  ].join("\n");
}

/** Lines of a job's output, optionally filtered, from its start or end. */
export function selectLines(
  text: string,
  options: { lines?: number; from?: "start" | "end"; match?: string },
): { text: string; matched?: number } {
  let lines = text.split("\n");
  let matched: number | undefined;
  if (options.match !== undefined) {
    lines = lines.filter(line => line.includes(options.match!));
    matched = lines.length;
  }
  if (options.lines !== undefined) {
    lines = options.from === "start" ? lines.slice(0, options.lines) : lines.slice(-options.lines);
  }
  return { text: lines.join("\n"), ...(matched === undefined ? {} : { matched }) };
}
