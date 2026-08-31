import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { FetchTransportResult } from "./backend.js";

async function readResponseBounded(response: Response, maximum: number): Promise<{ body: Buffer; length: number; truncated: boolean }> {
  if (!response.body) return { body: Buffer.alloc(0), length: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let retained = 0;
  let observed = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      observed += chunk.length;
      if (retained < maximum) {
        const keep = chunk.subarray(0, Math.max(0, maximum - retained));
        if (keep.length) chunks.push(keep);
        retained += keep.length;
      }
      if (observed > maximum) {
        truncated = true;
        await reader.cancel("maxBodyBytes reached").catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks), length: truncated ? maximum + 1 : observed, truncated };
}

async function safeNativeOutputPath(cwd: string, requested: string): Promise<string> {
  const outputPath = resolve(cwd, requested);
  const lexicalRoot = resolve(tmpdir());
  if (outputPath !== lexicalRoot && !outputPath.startsWith(lexicalRoot + sep)) {
    throw new Error(`Native fetch outputPath is restricted to ${lexicalRoot}${sep}`);
  }
  const root = await realpath(lexicalRoot);
  let ancestor = dirname(outputPath);
  for (;;) {
    try {
      await stat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("No existing outputPath ancestor could be validated");
      ancestor = parent;
    }
  }
  const canonicalAncestor = await realpath(ancestor);
  if (canonicalAncestor !== root && !canonicalAncestor.startsWith(root + sep)) {
    throw new Error(`Native fetch outputPath escapes ${lexicalRoot}${sep} through a symbolic link`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  return outputPath;
}

export async function executeNativeFetch(request: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBodyBytes: number;
  outputPath?: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<FetchTransportResult> {
  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: "follow",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    if (!response.ok) {
      await response.body?.cancel("HTTP error response is not consumed").catch(() => undefined);
      throw new Error(`✗ ${response.status} ${response.statusText}: ${request.url}`);
    }
    const body = await readResponseBounded(response, request.maxBodyBytes);
    let outputPath: string | undefined;
    if (request.outputPath) {
      if (body.truncated) throw new Error(`Response exceeded maxBodyBytes (${request.maxBodyBytes}); output file was not replaced`);
      outputPath = await safeNativeOutputPath(request.cwd, request.outputPath);
      const temporary = join(dirname(outputPath), `.pi-fetch-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
      try {
        await writeFile(temporary, body.body, { flag: "wx", mode: 0o600, signal: controller.signal });
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
        await rename(temporary, outputPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return {
      backend: "native",
      status: response.status,
      statusText: response.statusText,
      headers,
      body: request.outputPath ? Buffer.alloc(0) : body.body,
      bodyLength: body.length,
      truncated: body.truncated,
      effectiveUrl: response.url || request.url,
      outputPath,
    };
  } catch (error) {
    if (request.signal?.aborted) throw error;
    if (timedOut) throw new Error(`✗ Timed out after ${request.timeoutMs}ms: ${request.url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
