/**
 * Reusable subagent profile parsing and discovery.
 *
 * Adapted from pi-subagents src/agents/frontmatter.ts, agents.ts,
 * agent-selection.ts, and agent-scope.ts at reviewed commit 3ce6185a.
 * Copyright (c) 2026 Nico Bailon; MIT licensed (see agents/LICENSE).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentProfileSource = "builtin" | "user" | "project";
export type AgentProfileScope = "user" | "project" | "both";
export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  source: AgentProfileSource;
  filePath: string;
}

const MAX_PROFILE_FILES = 256;
const MAX_PROFILE_ENTRIES = 4096;
const MAX_PROFILE_FILE_BYTES = 64 * 1024;
const MAX_PROFILE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** Portable native core tools accepted by profile selection; runtime guards remain authoritative. */
export const PROFILE_SUPPORTED_TOOLS = ["read", "bash", "edit", "write"] as const;
const PROFILE_SUPPORTED_TOOL_SET: ReadonlySet<string> = new Set(PROFILE_SUPPORTED_TOOLS);
const VALID_FIELDS = new Set(["name", "description", "model", "thinking", "tools"]);
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

function fail(file: string, message: string): never {
  throw new Error(`Invalid agent profile '${file}': ${message}`);
}

function foldBlock(value: string): string {
  let out = "";
  let hasContent = false;
  let previousIndented = false;
  let blanks = 0;
  for (const line of value.split("\n")) {
    const current = line.trimEnd();
    if (!current.trim()) { if (hasContent) blanks++; continue; }
    const indented = current.length > current.trimStart().length;
    if (hasContent) out += blanks ? "\n".repeat(blanks + (previousIndented || indented ? 1 : 0)) : previousIndented || indented ? "\n" : " ";
    out += current;
    hasContent = true;
    previousIndented = indented;
    blanks = 0;
  }
  return out.trim();
}

function unquote(value: string, file: string, line: number): string {
  if (value.startsWith("\"") || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || value.at(-1) !== quote) fail(file, `malformed quoted scalar on line ${line}`);
    if (quote === "\"") {
      try { return JSON.parse(value) as string; } catch { fail(file, `malformed quoted scalar on line ${line}`); }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/\s+#/.test(value)) value = value.replace(/\s+#.*$/, "").trimEnd();
  if (/^[&*!]|\s[&*!]\S|\s[|>]/.test(value) || /^(?:null|~|true|false|[-+]?(?:\d|\.\d))\b/i.test(value)) {
    fail(file, `unsupported YAML scalar on line ${line}`);
  }
  return value;
}

/** Adapted from upstream's simple-scalar parser, with strict malformed-input errors. */
function parseProfileMarkdown(content: string, file: string): { fields: Record<string, string | string[]>; body: string } {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) fail(file, "frontmatter must start with --- on the first line");
  const lines = text.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && line === "---");
  if (end < 0) fail(file, "frontmatter closing --- delimiter is missing");
  const front = lines.slice(1, end);
  const fields: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (let i = 0; i < front.length; i++) {
    const line = front[i]!;
    const lineNo = i + 2;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const key = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!key) fail(file, `unsupported or malformed YAML on line ${lineNo}`);
    const field = key[1]!;
    if (!VALID_FIELDS.has(field)) fail(file, `unsupported field '${field}'`);
    if (Object.hasOwn(fields, field)) fail(file, `duplicate field '${field}'`);
    const raw = (key[2] ?? "").trim();
    if (field === "tools") {
      const items: string[] = [];
      if (raw === "" || raw === "|" || raw === "|-" || raw === ">" || raw === ">-") {
        if (raw === "|" || raw === "|-" || raw === ">" || raw === ">-") fail(file, `tools must be a YAML simple-scalar list (line ${lineNo})`);
        while (i + 1 < front.length) {
          const next = front[i + 1]!;
          if (!next.trim() || /^\s*#/.test(next)) { i++; continue; }
          const item = next.match(/^\s+-\s+(.+?)\s*$/);
          if (!item) break;
          i++;
          items.push(unquote(item[1]!, file, i + 2));
        }
      } else {
        if (raw.startsWith("[") || raw.startsWith("{")) fail(file, `tools must use comma-separated or block-list syntax (line ${lineNo})`);
        items.push(...raw.split(",").map((part) => unquote(part.trim(), file, lineNo)));
      }
      fields[field] = items;
      continue;
    }
    if (raw === "|" || raw === "|-" || raw === ">" || raw === ">-") {
      const block: string[] = [];
      while (i + 1 < front.length) {
        const next = front[i + 1]!;
        if (next.trim() && !/^\s/.test(next)) break;
        i++;
        block.push(next.replace(/^ {2}/, ""));
      }
      const value = raw.startsWith(">") ? foldBlock(block.join("\n")) : block.join("\n").replace(/\n+$/, "");
      fields[field] = value;
    } else {
      if (raw === "" || raw.startsWith("[") || raw.startsWith("{") || raw.includes(": ")) fail(file, `expected a scalar value for '${field}' on line ${lineNo}`);
      fields[field] = unquote(raw, file, lineNo);
    }
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { fields, body };
}

function scalar(fields: Record<string, string | string[]>, key: string, file: string, required = false): string | undefined {
  const value = fields[key];
  if (value === undefined) {
    if (required) fail(file, `required '${key}' field is missing`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) fail(file, `'${key}' must be a non-empty scalar string`);
  return value.trim();
}

async function readProfile(filePath: string, canonicalPath: string, source: AgentProfileSource): Promise<{ profile: AgentProfile; size: number }> {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(canonicalPath, flags);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(filePath, "profile path is not a regular file");
    if (stat.size > MAX_PROFILE_FILE_BYTES) fail(filePath, `file exceeds ${MAX_PROFILE_FILE_BYTES} bytes`);
    const bounded = Buffer.alloc(MAX_PROFILE_FILE_BYTES + 1);
    let read = 0;
    while (read < bounded.length) {
      const result = await handle.read(bounded, read, bounded.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read > MAX_PROFILE_FILE_BYTES) fail(filePath, `file exceeds ${MAX_PROFILE_FILE_BYTES} bytes`);
    bytes = bounded.subarray(0, read);
  } finally {
    await handle.close();
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail(filePath, "profile must contain valid UTF-8 text"); }
  const parsed = parseProfileMarkdown(text, filePath);
  const name = scalar(parsed.fields, "name", filePath, true)!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) fail(filePath, `'name' has invalid syntax`);
  const description = scalar(parsed.fields, "description", filePath, true)!;
  if (Buffer.byteLength(description, "utf8") > 512) fail(filePath, `'description' must be 512 bytes or fewer`);
  if (!parsed.body.trim()) fail(filePath, "system prompt body must be non-empty");
  if (Buffer.byteLength(parsed.body, "utf8") > MAX_PROMPT_BYTES) fail(filePath, `system prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  const model = scalar(parsed.fields, "model", filePath);
  if (model && model.length > 512) fail(filePath, `'model' must be 512 characters or fewer`);
  const thinking = scalar(parsed.fields, "thinking", filePath);
  if (thinking && !THINKING_LEVELS.has(thinking)) fail(filePath, `'thinking' must be one of ${[...THINKING_LEVELS].join(", ")}`);
  const toolsValue = parsed.fields.tools;
  const tools = toolsValue as string[] | undefined;
  if (tools?.some((tool) => !TOOL_NAME.test(tool))) fail(filePath, "'tools' contains a malformed tool name");
  return { profile: { name, description, systemPrompt: parsed.body, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(tools !== undefined ? { tools: [...new Set(tools)] } : {}), source, filePath }, size: bytes.byteLength };
}

interface MarkdownCandidate { filePath: string; canonicalPath: string }

async function collectMarkdown(dir: string, projectRoot?: string): Promise<MarkdownCandidate[]> {
  const out: MarkdownCandidate[] = [];
  const seenDirectories = new Set<string>();
  const visit = async (current: string): Promise<void> => {
    let real: string;
    try { real = await fs.realpath(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (projectRoot && real !== projectRoot && !real.startsWith(projectRoot + path.sep)) {
      throw new Error(`Project agent profile directory escapes trusted project root: ${current}`);
    }
    if (seenDirectories.has(real)) return;
    seenDirectories.add(real);
    if (seenDirectories.size > MAX_PROFILE_ENTRIES) throw new Error(`Agent profile scan exceeds ${MAX_PROFILE_ENTRIES} directories in '${dir}'`);
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.length > MAX_PROFILE_ENTRIES) throw new Error(`Agent profile scan exceeds ${MAX_PROFILE_ENTRIES} entries in '${current}'`);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md") && (entry.isFile() || entry.isSymbolicLink())) {
        let canonicalPath: string;
        try { canonicalPath = await fs.realpath(full); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (projectRoot && canonicalPath !== projectRoot && !canonicalPath.startsWith(projectRoot + path.sep)) {
          throw new Error(`Project agent profile file escapes trusted project root: ${full}`);
        }
        out.push({ filePath: full, canonicalPath });
        if (out.length > MAX_PROFILE_FILES) throw new Error(`Agent profile scan exceeds ${MAX_PROFILE_FILES} files in '${dir}'`);
      }
    }
  };
  await visit(dir);
  return out;
}

export async function discoverAgentProfiles(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  scope?: AgentProfileScope;
  builtinDir?: string;
}): Promise<AgentProfile[]> {
  const scope = options.scope ?? "both";
  if (!["user", "project", "both"].includes(scope)) throw new Error(`Invalid agent profile scope '${String(scope)}'`);
  if (scope === "project" && !options.projectTrusted) throw new Error(`agentScope: "project" requires project trust for ${options.cwd}`);
  const layers: Array<{ source: AgentProfileSource; dir: string; projectRoot?: string }> = [];
  const wantUser = scope === "user" || scope === "both";
  const wantProject = scope === "project" || (scope === "both" && options.projectTrusted);
  if (wantUser) {
    layers.push({ source: "builtin", dir: options.builtinDir ?? BUILTIN_DIR });
    layers.push({ source: "user", dir: path.join(options.agentDir, "agents") });
  }
  if (wantProject) {
    const root = path.resolve(options.cwd, ".pi", "agents");
    const projectPath = path.resolve(options.cwd);
    let projectRoot: string;
    try { projectRoot = await fs.realpath(projectPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      projectRoot = projectPath;
    }
    layers.push({ source: "project", dir: root, projectRoot });
  }
  let totalBytes = 0;
  const effective = new Map<string, AgentProfile>();
  for (const layer of layers) {
    const files = await collectMarkdown(layer.dir, layer.projectRoot);
    const layerNames = new Set<string>();
    const found: AgentProfile[] = [];
    for (const file of files) {
      const { profile, size } = await readProfile(file.filePath, file.canonicalPath, layer.source);
      totalBytes += size;
      if (totalBytes > MAX_PROFILE_TOTAL_BYTES) throw new Error(`Agent profile scan exceeds ${MAX_PROFILE_TOTAL_BYTES} bytes`);
      if (layerNames.has(profile.name)) throw new Error(`Duplicate agent profile name '${profile.name}' in ${layer.source} scope (including '${file.filePath}')`);
      layerNames.add(profile.name);
      found.push(profile);
    }
    for (const profile of found) effective.set(profile.name, profile);
  }
  return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentProfileLaunchInput {
  agent?: string;
  agentScope?: AgentProfileScope;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  [key: string]: unknown;
}

/** Resolve a profile as a plain launch-input overlay; runtime authorization remains authoritative. */
export function resolveAgentProfileLaunch<T extends AgentProfileLaunchInput>(
  input: T,
  profiles: readonly AgentProfile[],
  options: { defaultModel: string },
): Omit<T, "agent" | "agentScope"> {
  const { agent, agentScope: _agentScope, ...plain } = input;
  if (agent === undefined) return { ...plain } as Omit<T, "agent" | "agentScope">;
  if (typeof agent !== "string" || !agent.trim()) throw new Error("'agent' must be a non-empty profile name");
  const profile = profiles.find((candidate) => candidate.name === agent.trim());
  if (!profile) throw new Error(`Unknown agent profile '${agent}'`);
  let launchModel: string | undefined;
  if (Object.hasOwn(input, "model")) {
    if (typeof input.model !== "string" || !input.model.trim()) throw new Error("Launch 'model' override must be a non-empty string");
    launchModel = input.model.trim();
  }
  if (Object.hasOwn(input, "systemPrompt") && typeof input.systemPrompt !== "string") {
    throw new Error("Launch 'systemPrompt' override must be a string");
  }
  const base = launchModel ?? profile.model ?? options.defaultModel;
  const suffix = base.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1];
  const model = suffix ? base : profile.thinking ? `${base}:${profile.thinking}` : base;
  const profileTools = profile.tools;
  let tools = input.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || !TOOL_NAME.test(tool))) throw new Error("Launch 'tools' must be an array of valid tool names");
    tools = [...new Set(tools)];
  }
  const selectedTools = [...(profileTools ?? []), ...(tools ?? [])];
  const unsupportedTools = [...new Set(selectedTools.filter((tool) => !PROFILE_SUPPORTED_TOOL_SET.has(tool)))];
  if (unsupportedTools.length) {
    throw new Error(`Agent profile '${profile.name}' selects unsupported native tools: ${unsupportedTools.join(", ")}`);
  }
  if (profileTools !== undefined) {
    if (tools !== undefined) {
      const allowed = new Set(profileTools);
      const widened = tools.filter((tool) => !allowed.has(tool));
      if (widened.length) throw new Error(`Launch tools cannot widen profile '${profile.name}' allowlist: ${widened.join(", ")}`);
    } else tools = [...profileTools];
  }
  const suffixPrompt = typeof input.systemPrompt === "string" && input.systemPrompt.length ? input.systemPrompt : undefined;
  const systemPrompt = suffixPrompt ? `${profile.systemPrompt}\n\n${suffixPrompt}` : profile.systemPrompt;
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_PROMPT_BYTES) throw new Error(`Resolved system prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  return { ...plain, model, systemPrompt, ...(tools !== undefined ? { tools } : {}) } as Omit<T, "agent" | "agentScope">;
}
