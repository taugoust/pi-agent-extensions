import { randomBytes } from "node:crypto";
import { STATUS_CODES } from "node:http";
import {
  agentSHRuntimeDisposition,
  classifyAgentSHStartup,
  type AgentSHRuntimeState,
  type AgentSHStartupClassification,
} from "../shared/agentsh-mode.js";
import type { AgentSHPiAPI } from "../sandbox/api.js";

export type FetchBackendSelection =
  | { kind: "native" }
  | { kind: "agentsh"; api: AgentSHPiAPI }
  | { kind: "unavailable"; message: string };

export type FetchTransportResult = {
  backend: "native" | "agentsh";
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  bodyLength: number;
  truncated: boolean;
  effectiveUrl: string;
  outputPath?: string;
};

export function selectFetchBackend(
  api: AgentSHPiAPI | undefined,
  startup: AgentSHStartupClassification = classifyAgentSHStartup(process.env),
): FetchBackendSelection {
  let state: AgentSHRuntimeState | undefined;
  try {
    state = api && typeof api.getSupervisorState !== "function"
      ? { configured: true, active: false }
      : api?.getSupervisorState?.();
  } catch {
    state = { configured: true, active: false };
  }
  const disposition = agentSHRuntimeDisposition(startup, state);
  const valid = typeof api?.exec === "function" && typeof api?.toSupervisorPath === "function";
  if (disposition.kind === "full" && valid && disposition.protocol !== "mock-ndjson") {
    return { kind: "agentsh", api: api! };
  }
  if (disposition.kind === "native" || disposition.kind === "guard-only") return { kind: "native" };

  const detail = state?.lastError ? `: ${String(state.lastError)}` : state?.status ? ` (${String(state.status)})` : "";
  const protocolDetail = disposition.kind === "full" && disposition.protocol === "mock-ndjson"
    ? " (mock protocol does not provide supervised curl)"
    : "";
  return {
    kind: "unavailable",
    message: `AgentSH is configured but supervised fetch is unavailable${protocolDetail}${detail}; native fallback is disabled`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateHeaders(headers: Record<string, string> | undefined) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid HTTP header: ${name}`);
    }
  }
}

function parseHeaderBlocks(text: string): { status: number; statusText: string; headers: Record<string, string> } {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/).filter((block) => /^HTTP\/\S+\s+\d{3}/i.test(block.trim()));
  const block = blocks.at(-1)?.trim();
  if (!block) throw new Error("AgentSH curl returned no parseable HTTP response headers");
  const lines = block.split("\n");
  const match = lines.shift()!.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw new Error("AgentSH curl returned a malformed HTTP status line");
  const status = Number(match[1]);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status, statusText: match[2]?.trim() || STATUS_CODES[status] || "", headers };
}

export async function executeAgentSHFetch(
  api: AgentSHPiAPI,
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    maxBodyBytes: number;
    outputPath?: string;
    toolCallId: string;
    signal?: AbortSignal;
  },
): Promise<FetchTransportResult> {
  validateHeaders(request.headers);
  const token = `__PI_FETCH_${randomBytes(12).toString("hex")}__`;
  const outputPath = request.outputPath ? api.toSupervisorPath(request.outputPath) : undefined;
  const followsRedirects = request.method === "GET" || request.method === "HEAD" || request.method === "POST";
  const curl: string[] = [
    "curl", "--disable", "--globoff", "--silent", "--show-error",
    ...(followsRedirects ? ["--location", "--max-redirs", "10"] : []),
    "--proto", shellQuote("=http,https"), "--proto-redir", shellQuote("=http,https"),
    ...(request.method === "HEAD" ? ["--head"] : request.method === "GET" || request.method === "POST" ? [] : ["--request", shellQuote(request.method)]),
    "--dump-header", '"$headers_file"',
    "--write-out", '"%output{$meta_file}%{http_code}\\n%{url_effective}\\n"',
  ];
  for (const [name, value] of Object.entries(request.headers || {})) curl.push("--header", shellQuote(`${name}: ${value}`));
  if (request.body !== undefined) {
    if (request.body.includes("\0")) throw new Error("HTTP request body must not contain NUL bytes");
    curl.push("--data-raw", shellQuote(request.body));
  } else if (request.method === "POST") {
    curl.push("--data-raw", shellQuote(""));
  }
  curl.push("--url", shellQuote(request.url));

  const maxPlusOne = request.maxBodyBytes + 1;
  const inlineCap = Math.min(request.maxBodyBytes, 1024 * 1024);
  const transfer = request.method === "HEAD"
    ? `${curl.join(" ")} --output /dev/null 2>"$curl_error"\ncurl_status=$?\n: >"$body_file"`
    : `${curl.join(" ")} 2>"$curl_error" | head -c ${maxPlusOne} >"$body_file"\npipeline_status=("\${PIPESTATUS[@]}")\ncurl_status=\${pipeline_status[0]}\nsink_status=\${pipeline_status[1]}\nif [ "$sink_status" -ne 0 ] && [ "$curl_status" -eq 0 ]; then curl_status=68; fi`;
  const outputSetup = outputPath
    ? `output_path=${shellQuote(outputPath)}\noutput_tmp=${shellQuote(`${outputPath}.pi-fetch.${token}.tmp`)}`
    : "output_path=\noutput_tmp=";
  const publish = outputPath
    ? `if [ "$curl_status" -eq 0 ] && [ "$body_size" -le ${request.maxBodyBytes} ] && printf %s "$http_status" | grep -Eq '^2[0-9][0-9]$'; then
  mkdir -p -- "$(dirname -- "$output_path")"
  : >"$output_tmp"
  chmod 600 "$output_tmp"
  cat -- "$body_file" >"$output_tmp"
  mv -fT -- "$output_tmp" "$output_path"
  output_tmp=
fi`
    : `head -c ${inlineCap} -- "$body_file"`;
  const finalStatus = outputPath
    ? `if [ "$curl_status" -ne 0 ]; then exit "$curl_status"; fi
if [ "$body_size" -gt ${request.maxBodyBytes} ]; then exit 65; fi
if ! printf %s "$http_status" | grep -Eq '^2[0-9][0-9]$'; then exit 66; fi
[ -z "$output_tmp" ] || exit 67`
    : `if [ "$curl_status" -ne 0 ] && ! { [ "$curl_status" -eq 23 ] && [ "$body_size" -gt ${request.maxBodyBytes} ]; }; then exit "$curl_status"; fi`;
  const command = `set -euo pipefail
work_dir=$(mktemp -d)
headers_file="$work_dir/headers"
body_file="$work_dir/body"
meta_file="$work_dir/meta"
curl_error="$work_dir/curl-error"
${outputSetup}
cleanup() { [ -z "$output_tmp" ] || rm -f -- "$output_tmp"; rm -rf -- "$work_dir"; }
trap cleanup EXIT INT TERM
set +e
${transfer}
set -e
body_size=$(wc -c <"$body_file" | tr -d ' ')
header_size=$(wc -c <"$headers_file" | tr -d ' ')
http_status=$(sed -n '1p' "$meta_file")
effective_url=$(sed -n '2p' "$meta_file")
if [ "$header_size" -le 65536 ]; then headers_b64=$(base64 <"$headers_file" | tr -d '\\r\\n'); else headers_b64=; fi
effective_b64=$(printf %s "$effective_url" | base64 | tr -d '\\r\\n')
error_b64=$(base64 <"$curl_error" | tr -d '\\r\\n')
printf '\\n%s%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' ${shellQuote(token)} "$curl_status" "$body_size" "$http_status" "$header_size" "$effective_b64" "$headers_b64" "$error_b64" >&2
${publish}
${finalStatus}`;

  const result = await api.exec({
    command,
    timeout_ms: request.timeoutMs,
    actor: { kind: "extension", label: "Pi fetch tool", tool_call_id: request.toolCallId },
  }, { signal: request.signal });
  const stderr = String(result.stderr || "");
  const marker = stderr.lastIndexOf(token);
  if (marker < 0) throw new Error("AgentSH curl response metadata was missing or truncated");
  const metadataLine = stderr.slice(marker + token.length).split(/\r?\n/, 1)[0];
  const fields = metadataLine.split("\t");
  if (fields.length < 7) throw new Error("AgentSH curl response metadata was malformed");
  const curlStatus = Number(fields[0]);
  const bodyLength = Number(fields[1]);
  const reportedStatus = Number(fields[2]);
  const headerSize = Number(fields[3]);
  if (![curlStatus, bodyLength, reportedStatus, headerSize].every(Number.isSafeInteger) || bodyLength < 0 || headerSize < 0) throw new Error("AgentSH curl returned invalid numeric metadata");
  if (headerSize > 65536) throw new Error("AgentSH curl response headers exceeded 64 KiB");
  const effectiveUrl = Buffer.from(fields[4], "base64").toString("utf8");
  const headerText = Buffer.from(fields[5], "base64").toString("utf8");
  const curlError = Buffer.from(fields[6] || "", "base64").toString("utf8").trim();
  const parsed = parseHeaderBlocks(headerText);
  if (parsed.status !== reportedStatus) throw new Error("AgentSH curl status metadata did not match the final response headers");
  const tooLarge = bodyLength > request.maxBodyBytes;
  if (tooLarge && outputPath) throw new Error(`Response exceeded maxBodyBytes (${request.maxBodyBytes}); output file was not replaced`);
  if (curlStatus !== 0 && !(curlStatus === 23 && tooLarge)) {
    throw new Error(`AgentSH curl failed with code ${curlStatus}${curlError ? `: ${curlError.slice(0, 500)}` : ""}`);
  }
  const exitCode = Number(result.exitCode ?? result.exit_code ?? 0);
  const allowedHTTPExit = exitCode === 66 && (parsed.status < 200 || parsed.status >= 300);
  if ((result as any).stderr_truncated === true || (result as any).stderrTruncated === true) throw new Error("AgentSH curl response metadata was truncated");
  if (!outputPath && ((result as any).stdout_truncated === true || (result as any).stdoutTruncated === true)) throw new Error("AgentSH curl response body was truncated by the supervisor");
  if (exitCode !== 0 && !allowedHTTPExit) throw new Error(`AgentSH fetch command failed with exit code ${exitCode}`);
  return {
    backend: "agentsh",
    ...parsed,
    body: outputPath ? Buffer.alloc(0) : Buffer.from(String(result.stdout || "")),
    bodyLength,
    truncated: tooLarge || (!outputPath && bodyLength > inlineCap),
    effectiveUrl,
    outputPath,
  };
}
