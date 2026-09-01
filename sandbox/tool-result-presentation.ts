import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, renderDiff, truncateHead } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";

export function textFromResult(result: any, fallback = "") {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) return result.content.map((item: any) => typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n");
  return fallback;
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function contentFromReadResult(result: any) {
  if (Array.isArray(result?.content)) return result.content;
  if (typeof result?.base64 === "string" && typeof result?.mimeType === "string" && result.mimeType.startsWith("image/")) {
    return [{ type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } }];
  }
  const rawText = textFromResult(result, "");
  const localWindow = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let text = localWindow.content;
  const remotelyTruncated = result?.truncated === true;
  if (remotelyTruncated || localWindow.truncated) {
    const startLine = numericField(result?.start_line) ?? 1;
    const endLine = numericField(result?.end_line) ?? (startLine + localWindow.outputLines - 1);
    const nextOffset = numericField(result?.next_offset) ?? (!localWindow.firstLineExceedsLimit && localWindow.outputLines > 0 ? endLine + 1 : undefined);
    if (nextOffset) {
      const range = endLine >= startLine ? `Showing lines ${startLine}-${endLine}. ` : "";
      text += `\n\n[${range}Use offset=${nextOffset} to continue.]`;
    } else if (result?.byte_truncated === true || localWindow.firstLineExceedsLimit) {
      text += `\n\n[Current line exceeds the ${formatSize(numericField(result?.max_bytes) ?? DEFAULT_MAX_BYTES)} read limit. Use supervised bash with a byte-range command to inspect the remainder.]`;
    }
  }
  return [{ type: "text", text }];
}

type SandboxEditRenderState = {
  callComponent?: Box;
  output?: string;
  isError?: boolean;
};

type SandboxEditRenderContext = {
  args?: any;
  state?: SandboxEditRenderState;
  lastComponent?: Component;
  isError?: boolean;
};

function sandboxEditPath(args: any) {
  return typeof args?.path === "string" && args.path ? args.path : "(unknown path)";
}

function getSandboxEditCallComponent(context: SandboxEditRenderContext | undefined) {
  const state = context?.state;
  if (context?.lastComponent instanceof Box) {
    if (state) state.callComponent = context.lastComponent;
    return context.lastComponent;
  }
  if (state?.callComponent) return state.callComponent;
  const component = new Box(1, 1, (text: string) => text);
  if (state) state.callComponent = component;
  return component;
}

function themeBg(theme: any, color: string, text: string) {
  return typeof theme?.bg === "function" ? theme.bg(color, text) : text;
}

function themeBold(theme: any, text: string) {
  return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

function renderSandboxEditCallInto(component: Box, args: any, theme: any, state?: SandboxEditRenderState) {
  component.setBgFn(
    state?.isError
      ? (text: string) => themeBg(theme, "toolErrorBg", text)
      : state?.output
        ? (text: string) => themeBg(theme, "toolSuccessBg", text)
        : (text: string) => themeBg(theme, "toolPendingBg", text),
  );
  component.clear();
  component.addChild(new Text(`${theme.fg("toolTitle", themeBold(theme, "edit"))} ${theme.fg("accent", sandboxEditPath(args))}`, 0, 0));
  if (state?.output) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(state.output, 0, 0));
  }
  return component;
}

export function renderSandboxEditToolCall(args: any, theme: any, context?: SandboxEditRenderContext) {
  const component = getSandboxEditCallComponent(context);
  return renderSandboxEditCallInto(component, args, theme, context?.state);
}

function formatSandboxEditResult(result: any, args: any, theme: any, isError: boolean | undefined) {
  const details = result?.details && typeof result.details === "object" ? result.details : {};
  const diff = typeof details.diff === "string" && details.diff ? details.diff : typeof result?.details?.patch === "string" ? result.details.patch : typeof result?.diff === "string" ? result.diff : undefined;
  const text = textFromResult(result, "").trim();
  if (isError) return text ? theme.fg("error", text) : undefined;
  if (diff) return renderDiff(diff, { filePath: sandboxEditPath(args) });
  return text ? theme.fg("toolOutput", text) : undefined;
}

export function renderSandboxEditToolResult(result: any, _options: any, theme: any, context?: SandboxEditRenderContext) {
  const state = context?.state;
  const output = formatSandboxEditResult(result, context?.args, theme, context?.isError);
  if (state) {
    state.output = output;
    state.isError = context?.isError;
    if (state.callComponent) renderSandboxEditCallInto(state.callComponent, context?.args, theme, state);
  }
  const component = new Container();
  if (!state && output) {
    const text = textFromResult(result, "").trim();
    component.addChild(new Text(text && !output.includes(text) ? `${theme.fg("toolOutput", text)}\n\n${output}` : output, 0, 0));
  }
  return component;
}
