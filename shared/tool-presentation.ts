/** Display-only projection. Never use these fields as authority or runtime identity. */
const s = "string", n = "number", b = "boolean";
type Schema = "string" | "number" | "nullableNumber" | "boolean" | "searchResults" | readonly [Schema] | { readonly [key: string]: Schema };
const outcome = { state: s, summary: s, reported: b, attempt: n, child: n, acceptance: [{ criterion: s, status: s, evidence: s }], remaining: [s], next_action: s } as const;
const pagination = { job_id: s, child_id: s, child: n, offset: n, bytes: n, total_bytes: n, next_offset: n, diagnostics: b } as const;
const overview = { task_id: s, taskId: s, attempt: n, displayName: s, title: s, name: s, label: s, execution: s, status: s, state: s, outcome: s, task_outcome: outcome, accepted_delivery: b, verification: { status: s }, next_action: s } as const;
const child = { ...overview, child_id: s, child: n, reaped: b, report: s, error: s } as const;
const job = { job_id: s, name: s, status: s, action: s, exit_code: "nullableNumber", signal: s, timed_out: b, observation_only: b, command: s, cwd: s, truncated: b, error: s, reason: s, observation_error: s, tracking_kind: s } as const;
const group = { ...overview, job_id: s, mode: s, background: b, background_subagent: b, children: [child], task_outcomes: [outcome], result_children: [{ child: n, label: s, bytes: n, total_bytes: n, complete: b }] } as const;
const search = { query: s, durationSeconds: n, results: "searchResults" } as const;
const schemas = {
  background_job: { ...job, streams: { available: b, stderr: s }, jobs: [job], watches: [{ label: s, status: s }], watch_id: s, acknowledged_through: n, events: [{ rule: s, kind: s, text: s, status: s }], overflow: b, reaped: b },
  subagent: { ...pagination, tui_subagent: b, background_subagent: b, attempt: n, model: s, task_title: s, stopReason: s, status: s, failed: b, exitCode: n, errorMessage: s, request_id: s, reaped: b, operation: s, presentation: { version: n, tool: s, children: [child], notice: s }, group, groups: [group], jobs: [group], children: [child], task_outcome: outcome, task_outcomes: [outcome], response: s, complete: b, timed_out: b, tasks: [overview], foreground_tasks: [overview] },
  task_outcome: { task_outcome: outcome },
  goal_manage: { presentation: { version: n, tool: s, objective: s } },
  goal_wait: { reason: s, requested_resume_after_ms: n, resume_after_ms: n },
  goal_blocked: { reason: s, evidence: s },
  update_progress: { steps: [{ text: s, status: s }] },
  questionnaire: { questions: [{ id: s, prompt: s }], answers: [{ id: s, label: s }] },
  fetch: {}, notify_parent: {}, goal_complete: {}, sandbox_allow_path: {}, sandbox_allow_read_path: {}, sandbox_allow_domain: {}, sandbox_allow_unix_socket: {},
  edit: { diff: s },
  grep: {}, find: {}, ls: {}, read: {}, write: {}, bash: { exitCode: n },
  web_search: {}, websearch: {}, web_search_exa: {}, brave_web_search: {}, tavily_search: {}, web: {}, "web.run": {},
  paseo_catalog: {},
} as const;
type SearchResult = string | { tool_use_id: string; content: { title: string; url: string }[] } | { title?: string; url: string; snippet?: string; description?: string };
type Infer<T> = T extends "nullableNumber" ? number | null : T extends "searchResults" ? SearchResult[] : T extends "string" ? string : T extends "number" ? number : T extends "boolean" ? boolean : T extends readonly [infer E] ? Infer<E>[] : keyof T extends never ? { [key: string]: never } : { [K in keyof T]?: Infer<T[K]> };
export type ToolPresentation = { [K in keyof typeof schemas]: { version: 1; toolName: K extends SearchTool | "paseo_catalog" ? string : K; result: { content?: { type: "text"; text: string }[]; isError?: boolean; output?: string; stdout?: string; text?: string; message?: string; error?: string; exitCode?: number; code?: number; details?: Infer<(typeof schemas)[K]> } & (K extends SearchTool ? { structuredContent?: Infer<typeof search>; query?: string; durationSeconds?: number; results?: SearchResult[] } : { structuredContent?: { output?: string; exitCode?: number; exit_code?: number; code?: number } }) } }[keyof typeof schemas];
type SearchTool = "web_search" | "websearch" | "web_search_exa" | "brave_web_search" | "tavily_search" | "web" | "web.run";
const searchLeaves = ["web_search", "websearch", "web_search_exa", "brave_web_search", "tavily_search"];
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
// Reviewed public native catalog names, not general namespace/JSON permission.
export const PASEO_PRESENTATION_TOOL_NAMES = ["create_agent","send_agent_prompt","get_agent_status","get_agent_activity","list_agents","update_agent","set_agent_mode","cancel_agent","archive_agent","kill_agent","list_pending_permissions","respond_to_permission","create_workspace","list_hosts","list_workspaces","rename_workspace","archive_workspace","list_workspace_scripts","start_workspace_script","stop_workspace_script","create_terminal","list_terminals","capture_terminal","send_terminal_keys","kill_terminal","create_schedule","create_heartbeat","update_schedule","list_schedules","inspect_schedule","schedule_logs","run_schedule_once","pause_schedule","resume_schedule","delete_schedule","delete_heartbeat","list_providers","list_models","list_profiles","inspect_provider","browser_list_tabs","browser_new_tab","browser_close_tab","browser_navigate","browser_back","browser_forward","browser_reload","browser_snapshot","browser_screenshot","browser_click","browser_hover","browser_drag","browser_fill","browser_select","browser_type","browser_keypress","browser_upload","browser_wait","browser_scroll","browser_resize","browser_logs","browser_evaluate"] as const;
const paseoNames = new Set<string>(PASEO_PRESENTATION_TOOL_NAMES);
/** Only native-recognized search aliases and exact public Paseo catalog leaves. */
function schemaName(name: string): string {
  const parts = name.toLowerCase().split("__");
  const leaf = parts[parts.length - 1]!;
  if (searchLeaves.includes(leaf)) return leaf;
  const normalized = name.trim().toLowerCase();
  const segments = normalized.split("__").filter(Boolean);
  const paseoLeaf = normalized.includes("__")
    ? segments.length >= 3 && segments[0] === "mcp" && (segments[1] === "paseo" || segments[1]!.startsWith("paseo_")) ? segments.slice(2).join("__") : undefined
    : normalized.includes(".") && (normalized.split(".")[0] === "paseo" || normalized.split(".")[0]!.startsWith("paseo_")) ? normalized.split(".").slice(1).join(".") : undefined;
  return paseoLeaf && paseoNames.has(paseoLeaf) ? "paseo_catalog" : name === "paseo_catalog" ? "" : name;
}
function isSearch(name: string): boolean { return searchLeaves.includes(schemaName(name)) || name === "web" || name === "web.run"; }
/** UTF-8 byte count including replacement encoding for lone UTF-16 surrogates. No host APIs. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
export const TOOL_PRESENTATION_LIMITS = { bytes: 16384, depth: 12, nodes: 1024, array: 64, string: 8192, strings: 256 } as const;
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
function bounded(value: unknown, allowAbsentProperties = false): void {
  let nodes = 0, strings = 0; const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > TOOL_PRESENTATION_LIMITS.nodes || depth > TOOL_PRESENTATION_LIMITS.depth) throw 0;
    if (typeof v === "string") { if (++strings > 256 || utf8ByteLength(v) > 8192) throw 0; return; }
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v || seen.has(v)) throw 0;
    seen.add(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 64 || Reflect.ownKeys(v).length !== v.length + 1) throw 0;
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) throw 0;
        visit(d.value, depth + 1);
      }
    } else {
      if (!record(v)) throw 0;
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw 0;
        visit(key, depth + 1);
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in d) || !d.enumerable) throw 0;
        // Native typed results commonly carry optional own properties set to
        // undefined. JSON transport omits these; mirror that only at extraction.
        if (allowAbsentProperties && d.value === undefined) continue;
        visit(d.value, depth + 1);
      }
    }
    seen.delete(v);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || utf8ByteLength(encoded) > TOOL_PRESENTATION_LIMITS.bytes) throw 0;
}
function project(value: unknown, schema: Schema, strict = false): unknown {
  if (schema === "nullableNumber") { if (value !== null && typeof value !== "number") throw 0; return value; }
  if (schema === "searchResults") {
    if (!Array.isArray(value)) throw 0;
    return value.map(row => {
      if (typeof row === "string") return row;
      if (!record(row)) throw 0;
      if (typeof row.url === "string") return project(row, { title: s, url: s, snippet: s, description: s }, strict);
      if (typeof row.tool_use_id !== "string" || !Array.isArray(row.content) || !row.content.every(hit => record(hit) && typeof hit.title === "string" && typeof hit.url === "string")) throw 0;
      return project(row, { tool_use_id: s, content: [{ title: s, url: s }] }, strict);
    });
  }
  if (typeof schema === "string") { if (typeof value !== schema) throw 0; return value; }
  if (Array.isArray(schema)) { if (!Array.isArray(value)) throw 0; return value.map(v => project(v, schema[0]!, strict)); }
  if (!record(value)) throw 0;
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!strict && v === undefined) continue;
    if (!own(schema, key)) { if (strict) throw 0; continue; }
    result[key] = project(v, (schema as Record<string, Schema>)[key]!, strict);
  }
  return result;
}
function resultSchema(name: keyof typeof schemas): Schema { return { content: [{ type: s, text: s }], isError: b, output: s, stdout: s, text: s, message: s, error: s, exitCode: n, code: n, details: schemas[name], ...(isSearch(name) ? { structuredContent: search, ...search } : { structuredContent: { output: s, exitCode: n, exit_code: n, code: n } }) }; }
/** Extract only genuine typed results; never parse strings or embedded JSON text. */
export function extractToolPresentation(toolName: string, result: unknown): ToolPresentation | undefined {
  try {
    const name = schemaName(toolName);
    if (!own(schemas, name) || !record(result)) return;
    bounded(result, true);
    if (!Array.isArray(result.content) && !record(result.details) && !record(result.structuredContent) && !["output", "stdout", "text", "message", "error"].some(key => typeof result[key] === "string") && !(isSearch(toolName) && Array.isArray(result.results))) return;
    const safe = project(result, resultSchema(name as keyof typeof schemas)) as ToolPresentation["result"];
    if (safe.content?.some(block => block.type !== "text" || typeof block.text !== "string")) return;
    // Catalog metadata has no safe arbitrary structuredContent schema. If it is
    // the only payload, keep the original text fallback rather than suppress it.
    if (name === "paseo_catalog" && !safe.content?.some(block => block.text.length) && ![safe.output,safe.stdout,safe.text,safe.message,safe.error].some(value => typeof value === "string" && value.length)) return;
    const details = safe.details as Record<string, unknown> | undefined;
    if (details?.presentation !== undefined) {
      const presentation = details.presentation as Record<string, unknown>;
      if (presentation.version !== 1 || presentation.tool !== toolName) return;
    }
    const envelope = { version: 1, toolName, result: safe };
    bounded(envelope); return envelope as ToolPresentation;
  } catch { return; }
}
/** Native Pi history passes only content/details into parseToolResult. The
 * retained message's isError is lifecycle state, not an MCP result field. */
export function extractRetainedToolPresentation(toolName: string, message: unknown): ToolPresentation | undefined {
  try {
    if (!record(message)) return;
    bounded(message, true);
    return extractToolPresentation(toolName, { content: message.content, details: message.details });
  } catch { return; }
}
const searchArguments = { query: s, q: s, search_term: s, queries: [s], search_query: [{ q: s }] } as const;
// Known visible catalog parameters only. Arbitrary settings/labels/headers/env
// objects are deliberately excluded; strict extraction preserves opaque fallback
// rather than dropping unprojected input when catalog fields are unexpected.
const paseoArguments = {
  title:s,agentId:s,provider:s,workspaceId:s,cwd:s,sessionMode:s,modeId:s,newMode:s,thinkingOptionId:s,model:s,
  path:s,name:s,id:s,cron:s,timezone:s,isolation:s,expiresIn:s,expiresAt:s,projectId:s,worktreeSlug:s,branchName:s,baseBranch:s,branch:s,forge:s,
  url:s,ref:s,sourceRef:s,targetRef:s,value:s,text:s,textGone:s,key:s,button:s,function:s,scriptName:s,command:s,terminalId:s,browserId:s,requestId:s,
  prompt:s,initialPrompt:s,message:s,reason:s,behavior:s,decision:s,profile:s,profileId:s,
  prNumber:n,maxRuns:n,maxEntries:n,timeoutMs:n,deltaX:n,deltaY:n,width:n,height:n,limit:n,offset:n,lineStart:n,lineEnd:n,sinceHours:n,waitMs:n,maxDepth:n,
  background:b,notifyOnFinish:b,internal:b,clearExpires:b,doubleClick:b,fullPage:b,force:b,includeArchived:b,interactive:b,
  filePaths:[s],modifiers:[s],values:[s],
} as const;
const argumentSchemas = {
  fetch: { url: s, method: s }, notify_parent: { message: s }, goal_complete: {}, sandbox_allow_path: {}, sandbox_allow_read_path: {}, sandbox_allow_domain: {}, sandbox_allow_unix_socket: {},
  background_job: { action: s, name: s, command: s, cwd: s, job_id: s, signal: s, pane_id: s },
  subagent: { _paseoWorkAgent: b, action: s, operation: s, name: s, task: s, agent: s, background: b, task_id: s, tasks: [{ agent: s, task: s, name: s }], chain: [{ agent: s, task: s, name: s }], message: s, choice: s, ...pagination },
  task_outcome: outcome,
  goal_manage: { action: s, objective: s }, goal_wait: { reason: s }, goal_blocked: { reason: s, evidence: s },
  update_progress: { steps: [{ text: s, status: s }] },
  questionnaire: { questions: [{ id: s, prompt: s }] },
  edit: { path: s, edits: [{ oldText: s, newText: s }], old_string: s, oldString: s, new_string: s, newString: s }, read: { path: s, offset: n, limit: n }, write: { path: s, content: s },
  bash: { command: s, timeout: n },
  grep: { pattern: s, path: s, glob: s }, find: { pattern: s, path: s }, ls: { path: s },
  web_search: searchArguments, websearch: searchArguments, web_search_exa: searchArguments, brave_web_search: searchArguments, tavily_search: searchArguments,
  web: searchArguments, "web.run": searchArguments,
  paseo_catalog: paseoArguments,
} as const;
export type ToolPresentationArguments = { [K in keyof typeof argumentSchemas]: Infer<(typeof argumentSchemas)[K]> }[keyof typeof argumentSchemas];
/** Project genuine retained call arguments only. Never parse displayed argument text. */
export function extractToolPresentationArguments(toolName: string, value: unknown): ToolPresentationArguments | undefined {
  try {
    const name = schemaName(toolName);
    if (!own(argumentSchemas, name) || !record(value)) return;
    bounded(value, true);
    const input = { ...value };
    const nullableOptions: Record<string, readonly string[]> = { read: ["offset", "limit"], bash: ["timeout"], find: ["path", "limit"], grep: ["path", "glob", "ignoreCase", "literal", "context", "limit"], ls: ["path", "limit"] };
    for (const key of nullableOptions[name] ?? []) if (input[key] === null) delete input[key];
    const safe = project(input, argumentSchemas[name as keyof typeof argumentSchemas], name === "paseo_catalog");
    bounded(safe);
    return safe as ToolPresentationArguments;
  } catch { return; }
}
/** Validate arguments against the exact enclosing tool name after outer identity checks. */
export function validateToolPresentationArguments(toolName: string, value: unknown): ToolPresentationArguments | undefined {
  try {
    const name = schemaName(toolName);
    if (!own(argumentSchemas, name)) return;
    bounded(value);
    return project(value, argumentSchemas[name as keyof typeof argumentSchemas], true) as ToolPresentationArguments;
  } catch { return; }
}
/** Strict consumer validation: extra fields are not accepted on the wire. */
export function validateToolPresentation(value: unknown): ToolPresentation | undefined {
  try {
    bounded(value);
    if (!record(value) || value.version !== 1 || typeof value.toolName !== "string" || !own(schemas, schemaName(value.toolName)) || Object.keys(value).some(k => !["version", "toolName", "result"].includes(k))) return;
    project(value.result, resultSchema(schemaName(value.toolName) as keyof typeof schemas), true);
    const extracted = extractToolPresentation(value.toolName, value.result);
    return extracted;
  } catch { return; }
}
