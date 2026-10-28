/** Human-facing view of a private native report. Never serialize its session/assistant envelope. */
export function nativeResultReport(report: any, options: {
  reportText: string; diagnostics?: boolean; jobId: string; childId: string; taskId: string;
  attempt: number; state: string; retained?: boolean; error?: string; verification?: any;
  acceptedDelivery?: boolean; verificationWarning?: string;
}): string {
  const scalar = (value: unknown): string => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500) : "unavailable";
  const lines = [options.reportText || (typeof report?.error === "string" ? report.error : "(no visible terminal report)")];
  if (options.retained) lines.push("Worker status unavailable; retained result may be stale.");
  if (options.error) lines.push(`Worker failed: ${scalar(options.error)}`);
  if (options.verificationWarning) lines.push(options.verificationWarning);
  if (options.diagnostics) {
    lines.push([
      "Diagnostics:",
      `Job: ${scalar(options.jobId)}`,
      `Child: ${scalar(options.childId)}`,
      `Task: ${scalar(options.taskId)}`,
      `Attempt: ${scalar(options.attempt)}`,
      `State: ${scalar(options.state)}`,
      `Current verification: ${scalar(options.verification?.status ?? "not-configured")}`,
      `Accepted delivery: ${options.acceptedDelivery === true}`,
      "Retained command evidence: historical only",
      `Assistant stop reason: ${scalar(report?.assistant?.stopReason)}`,
      "Full private report retained in the result artifact; structured verification is available in details.",
    ].join("\n"));
  }
  return lines.join("\n\n");
}
