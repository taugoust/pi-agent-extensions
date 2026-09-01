import { homedir } from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { subagentLiveToolStatus, truncateByBytes, usageNumber, usageZero, type SubagentStreamState } from "./subagent-stream.js";
import { normalizeSubagentTerminal, subagentTerminalFailed } from "./subagent-terminal.js";

export function renderSubagentStream(state: SubagentStreamState) {
  let text = state.prefix;
  const appendBlock = (block: string) => {
    if (!block) return;
    if (text && !text.endsWith("\n")) text += "\n";
    text += block;
    if (!text.endsWith("\n")) text += "\n";
  };
  appendBlock(state.liveText);
  appendBlock(subagentLiveToolStatus(state) || "");
  appendBlock(state.rawText);
  const usage = formatSubagentUsage(state.usage, state.model);
  if (usage) appendBlock(`[${usage}]`);
  return text.trimEnd();
}

function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatSubagentUsage(usage: any, model?: string): string {
  const parts: string[] = [];
  const contextTokens = usageNumber(usage?.contextTokens);
  const contextWindow = usageNumber(usage?.contextWindow);
  if (usage?.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage?.input) parts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage?.output) parts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage?.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage?.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  if (usage?.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (contextTokens && contextWindow) {
    const pct = Math.min(999, Math.round((contextTokens / contextWindow) * 100));
    parts.push(`ctx:${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)} (${pct}%)`);
  } else if (contextTokens) {
    parts.push(`ctx:${formatTokenCount(contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function subagentFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) if (part?.type === "text") return String(part.text || "");
  }
  return "";
}

function subagentDisplayItems(messages: any[]): Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }> {
  const items: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }> = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type === "text") items.push({ type: "text", text: String(part.text || "") });
      else if (part?.type === "toolCall") items.push({ type: "toolCall", name: String(part.name || "unknown"), args: part.arguments || {} });
    }
  }
  return items;
}

function formatSubagentToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  if (toolName === "bash") return themeFg("muted", "$ ") + themeFg("toolOutput", String(args.command || "...").slice(0, 80));
  if (toolName === "read") {
    const path = shortenPath(String(args.path || args.file_path || "..."));
    const lineInfo = args.offset ? `:${args.offset}${args.limit ? `-${Number(args.offset) + Number(args.limit) - 1}` : ""}` : "";
    return themeFg("muted", "read ") + themeFg("accent", path + lineInfo);
  }
  if (toolName === "write") return themeFg("muted", "write ") + themeFg("accent", shortenPath(String(args.path || args.file_path || "...")));
  if (toolName === "edit") return themeFg("muted", "edit ") + themeFg("accent", shortenPath(String(args.path || args.file_path || "...")));
  if (toolName === "ls") return themeFg("muted", "ls ") + themeFg("accent", shortenPath(String(args.path || ".")));
  if (toolName === "find") return themeFg("muted", "find ") + themeFg("accent", String(args.pattern || "*")) + themeFg("dim", ` in ${shortenPath(String(args.path || "."))}`);
  if (toolName === "grep") return themeFg("muted", "grep ") + themeFg("accent", `/${String(args.pattern || "")}/`) + themeFg("dim", ` in ${shortenPath(String(args.path || "."))}`);
  const argsStr = JSON.stringify(args || {});
  return themeFg("accent", toolName) + themeFg("dim", ` ${argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr}`);
}

function completedSubagentToolArgs(tool: any): Record<string, unknown> {
  if (tool?.args && typeof tool.args === "object" && !Array.isArray(tool.args)) return tool.args;
  return tool?.path ? { path: tool.path } : {};
}

export function isSubagentFailure(result: any): boolean {
  const terminal = normalizeSubagentTerminal(result?.terminal, { exitCode: result?.exitCode, stopReason: result?.stopReason, error: result?.errorMessage });
  if (terminal) return subagentTerminalFailed(terminal);
  return result?.exitCode !== -1 && (result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted" || result?.stopReason === "timeout");
}

export function subagentDetailsFailed(details: any): boolean {
  const terminal = normalizeSubagentTerminal(details?.terminal, { exitCode: details?.exitCode, stopReason: details?.stopReason, error: details?.error });
  return subagentTerminalFailed(terminal) || details?.results?.some((child: any) => isSubagentFailure(child)) || Boolean(details?.error);
}

function aggregateSubagentUsage(results: any[]) {
  const total = usageZero();
  for (const r of results) {
    total.input += usageNumber(r?.usage?.input);
    total.output += usageNumber(r?.usage?.output);
    total.cacheRead += usageNumber(r?.usage?.cacheRead);
    total.cacheWrite += usageNumber(r?.usage?.cacheWrite);
    total.cost += usageNumber(r?.usage?.cost);
    total.turns += usageNumber(r?.usage?.turns);
  }
  return total;
}

function subagentResultStatus(result: any): string {
  if (result?.exitCode === -1) return "running";
  const terminal = normalizeSubagentTerminal(result?.terminal, { exitCode: result?.exitCode, stopReason: result?.stopReason, error: result?.errorMessage });
  if (terminal?.state === "timed_out") return "timed out";
  if (terminal?.state === "cancelled") return "cancelled";
  if (terminal?.state === "failed") return "failed";
  if (terminal?.state === "completed") return "completed";
  if (result?.stopReason === "aborted") return "aborted";
  if (result?.stopReason === "timeout") return "timed out";
  if (isSubagentFailure(result)) return "failed";
  return "completed";
}

function subagentLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    return msg.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join("").trim();
  }
  return "";
}

function compactSubagentResultSummary(result: any): string {
  const lines: string[] = [];
  lines.push(`Subagent ${subagentResultStatus(result)}.`);
  if (result?.task) lines.push(`Task: ${result.task}`);
  if (result?.model) lines.push(`Model: ${result.model}`);
  if (result?.tools?.length) lines.push(`Tools: ${result.tools.join(", ")}`);
  const lastAssistant = String(result?.lastAssistantText || subagentLastAssistantText(result?.messages || [])).trim();
  if (lastAssistant) lines.push(`Last assistant text:\n${truncateByBytes(lastAssistant).split("\n").slice(-8).join("\n")}`);
  if (result?.activeTool) lines.push(`Active tool: ${result.activeTool.name} ${JSON.stringify(result.activeTool.args)}`);
  const lastTool = Array.isArray(result?.completedTools) ? result.completedTools.at(-1) : undefined;
  if (lastTool) {
    const summary = formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), (_color, text) => text);
    lines.push(`Last completed tool: ${summary}${lastTool.isError ? " (failed)" : ""}${lastTool.resultPreview ? `\n${lastTool.resultPreview}` : ""}`);
  }
  const stderr = String(result?.stderrTail || result?.stderr || "").trim().split("\n").filter(Boolean).slice(-8).join("\n");
  if (stderr) lines.push(`stderr:\n${stderr}`);
  if (result?.errorMessage) lines.push(`Error: ${result.errorMessage}`);
  if (result?.fullResultPath) lines.push(`Full result: ${result.fullResultPath}`);
  if (result?.artifactError) lines.push(`Result artifact unavailable: ${result.artifactError}`);
  lines.push(`Exit: ${result?.exitCode ?? 0}${result?.stopReason ? ` (${result.stopReason})` : ""}`);
  return truncateByBytes(lines.join("\n"));
}

export function renderSubagentCall(args: any, theme: any) {
  if (args.action && args.draft_id) {
    return new Text(`${theme.fg("toolTitle", theme.bold("subagent draft "))}${theme.fg("accent", String(args.action))}\n  ${theme.fg("dim", String(args.draft_id))}`, 0, 0);
  }
  if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}`, 0, 0);
  if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`, 0, 0);
  const task = String(args.task ?? "...");
  return new Text(`${theme.fg("toolTitle", theme.bold("subagent single"))}\n  ${theme.fg("dim", task.length > 70 ? `${task.slice(0, 70)}...` : task)}`, 0, 0);
}

export function renderSubagentResult(result: any, options: any, theme: any) {
  const details = result.details as any | undefined;
  if (!details?.results?.length) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
  const expanded = Boolean(options?.expanded);
  const mdTheme = getMarkdownTheme();

  const renderDisplayItems = (items: ReturnType<typeof subagentDisplayItems>, limit?: number) => {
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
    for (const item of toShow) {
      if (item.type === "text") {
        const preview = expanded ? truncateByBytes(item.text) : truncateByBytes(item.text).split("\n").slice(0, 3).join("\n");
        text += `${theme.fg("toolOutput", preview)}\n`;
      } else {
        text += `${theme.fg("muted", "→ ") + formatSubagentToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
      }
    }
    return text.trimEnd();
  };

  const renderOneExpanded = (container: Container, r: any, title: string) => {
    const failed = isSubagentFailure(r);
    const icon = failed ? theme.fg("error", "✗") : r.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(title))}`, 0, 0));
    container.addChild(new Text(theme.fg("muted", "Status: ") + theme.fg(failed ? "error" : "dim", `${subagentResultStatus(r)} (exit ${r.exitCode ?? 0})`), 0, 0));
    if (r.task) container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
    if (r.model) container.addChild(new Text(theme.fg("muted", "Model: ") + theme.fg("dim", r.model), 0, 0));
    if (r.tools?.length) container.addChild(new Text(theme.fg("muted", "Tools: ") + theme.fg("dim", r.tools.join(", ")), 0, 0));
    if (r.cwd) container.addChild(new Text(theme.fg("muted", "Cwd: ") + theme.fg("dim", r.cwd), 0, 0));
    if (failed && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
    if (r.activeTool) container.addChild(new Text(theme.fg("muted", "Active tool: ") + formatSubagentToolCall(r.activeTool.name, r.activeTool.args, theme.fg.bind(theme)), 0, 0));
    const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
    if (lastTool) {
      const summary = formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme));
      container.addChild(new Text(theme.fg("muted", "Last completed tool: ") + summary + theme.fg("muted", `${lastTool.isError ? " (failed)" : ""}${lastTool.resultPreview ? `\n${lastTool.resultPreview}` : ""}`), 0, 0));
    }

    for (const item of subagentDisplayItems(r.messages || [])) {
      if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatSubagentToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
    }

    const finalOutput = r.final || subagentFinalOutput(r.messages || []);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (finalOutput) container.addChild(new Markdown(truncateByBytes(finalOutput.trim()), 0, 0, mdTheme));
    else container.addChild(new Text(theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"), 0, 0));
    if (r.fullResultPath) container.addChild(new Text(theme.fg("dim", `Full result: ${r.fullResultPath}`), 0, 0));
    else if (r.artifactError) container.addChild(new Text(theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`), 0, 0));

    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
    if ((r.stderrTail || r.stderr)?.trim()) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg(failed ? "error" : "dim", `stderr:\n${truncateByBytes((r.stderrTail || r.stderr).trim())}`), 0, 0));
    }
  };

  const mode = details.mode || (details.results.length > 1 ? "parallel" : "single");
  if (mode === "single" && details.results.length === 1) {
    const r = details.results[0];
    if (expanded) {
      const container = new Container();
      renderOneExpanded(container, r, r.label || "subagent");
      return container;
    }
    const failed = isSubagentFailure(r);
    const icon = r.exitCode === -1 ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = subagentDisplayItems(r.messages || []);
    let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
    if (failed) text += `\n${theme.fg("error", compactSubagentResultSummary(r).split("\n").slice(0, 14).join("\n"))}`;
    else if (displayItems.length === 0) {
      const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
      const fallback = String(r.final || r.errorMessage || "").trim();
      if (lastTool) text += `\n${theme.fg("muted", "→ ")}${formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme))}`;
      else text += fallback ? `\n${theme.fg("toolOutput", truncateByBytes(fallback).split("\n").slice(0, 8).join("\n"))}` : `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
    } else text += `\n${renderDisplayItems(displayItems, 10)}`;
    if (r.fullResultPath) text += `\n${theme.fg("dim", `Full result: ${r.fullResultPath}`)}`;
    else if (r.artifactError) text += `\n${theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`)}`;
    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
    return new Text(text, 0, 0);
  }

  const running = details.results.filter((r: any) => r.exitCode === -1).length;
  const successCount = details.results.filter((r: any) => r.exitCode !== -1 && !isSubagentFailure(r)).length;
  const failCount = details.results.filter((r: any) => r.exitCode !== -1 && isSubagentFailure(r)).length;
  const icon = running > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
  const noun = mode === "chain" ? "steps" : "tasks";
  const status = running > 0 ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} ${noun}`;

  if (expanded) {
    const container = new Container();
    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`${mode} `))}${theme.fg("accent", status)}`, 0, 0));
    for (const r of details.results) {
      container.addChild(new Spacer(1));
      renderOneExpanded(container, r, mode === "chain" ? `step ${r.step ?? "?"}` : r.label || "subagent");
    }
    const totalUsage = formatSubagentUsage(aggregateSubagentUsage(details.results));
    if (totalUsage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
    }
    return container;
  }

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${mode} `))}${theme.fg("accent", status)}`;
  for (const r of details.results) {
    const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isSubagentFailure(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = subagentDisplayItems(r.messages || []);
    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", mode === "chain" ? `step ${r.step ?? "?"}` : r.label || "subagent")} ${rIcon}`;
    if (isSubagentFailure(r)) text += `\n${theme.fg("error", compactSubagentResultSummary(r).split("\n").slice(0, 10).join("\n"))}`;
    else if (displayItems.length === 0) {
      const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
      const fallback = String(r.final || r.errorMessage || "").trim();
      if (lastTool) text += `\n${theme.fg("muted", "→ ")}${formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme))}`;
      else text += fallback ? `\n${theme.fg("toolOutput", truncateByBytes(fallback).split("\n").slice(0, 5).join("\n"))}` : `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
    } else text += `\n${renderDisplayItems(displayItems, 5)}`;
    if (r.fullResultPath) text += `\n${theme.fg("dim", `Full result: ${r.fullResultPath}`)}`;
    else if (r.artifactError) text += `\n${theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`)}`;
    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
  }
  if (running === 0) {
    const totalUsage = formatSubagentUsage(aggregateSubagentUsage(details.results));
    if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
  }
  if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}
