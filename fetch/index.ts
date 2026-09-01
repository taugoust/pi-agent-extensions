/**
 * Fetch Tool Extension
 *
 * Provides a native `fetch` tool that the LLM can use to make HTTP requests
 * without relying on bash/curl. Supports GET, POST, PUT, PATCH, DELETE, and
 * HEAD methods with optional headers and body.
 *
 * Features:
 *   - JSON / plain text / HTML response handling
 *   - Configurable timeout (default 30s)
 *   - Response truncation for large payloads (configurable, default 100KB)
 *   - Follows redirects automatically
 *   - Returns status code, headers, and body
 *   - Readability mode for extracting main content from web pages
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { classifyAgentSHStartup } from "../shared/agentsh-mode.js";
import type { AgentSHPiAPI } from "../sandbox/api.js";
import { executeAgentSHFetch, selectFetchBackend } from "./backend.js";
import { executeNativeFetch } from "./native.js";
// Lazy-loaded: gracefully degrades if not installed (bun install)
let Readability: typeof import("@mozilla/readability").Readability | null = null;
let JSDOM: typeof import("jsdom").JSDOM | null = null;

try {
  ({ Readability } = await import("@mozilla/readability"));
  ({ JSDOM } = await import("jsdom"));
} catch {
  // Dependencies not installed — readability mode unavailable, falls back to simple extraction
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB (download / outputPath)
const DEFAULT_MAX_RESPONSE_TEXT = 100 * 1024; // 100KB text returned to LLM
const MIN_READABILITY_CONTENT_LENGTH = 200; // Minimum chars for readability to be considered successful

interface FetchDetails {
  backend: "native" | "agentsh";
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyLength: number;
  truncated: boolean;
  curlCommand: string;
  outputPath?: string;
  textOnly?: boolean;
  readability?: boolean;
  readabilityMethod?: "mozilla" | "simple" | "failed";
  readabilityWarning?: string;
  effectiveUrl?: string;
}

/** Escape a string for safe use inside single quotes in shell. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert fetch parameters to an equivalent curl command.
 * Uses multi-line format with backslash continuations when there are options.
 */
function toCurl(params: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  outputPath?: string;
}): string {
  const parts: string[] = ["curl"];

  if (params.method === "HEAD") {
    parts.push("-I");
  } else if (params.method !== "GET") {
    parts.push("-X", params.method);
  }

  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      parts.push("-H", shellQuote(`${key}: ${value}`));
    }
  }

  if (params.body) {
    parts.push("-d", shellQuote(params.body));
  }

  if (params.outputPath) {
    parts.push("-o", shellQuote(params.outputPath));
  }

  parts.push(shellQuote(params.url));

  if (parts.length <= 2) return parts.join(" ");
  return parts[0] + " " + parts.slice(1).join(" \\\n  ");
}

/**
 * Extract main article content from HTML using simple heuristics.
 * Removes navigation, sidebars, headers, footers before processing.
 * Returns extracted HTML (not yet converted to text).
 */
function extractMainContentSimple(html: string): string {
  let processed = html;
  
  // Remove common UI elements that aren't part of the main content
  processed = processed
    // Remove navigation sections
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    // Remove sidebars
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    // Remove page headers (but keep article headers)
    .replace(/<header[^>]*class="[^"]*(?:site|page|navbar|top|global)[^"]*"[\s\S]*?<\/header>/gi, "")
    .replace(/<header[^>]*id="[^"]*(?:site|page|navbar|top|global)[^"]*"[\s\S]*?<\/header>/gi, "")
    // Remove page footers
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    // Remove common sidebar/navigation class patterns
    .replace(/<div[^>]*class="[^"]*(?:sidebar|nav-|navigation|menu|drawer|toc|breadcrumb|td-sidebar)[^"]*"[\s\S]*?<\/div>/gi, "")
    // Remove common id patterns for navigation
    .replace(/<div[^>]*id="[^"]*(?:sidebar|navigation|nav-|menu|toc|td-sidebar)[^"]*"[\s\S]*?<\/div>/gi, "")
    // Remove forms (usually search, login, etc.)
    .replace(/<form[\s\S]*?<\/form>/gi, "");
  
  // Try to extract the main content area if it exists
  // Look for <main>, <article>, or common content wrappers
  const mainMatch = processed.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    return mainMatch[1];
  }
  
  const articleMatch = processed.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    return articleMatch[1];
  }
  
  // Look for common content div patterns
  const contentMatch = processed.match(/<div[^>]*(?:class|id)="[^"]*(?:content|main|article|post|entry|td-content)[^"]*"[\s\S]*?>([\s\S]*?)<\/div>/i);
  if (contentMatch) {
    return contentMatch[1];
  }
  
  // If no main content area found, return the processed HTML with UI elements removed
  return processed;
}

/**
 * Extract readable content using Mozilla's Readability algorithm.
 * This is the same algorithm used in Firefox Reader Mode.
 * Returns { content: string, method: string, title?: string } or null on failure.
 */
function extractWithMozillaReadability(html: string, url: string): { 
  content: string; 
  method: "mozilla"; 
  title?: string;
} | null {
  try {
    if (!Readability || !JSDOM) return null;
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    
    if (article && article.textContent && article.textContent.length > MIN_READABILITY_CONTENT_LENGTH) {
      return {
        content: article.textContent,
        method: "mozilla",
        title: article.title,
      };
    }
    return null;
  } catch (error) {
    // If Mozilla Readability fails, return null to try simple extraction
    return null;
  }
}

/**
 * Strip HTML to plain text.
 * Removes scripts, styles, and tags while preserving readable structure.
 */
function stripHtml(html: string): string {
  return (
    html
      // Remove entire script/style/noscript blocks
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // Block elements → newlines (before stripping tags)
      .replace(/<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main|aside|details|summary|figcaption|figure|dl|dt|dd)[\s>][^>]*>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&#(\d+);/gi, (_m, code) =>
        String.fromCharCode(Number(code)),
      )
      // Collapse whitespace within lines
      .replace(/[ \t]+/g, " ")
      // Collapse multiple blank lines into one
      .replace(/\n[ \t]*\n/g, "\n\n")
      // Trim each line
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .trim()
  );
}

function validatedPositiveInteger(value: unknown, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return selected;
}

function validatedHttpUrl(value: string): URL {
  if (Buffer.byteLength(value, "utf8") > 16 * 1024 || /[\0\r\n]/.test(value)) throw new Error("fetch URL exceeds 16 KiB or contains control bytes");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("fetch supports only HTTP and HTTPS URLs");
  return url;
}

function validateRequestData(headers: Record<string, string> | undefined, body: string | undefined) {
  if (body !== undefined && Buffer.byteLength(body, "utf8") > 1024 * 1024) throw new Error("fetch request body must not exceed 1 MiB");
  const entries = Object.entries(headers || {});
  if (entries.length > 100) throw new Error("fetch accepts at most 100 request headers");
  const bytes = entries.reduce((total, [name, value]) => total + Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8"), 0);
  if (bytes > 64 * 1024) throw new Error("fetch request headers must not exceed 64 KiB");
}

function truncateResultText(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const lineTruncated = lines.length > 2000;
  let bounded = lines.slice(0, 2000).join("\n");
  const byteTruncated = Buffer.byteLength(bounded, "utf8") > 50 * 1024;
  if (byteTruncated) bounded = Buffer.from(bounded, "utf8").subarray(0, 50 * 1024 - 64).toString("utf8").replace(/\uFFFD+$/g, "");
  const truncated = lineTruncated || byteTruncated;
  return { text: truncated ? `${bounded}\n[Result truncated to Pi's 50 KiB/2000-line limit]` : bounded, truncated };
}

function agentSHAPI(): AgentSHPiAPI | undefined {
  return (globalThis as { __AGENTSH_PI__?: AgentSHPiAPI }).__AGENTSH_PI__;
}

export default function fetchExtension(pi: ExtensionAPI) {
  const agentSHStartup = classifyAgentSHStartup(process.env);

  pi.registerTool({
    name: "fetch",
    label: "Fetch",
    description:
      "Make an HTTP request to a URL. Use this for fetching web pages, calling APIs, downloading text content, etc. " +
      "Do NOT use bash/curl — use this tool instead for all HTTP requests.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal("GET"),
            Type.Literal("POST"),
            Type.Literal("PUT"),
            Type.Literal("PATCH"),
            Type.Literal("DELETE"),
            Type.Literal("HEAD"),
          ],
          { description: "HTTP method (default: GET)" },
        ),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Request headers as key-value pairs",
        }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "Request body (for POST/PUT/PATCH). Sent as-is. Set Content-Type header accordingly.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
        }),
      ),
      maxBodyBytes: Type.Optional(
        Type.Number({
          description: `Maximum response body size in bytes before truncation (default: ${DEFAULT_MAX_BODY_BYTES})`,
        }),
      ),
      outputPath: Type.Optional(
        Type.String({
          description:
            "Save response body to this file path instead of returning it. " +
            "Useful for binary downloads (images, archives, etc.). " +
            "Parent directories are created automatically.",
        }),
      ),
      textOnly: Type.Optional(
        Type.Boolean({
          description:
            "Strip HTML tags and return plain text. " +
            "Removes scripts, styles, and markup while preserving readable structure. " +
            "Default: auto-detects from Content-Type (strips text/html, leaves others as-is). " +
            "Set true to force strip, false to force raw.",
        }),
      ),
      readability: Type.Optional(
        Type.Boolean({
          description:
            "Extract main article content only, removing navigation, sidebars, headers, and footers. " +
            "Uses Mozilla Readability (Firefox Reader Mode algorithm) with fallback to simple extraction. " +
            "Best for blogs, articles, and documentation. " +
            "If extraction yields insufficient content, re-fetch with readability=false.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const method = params.method ?? "GET";
      const timeout = validatedPositiveInteger(params.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
      if (timeout > 2_147_483_647) throw new Error("timeoutMs exceeds the supported timer range");
      validateRequestData(params.headers, params.body);
      const maxBody = validatedPositiveInteger(params.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, "maxBodyBytes");
      if (maxBody > 64 * 1024 * 1024) throw new Error("maxBodyBytes must not exceed 64 MiB");
      const url = validatedHttpUrl(params.url).toString();
      const selection = selectFetchBackend(agentSHAPI(), agentSHStartup);
      if (selection.kind === "unavailable") throw new Error(selection.message);

      const transport = selection.kind === "agentsh"
        ? await executeAgentSHFetch(selection.api, {
            url,
            method,
            headers: params.headers,
            body: params.body,
            timeoutMs: timeout,
            maxBodyBytes: maxBody,
            outputPath: params.outputPath,
            toolCallId,
            signal,
          })
        : await executeNativeFetch({
            url,
            method,
            headers: params.headers,
            body: params.body,
            timeoutMs: timeout,
            maxBodyBytes: maxBody,
            outputPath: params.outputPath,
            cwd: ctx.cwd,
            signal,
          });

      if (transport.status < 200 || transport.status >= 300) {
        throw new Error(`✗ ${transport.status} ${transport.statusText}: ${url}`);
      }

      const curlCommand = toCurl({
        url,
        method,
        headers: params.headers,
        body: params.body,
        outputPath: transport.outputPath,
      });

      if (transport.outputPath) {
        const details: FetchDetails = {
          backend: transport.backend,
          url,
          effectiveUrl: transport.effectiveUrl,
          method,
          status: transport.status,
          statusText: transport.statusText,
          headers: transport.headers,
          bodyLength: transport.bodyLength,
          truncated: false,
          curlCommand,
          outputPath: transport.outputPath,
        };
        return {
          content: [{ type: "text", text: `HTTP ${transport.status} ${transport.statusText}\nSaved ${transport.bodyLength} bytes to ${transport.outputPath}` }],
          details,
        };
      }

      let bodyText = new TextDecoder("utf-8", { fatal: false }).decode(transport.body);
      const contentType = transport.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");
      let readabilityUsed = false;
      let readabilityMethod: "mozilla" | "simple" | "failed" | undefined;
      let readabilityWarning: string | undefined;
      let articleTitle: string | undefined;

      if (params.readability && isHtml) {
        readabilityUsed = true;
        const mozillaResult = extractWithMozillaReadability(bodyText, transport.effectiveUrl || url);
        if (mozillaResult) {
          bodyText = mozillaResult.content;
          readabilityMethod = "mozilla";
          articleTitle = mozillaResult.title;
        } else {
          bodyText = stripHtml(extractMainContentSimple(bodyText));
          readabilityMethod = "simple";
        }
        if (bodyText.length < MIN_READABILITY_CONTENT_LENGTH) {
          readabilityMethod = "failed";
          readabilityWarning = `Readability extraction yielded only ${bodyText.length} chars (minimum: ${MIN_READABILITY_CONTENT_LENGTH}). Re-fetch with readability=false to get full page content.`;
        }
      } else if (params.textOnly === true || (params.textOnly !== false && isHtml)) {
        bodyText = stripHtml(bodyText);
      }

      const textTruncated = bodyText.length > DEFAULT_MAX_RESPONSE_TEXT;
      if (textTruncated) bodyText = bodyText.slice(0, DEFAULT_MAX_RESPONSE_TEXT);
      const truncated = transport.truncated || textTruncated;
      const details: FetchDetails = {
        backend: transport.backend,
        url,
        effectiveUrl: transport.effectiveUrl,
        method,
        status: transport.status,
        statusText: transport.statusText,
        headers: transport.headers,
        bodyLength: transport.bodyLength,
        truncated,
        curlCommand,
        textOnly: !readabilityUsed && (params.textOnly === true || (params.textOnly !== false && isHtml)),
        readability: readabilityUsed,
        readabilityMethod,
        readabilityWarning,
      };
      const lines = [`HTTP ${transport.status} ${transport.statusText}`, ""];
      for (const [key, value] of Object.entries(transport.headers)) lines.push(`${key}: ${value}`);
      lines.push("");
      if (readabilityUsed && articleTitle) lines.push(`Article: ${articleTitle}`, "");
      if (readabilityWarning) lines.push(`⚠️  ${readabilityWarning}`, "");
      if (truncated) lines.push(`[Response truncated. Use outputPath with an appropriate maxBodyBytes value to save a bounded complete response.]`);
      lines.push(bodyText);
      const rendered = truncateResultText(lines.join("\n"));
      if (rendered.truncated) details.truncated = true;
      return { content: [{ type: "text", text: rendered.text }], details };
    },

    renderCall(args, theme) {
      const method = (args.method as string) ?? "GET";
      const url = args.url as string;
      let text = theme.fg("toolTitle", theme.bold("fetch "));
      text += theme.fg("accent", method);
      text += " ";
      text += theme.fg("muted", url);
      if (args.outputPath) {
        text += theme.fg("dim", " → ") + theme.fg("accent", args.outputPath as string);
      }
      if (args.readability) {
        text += theme.fg("accent", " [readability]");
      } else if (args.textOnly) {
        text += theme.fg("dim", " [text]");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as FetchDetails | undefined;
      if (!details || details.status === undefined) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "",
          0,
          0,
        );
      }

      // Collapsed: one-line summary
      if (!options.expanded) {
        // Normal HTTP response
        const statusColor =
          details.status >= 200 && details.status < 300
            ? "success"
            : details.status >= 400
              ? "error"
              : "warning";
        const sizeStr =
          details.bodyLength > 1024
            ? `${(details.bodyLength / 1024).toFixed(1)}KB`
            : `${details.bodyLength}B`;
        let text = theme.fg(statusColor, `${details.status} `);
        text += theme.fg("muted", details.statusText);
        text += theme.fg("dim", ` · ${sizeStr}`);
        if (details.outputPath) {
          text +=
            theme.fg("dim", " → ") +
            theme.fg(statusColor, details.outputPath);
        } else if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        if (details.readability) {
          if (details.readabilityMethod === "failed") {
            text += theme.fg("error", " [readability: failed]");
          } else {
            text += theme.fg("accent", ` [readability: ${details.readabilityMethod}]`);
          }
        } else if (details.textOnly) {
          text += theme.fg("dim", " [text]");
        }
        if (details.readabilityWarning) {
          text += theme.fg("warning", " ⚠️");
        }
        return new Text(text, 0, 0);
      }

      // Expanded: curl equivalent only
      const curlLines = details.curlCommand.split("\n");
      const curlFormatted = curlLines
        .map((line, i) =>
          i === 0
            ? theme.fg("dim", "$ ") + theme.fg("muted", line)
            : theme.fg("dim", "  ") + theme.fg("muted", line),
        )
        .join("\n");

      return new Text(curlFormatted, 0, 0);
    },
  });
}
