import { formatSize, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { boundSubagentProgressCapsules, createSubagentProgressCapsule, sanitizeSubagentParentText } from "./subagent-result.js";
import { parseSubagentPiJsonStdout, truncateByBytes, usageNumber, usageZero, type SubagentStreamState } from "./subagent-stream.js";
import { normalizeSubagentTerminal, subagentTerminalFailed } from "./subagent-terminal.js";
import { textFromResult } from "./tool-result-presentation.js";

function stringifyData(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (data === undefined || data === null) return "";
  return String(data);
}

function modelMatches(candidate: any, requested: string) {
  const value = requested.trim();
  if (!value) return false;
  return candidate?.id === value || candidate?.name === value || `${candidate?.provider}/${candidate?.id}` === value || `${candidate?.provider}:${candidate?.id}` === value;
}

export function contextWindowForModel(ctx: ExtensionContext | undefined, model?: string): number {
  const requested = typeof model === "string" ? model.trim() : "";
  if (requested) {
    const allModels = ctx?.modelRegistry?.getAll?.() ?? [];
    const match = allModels.find((candidate: any) => modelMatches(candidate, requested));
    if (typeof match?.contextWindow === "number" && Number.isFinite(match.contextWindow) && match.contextWindow > 0) return match.contextWindow;
  }
  const current = ctx?.model;
  if (!requested || modelMatches(current, requested)) {
    const contextWindow = current?.contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) return contextWindow;
  }
  return 0;
}

export function latestSubagentAssistantMessage(state: SubagentStreamState) {
  return [...state.messages].reverse().find((message) => message.role === "assistant");
}

export function latestSubagentAssistantText(state: SubagentStreamState): string {
  const latestAssistant = latestSubagentAssistantMessage(state);
  return latestAssistant?.content.filter((part) => part.type === "text").map((part) => String(part.text || "")).join("").trim() || "";
}

export function piProtocolFailure(state: SubagentStreamState): { failureKind: "model" | "protocol"; message: string; retryable: boolean } | undefined {
  const hasProtocolEvidence = state.sawPiJsonStdout || state.protocolSettled || Boolean(state.modelStopReason);
  if (!hasProtocolEvidence) return undefined;
  const latestAssistant = latestSubagentAssistantMessage(state);
  const modelStopReason = String(state.modelStopReason || latestAssistant?.stopReason || "").trim();
  const normalizedStopReason = modelStopReason.toLowerCase().replace(/[_-]/g, "");
  if (["error", "aborted", "cancelled", "canceled"].includes(normalizedStopReason)) {
    return { failureKind: "model", message: latestAssistant?.errorMessage || `child model stopped: ${modelStopReason || "error"}`, retryable: false };
  }
  if (!state.protocolSettled) return { failureKind: "protocol", message: "child Pi stream ended before agent_settled", retryable: true };
  if (normalizedStopReason === "tooluse") {
    return { failureKind: "protocol", message: "child Pi settled after a tool-use turn without a final assistant response", retryable: true };
  }
  if (!state.final?.trim() && !latestSubagentAssistantText(state)) {
    return { failureKind: "protocol", message: "child Pi settled without visible final assistant text", retryable: true };
  }
  return undefined;
}

export function subagentParentDetails(result: any, ctx?: ExtensionContext, streamedStates?: Map<string, SubagentStreamState>) {
  const detailResult = (item: any) => {
    const label = stringifyData(item?.label || "subagent") || "subagent";
    const streamed = streamedStates?.get(label);
    const parsed = typeof item?.stdout === "string" ? parseSubagentPiJsonStdout(item.stdout) : undefined;
    const model = item?.model || streamed?.model || parsed?.model;
    const usageCandidates = [streamed?.usage, parsed?.usage, item?.usage].filter((candidate): candidate is any => Boolean(candidate));
    const mostCompleteUsage = usageCandidates.sort((a, b) => usageNumber(b?.turns) - usageNumber(a?.turns))[0] ?? usageZero();
    const usage = { ...mostCompleteUsage };
    usage.contextWindow = usageNumber(item?.context_window ?? item?.contextWindow) || usageNumber(streamed?.usage.contextWindow) || contextWindowForModel(ctx, model);
    const serverDiagnostics = !streamed && Array.isArray(item?.protocol_diagnostics ?? item?.protocolDiagnostics)
      ? (item.protocol_diagnostics ?? item.protocolDiagnostics).map((diagnostic: any) => ({
          kind: stringifyData(diagnostic?.kind || "unknown_event") as any,
          detail: [diagnostic?.event, diagnostic?.bytes ? `${diagnostic.bytes} B` : ""].filter(Boolean).join(": ") || undefined,
        }))
      : [];
    const protocolDiagnostics = [
      ...(streamed?.protocolDiagnostics ?? parsed?.protocolDiagnostics ?? item?.protocolDiagnostics ?? []),
      ...serverDiagnostics,
    ];
    const itemTerminal = normalizeSubagentTerminal(item?.terminal, { exitCode: item?.exit_code ?? item?.exitCode, stopReason: item?.stop_reason ?? item?.stopReason, error: item?.error ?? item?.errorMessage });
    const terminalWasDowngraded = itemTerminal?.state === "completed" && streamed?.terminal?.state === "failed";
    const serverFinal = !terminalWasDowngraded && typeof item?.final === "string" && item.final.trim() ? item.final : undefined;
    return createSubagentProgressCapsule({
      label,
      task: item?.task ?? streamed?.task,
      exitCode: item?.exit_code ?? item?.exitCode ?? streamed?.exitCode,
      stopReason: item?.stop_reason ?? item?.stopReason ?? streamed?.stopReason,
      terminal: streamed?.terminal ?? itemTerminal,
      final: serverFinal ?? (terminalWasDowngraded ? undefined : streamed?.final),
      errorMessage: item?.error ?? item?.errorMessage ?? streamed?.errorMessage,
      stderr: item?.stderr ?? item?.stderrTail ?? streamed?.stderr,
      usage,
      messages: streamed?.messages?.length ? streamed.messages : parsed?.messages ?? item?.messages ?? [],
      model,
      modelStopReason: item?.model_stop_reason ?? item?.modelStopReason ?? streamed?.modelStopReason ?? parsed?.modelStopReason,
      tools: item?.tools ?? streamed?.tools,
      cwd: item?.cwd ?? streamed?.cwd,
      lastToolCall: streamed?.lastToolCall ?? parsed?.lastToolCall ?? item?.activeTool,
      completedTools: streamed?.completedTools?.length ? streamed.completedTools : parsed?.completedTools ?? item?.completedTools ?? [],
      readFiles: streamed?.readFiles?.length ? streamed.readFiles : parsed?.readFiles ?? item?.readFiles ?? [],
      modifiedFiles: streamed?.modifiedFiles?.length ? streamed.modifiedFiles : parsed?.modifiedFiles ?? item?.modifiedFiles ?? [],
      protocolDiagnostics,
      protocolSettled: item?.protocol_settled === true || item?.protocolSettled === true || streamed?.protocolSettled === true || parsed?.protocolSettled === true,
      stdoutTruncated: item?.stdout_truncated === true || item?.stdoutTruncated === true || streamed?.stdoutTruncated === true,
      stdoutTotalBytes: Math.max(usageNumber(item?.stdout_total_bytes ?? item?.stdoutTotalBytes), usageNumber(streamed?.stdoutTotalBytes)),
      compaction: streamed?.compaction ?? parsed?.compaction ?? item?.compaction,
      fullResultPath: item?.full_result_path ?? item?.fullResultPath,
      finalTruncated: item?.final_truncated === true || item?.finalTruncated === true,
      finalTotalBytes: item?.final_total_bytes ?? item?.finalTotalBytes,
      finalInlineBytes: item?.final_inline_bytes ?? item?.finalInlineBytes,
      artifactBytes: item?.artifact_bytes ?? item?.artifactBytes,
      artifactComplete: typeof item?.artifact_complete === "boolean" ? item.artifact_complete : item?.artifactComplete,
      artifactError: item?.artifact_error ?? item?.artifactError,
    });
  };
  const results = boundSubagentProgressCapsules(Array.isArray(result?.results) ? result.results.map(detailResult) : []);
  let terminal = normalizeSubagentTerminal(result?.terminal);
  if (terminal?.state === "completed") {
    const failedChild = results.find((child) => subagentTerminalFailed(child.terminal));
    if (failedChild?.terminal) terminal = { ...failedChild.terminal, message: failedChild.terminal.message || failedChild.errorMessage };
  }
  const serverParentFinal = terminal?.state === "completed" && typeof result?.final === "string" && result.final.trim() ? sanitizeSubagentParentText(result.final, 4 * 1024) : undefined;
  const singleArtifact = results.length === 1 ? results[0] : undefined;
  return {
    mode: result?.mode || (results.length > 1 ? "parallel" : "single"),
    results,
    terminal,
    final: serverParentFinal ?? (results.length === 1 && results[0].terminal?.state === "completed" ? results[0].final ?? results[0].lastAssistantText : undefined),
    summary: typeof result?.summary === "string" ? sanitizeSubagentParentText(result.summary, 4 * 1024) : undefined,
    error: terminal?.message || (typeof result?.error === "string" ? sanitizeSubagentParentText(result.error, 1024) : undefined),
    fullResultPath: singleArtifact?.fullResultPath,
    finalTruncated: singleArtifact?.finalTruncated,
    finalTotalBytes: singleArtifact?.finalTotalBytes,
    artifactBytes: singleArtifact?.artifactBytes,
    artifactComplete: singleArtifact?.artifactComplete,
    artifactError: singleArtifact?.artifactError,
  };
}

function resultLine(result: any) {
  const label = stringifyData(result?.label || "subagent");
  const failed = subagentTerminalFailed(result?.terminal);
  const text = stringifyData(failed
    ? result?.error || result?.errorMessage || result?.terminal?.message || result?.stop_reason || result?.stopReason || result?.final || result?.lastAssistantText || ""
    : result?.final || result?.lastAssistantText || result?.summary || result?.error || result?.errorMessage || result?.terminal?.message || result?.stop_reason || result?.stopReason || "").trim();
  return text ? `[${label}] ${truncateByBytes(text)}` : `[${label}] ${result?.exit_code ?? result?.exitCode ?? "completed"}`;
}

function subagentText(result: any) {
  const direct = textFromResult(result, "").trim();
  if (direct) return direct;
  if (typeof result?.final === "string" && result.final.trim()) return result.final;
  if (typeof result?.summary === "string" && result.summary.trim()) return result.summary;
  if (Array.isArray(result?.results) && result.results.length > 0) return result.results.map(resultLine).join("\n\n");
  return JSON.stringify(subagentParentDetails(result) ?? {}, null, 2);
}

function subagentArtifactHints(result: any): string {
  if (!Array.isArray(result?.results)) return "";
  const hints = result.results.flatMap((child: any) => {
    const label = stringifyData(child?.label || "subagent");
    const path = typeof child?.fullResultPath === "string" ? child.fullResultPath : "";
    if (path) {
      const bytes = usageNumber(child?.artifactBytes);
      const total = usageNumber(child?.finalTotalBytes);
      const completeness = child?.artifactComplete === false && total
        ? ` (${formatSize(bytes)} of ${formatSize(total)} retained)`
        : "";
      return [`Full subagent result [${label}]: ${path}${completeness}`];
    }
    if (typeof child?.artifactError === "string" && child.artifactError) {
      return [`Subagent result artifact unavailable [${label}]: ${child.artifactError}`];
    }
    return [];
  });
  return truncateByBytes(hints.join("\n"), 4 * 1024);
}

export function boundedSubagentParentOutput(result: any): string {
  const inline = truncateByBytes(subagentText(result));
  const artifactHints = subagentArtifactHints(result);
  const terminals = [result?.terminal, ...(Array.isArray(result?.results) ? result.results.map((child: any) => child?.terminal) : [])];
  const sideEffectsUnknown = terminals.some((terminal) => terminal?.sideEffectsMayHaveOccurred === true && terminal?.retryable !== true);
  const safetyHint = sideEffectsUnknown ? "The subagent may have produced side effects and must not be replayed automatically." : "";
  const hints = [artifactHints, safetyHint].filter(Boolean).join("\n");
  return hints ? `${inline}\n\n${hints}` : inline;
}
