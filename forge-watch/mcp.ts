import { spawn } from "node:child_process";
import type { ForgeTarget } from "./types.ts";
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ForgeServerConfig = {
  provider: "github" | "gitlab";
  host: string;
  url: string;
  auth?: { command?: string; args?: string[]; env?: string; oauthFile?: string };
  allowedTools?: string[];
  maxPages?: number;
};
export type ForgeMcpConfig = { servers: ForgeServerConfig[]; requestTimeoutMs?: number };
export class ForgeError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) { super(message); this.name = "ForgeError"; this.status=status; this.retryAfterMs=retryAfterMs; }
}
const piEntry = process.env.PI_CODING_AGENT_ENTRY ? pathToFileURL(process.env.PI_CODING_AGENT_ENTRY).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const mcpPackageFile=findPackageJSON("@earendil-works/pi-mcp",fileURLToPath(piEntry));
if(!mcpPackageFile)throw new Error("Public @earendil-works/pi-mcp dependency is unavailable");
const mcpManifest=JSON.parse(await readFile(mcpPackageFile,"utf8"));
const mcpImport=mcpManifest.exports?.["."]?.import;
if(typeof mcpImport!=="string")throw new Error("Public @earendil-works/pi-mcp import export is missing");
const { McpClient, StreamableHttpTransport } = await import(pathToFileURL(resolve(dirname(mcpPackageFile),mcpImport)).href);
const REQUIRED: Record<string, Record<string, Set<string>>> = {
  github: { pull_request_read: new Set(["get", "get_comments", "get_review_comments", "get_reviews", "get_status", "get_check_runs"]) },
  gitlab: { get_merge_request: new Set(["get_merge_request"]) },
};

function credential(auth?: ForgeServerConfig["auth"]): Promise<string | undefined> {
  if (!auth) return Promise.resolve(undefined);
  const sources = [auth.command, auth.env, auth.oauthFile].filter(Boolean);
  if (sources.length !== 1) throw new ForgeError("Configure exactly one trusted credential source");
  if (auth.env) {
    const token = process.env[auth.env];
    if (!token) throw new ForgeError(`Credential environment variable ${auth.env} is unset`);
    return Promise.resolve(token.trim());
  }
  if (auth.oauthFile) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const child = spawn(auth!.command!, auth!.args ?? [], { stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 10_000, env: process.env });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; if (output.length > 16_384) child.kill(); });
    child.on("error", () => reject(new ForgeError("Credential command failed")));
    child.on("close", code => code === 0 && output.trim() ? resolve(output.trim()) : reject(new ForgeError("Credential command returned no credential")));
  });
}

export function createForgeMcpClient(config: ForgeMcpConfig, target: ForgeTarget) {
  const server = config.servers.find(s => s.provider === target.provider && s.host.toLowerCase() === target.host.toLowerCase());
  if (!server) throw new ForgeError(`No trusted MCP server configured for ${target.provider} ${target.host}`);
  const endpoint = new URL(server.url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ForgeError("MCP URL must be a clean HTTPS endpoint explicitly pinned in configuration");
  let client: any;
  let closed = false;
  const ready = (async () => {
    if(server.provider==="gitlab"&&!server.auth?.oauthFile)throw new ForgeError("GitLab requires an explicit OAuth credential file; interactive auth is never started by polling");
    const token = server.provider==="github"?await credential(server.auth):undefined;
    client = new McpClient({ name: "forge-watch", version: "1.0.0" });
    let authProvider;
    if(server.provider==="gitlab") {
      const {createGitLabOAuth}=await import("./auth.mjs");
      authProvider=createGitLabOAuth({file:server.auth!.oauthFile,serverUrl:endpoint.toString()}).authProvider;
    }
    const transport = new StreamableHttpTransport({ url: endpoint.toString(), headers: token ? { Authorization: `Bearer ${token}` } : undefined, authProvider });
    try {
      await timed(client.connect(transport), config.requestTimeoutMs ?? 15_000, "MCP connection timed out");
      const listed = await timed(client.listTools(), config.requestTimeoutMs ?? 15_000, "MCP tool listing timed out");
      const mandatory = REQUIRED[target.provider];
      const allowedTools = server.allowedTools ? new Set(server.allowedTools) : new Set(Object.keys(mandatory));
      const allowed = new Map<string, Set<string>>();
      for (const [name, methods] of Object.entries(mandatory)) {
        const tool = listed.find((item: any) => item.name === name);
        if (!allowedTools.has(name) || !tool) continue;
        const enumMethods = tool.inputSchema?.properties?.method?.enum;
        if (!Array.isArray(enumMethods) || [...methods].some(method => !enumMethods.includes(method))) throw new ForgeError(`MCP tool ${name} lacks required safe method enum`);
        allowed.set(name, methods);
      }
      if (allowed.size !== Object.keys(mandatory).length) throw new ForgeError(`MCP server lacks a required read-only ${target.provider} tool`);
      return { client, allowed, tools: listed };
    } catch (error) { await client.close().catch(() => {}); throw safeError(error); }
  })();
  return {
    async tools() { return (await ready).tools; },
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const state = await ready;
      if (closed) throw new ForgeError("MCP client is closed");
      const method = args.method;
      if (!state.allowed.get(name)?.has(String(method))) throw new ForgeError("MCP operation is not in the read-only method allowlist");
      try {
        const result = await timed(state.client.callTool(name, args, { signal, timeoutMs: config.requestTimeoutMs ?? 15_000 }), config.requestTimeoutMs ?? 15_000, "MCP request timed out");
        if ((result as any).isError) throw new ForgeError("MCP read operation failed");
        return result;
      } catch (error) { throw safeError(error); }
    },
    async close() { closed = true; try { const state = await ready; await state.client.close(); } catch { /* failed connection already closed */ } },
    maxPages: Math.max(1, Math.min(server.maxPages ?? 20, 100)),
  };
}
function timed<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new ForgeError(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function safeError(error: any): ForgeError {
  if (error instanceof ForgeError) return error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const retry = Number(error?.headers?.get?.("retry-after"));
  return new ForgeError(status === 401 ? "Forge MCP authentication required" : status === 429 ? "Forge MCP rate limited" : "Forge MCP request failed", status, Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined);
}
