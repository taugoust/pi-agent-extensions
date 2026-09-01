import { posix as posixPath } from "node:path";

type JsonObject = Record<string, unknown>;

type ApprovalActor = {
  kind: "parent" | "subagent" | "tool" | "extension";
  label?: string;
  subagent_id?: string;
  subagent_depth?: number;
  tool_call_id?: string;
  task?: string;
};

export type ApprovalRequest = {
  id: string;
  created_at?: string;
  expires_at?: string;
  session_id?: string;
  command_id?: string;
  kind?: string;
  target?: string;
  rule?: string;
  message?: string;
  actor?: ApprovalActor | JsonObject;
  fields?: Record<string, unknown>;
};

export type ApprovalResolution = {
  decision: "approve" | "deny";
  scope?: "once" | "session";
  reason?: string;
  scope_kind?: string;
  scope_key?: string;
  scope_label?: string;
  scope_operation?: string;
  scope_path?: string;
  scope_rule?: string;
  scope_prefix?: boolean;
};

export type ApprovalChoice = { label: string } & ApprovalResolution;

type ApprovalPresentation = {
  title: string;
  details: string[];
};

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function approvalTitle(a: ApprovalRequest) {
  const kind = a.kind || "approval";
  const target = a.target || a.command_id || a.id;
  return `${kind}: ${target}`;
}

function approvalActor(a: ApprovalRequest): ApprovalRequest["actor"] {
  if (a.actor && typeof a.actor === "object") return a.actor;
  const nested = a.fields?.actor;
  return nested && typeof nested === "object" ? nested as JsonObject : undefined;
}

function formatActor(actor: ApprovalRequest["actor"]) {
  if (!actor || typeof actor !== "object") return undefined;
  const label = stringField(actor.label)?.trim();
  const kind = stringField(actor.kind)?.trim();
  const fromSubagent = Boolean(stringField(actor.subagent_id));
  if (label) return fromSubagent && !/subagent/i.test(label) ? `${label} (subagent)` : label;
  if (fromSubagent) return "subagent";
  return kind && kind !== "actor" ? kind : undefined;
}

function approvalOperation(a: ApprovalRequest) {
  return stringField(a.fields?.operation)?.trim() || stringField(a.fields?.scope_operation)?.trim() || "access";
}

function fileAction(operation: string) {
  switch (operation.toLowerCase()) {
    case "open":
    case "read": return "Read";
    case "stat":
    case "access": return "Inspect metadata for";
    case "list": return "List";
    case "readlink": return "Inspect link target for";
    case "write": return "Write to";
    case "create": return "Create";
    case "mkdir": return "Create directory at";
    case "delete": return "Delete";
    case "rmdir": return "Remove directory";
    case "rename": return "Rename";
    case "link": return "Create link to";
    case "symlink": return "Create symlink at";
    case "chmod": return "Change permissions on";
    case "chown": return "Change ownership of";
    case "mknod": return "Create device at";
    default: return "Access";
  }
}

function fileApprovalSubject(rule: string) {
  const normalized = rule.toLowerCase();
  if (normalized.includes("outside-workspace")) return "this path outside the opened workspace";
  if (normalized.includes("env-file")) return "this protected environment file";
  if (normalized.includes("nix-file")) return "this protected Nix file";
  if (normalized.includes("ssh") && (normalized.includes("key") || normalized.includes("private"))) return "this SSH private material";
  if (normalized.includes("credential") || normalized.includes("cloud")) return "this credential material";
  if (normalized.includes("proc-sensitive")) return "this sensitive process path";
  return "this file";
}

function displayExecutable(command: string) {
  const clean = command.trim();
  if (/^\/nix\/store\/[^/]+\/bin\/[^/]+$/.test(clean)) return posixPath.basename(clean);
  return clean;
}

function commandInvocation(a: ApprovalRequest) {
  const visible = stringField(a.fields?.visible_command)?.trim();
  if (visible) return visible;
  const command = stringField(a.fields?.command)?.trim();
  if (command) {
    let args = Array.isArray(a.fields?.args) ? a.fields.args.filter((value): value is string => typeof value === "string") : [];
    const executable = displayExecutable(command);
    if (args[0] === posixPath.basename(command)) args = args.slice(1);
    const quote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
    return [executable, ...args].map(quote).join(" ");
  }
  const rawOptions = Array.isArray(a.fields?.scope_options) ? a.fields.scope_options : [];
  for (const option of rawOptions) {
    if (!option || typeof option !== "object") continue;
    const obj = option as JsonObject;
    const key = stringField(obj.scope_key)?.trim() || "";
    const label = stringField(obj.scope_label)?.trim();
    if (key.startsWith("command-invocation:") && label) return label;
  }
  return a.target ? displayExecutable(a.target) : a.command_id || a.id;
}

function commandApprovalQuestion(a: ApprovalRequest) {
  let reason = stringField(a.message)?.trim();
  if (!reason || /\{\{[^}]+\}\}|[\r\n]/.test(reason)) return undefined;
  reason = reason
    .replace(/^(?:Pi|Agent|The project) wants to\s+/i, "")
    .replace(/[.?!]+$/, "")
    .trim();
  if (!reason || reason.length > 100) return undefined;
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}?`;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function overlayRuleSummary(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const labels: Record<string, string> = {
    file_rules: "file",
    command_rules: "command",
    network_rules: "network",
    unix_socket_rules: "socket",
    signal_rules: "signal",
    dns_redirects: "DNS redirect",
    connect_redirects: "connect redirect",
    package_rules: "package",
  };
  const parts: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const count = Number((value as JsonObject)[key]);
    if (Number.isSafeInteger(count) && count > 0) parts.push(`${count} ${label}`);
  }
  return parts.length > 0 ? `Rules: ${parts.join(", ")}` : undefined;
}

function networkApprovalTitle(a: ApprovalRequest, target: string) {
  const hint = `${a.rule || ""} ${a.message || ""}`.toLowerCase();
  const port = /^.*:(\d+)$/.exec(target)?.[1];
  if (/private[-_ ]?(?:network|address)|rfc1918/.test(hint)) return "Connect to this private network address?";
  if (/\bssh\b/.test(hint) || port === "22") return "Connect over SSH?";
  if (/\bhttps\b/.test(hint) || port === "443") return "Connect over HTTPS?";
  if (/\bhttp\b/.test(hint) || port === "80") return /insecure/.test(hint) ? "Connect over insecure HTTP?" : "Connect over HTTP?";
  return "Connect to this destination?";
}

function meaningfulApprovalMessage(a: ApprovalRequest, target: string) {
  const kind = (a.kind || "").trim().toLowerCase();
  if (kind === "file" && fileApprovalSubject(a.rule || "") !== "this file") return undefined;
  if (kind === "command" && commandApprovalQuestion(a)) return undefined;
  // Network policy messages normally restate the destination. Their useful
  // context (SSH, HTTPS, private network) is already promoted into the title.
  if (kind === "network") return undefined;
  let message = stringField(a.message)?.trim();
  if (!message) return undefined;
  message = message.replace(/\{\{\s*\.Path\s*\}\}/g, target || "the requested path");
  // AgentSH currently may return unrendered policy templates. Never expose
  // protocol placeholders as decision UI.
  if (/\{\{[^}]+\}\}/.test(message)) return undefined;
  if (target) {
    for (const suffix of [`: ${target}`, ` ${target}`]) {
      if (message.endsWith(suffix)) message = message.slice(0, -suffix.length).trim();
    }
    if (message.includes(target)) return undefined;
  }
  message = message.replace(/^Pi wants to\s+/i, "").trim();
  return message || undefined;
}

export function approvalPresentation(a: ApprovalRequest): ApprovalPresentation {
  const kind = (a.kind || "approval").trim().toLowerCase();
  const fields = a.fields || {};
  const details: string[] = [];
  let title: string;
  let target = a.target || "";

  switch (kind) {
    case "file":
      target = target || stringField(fields.path)?.trim() || "unknown path";
      title = `${fileAction(approvalOperation(a))} ${fileApprovalSubject(a.rule || "")}?`;
      details.push(target);
      break;
    case "command":
      title = commandApprovalQuestion(a) || "Run this command?";
      target = commandInvocation(a);
      details.push(target);
      break;
    case "network":
      title = networkApprovalTitle(a, target);
      details.push(target || "unknown destination");
      break;
    case "dns":
      title = "Resolve this DNS destination?";
      details.push(target || "unknown destination");
      break;
    case "http_service":
      title = "Call this declared HTTP service?";
      details.push(target || "unknown service request");
      break;
    case "policy_overlay": {
      title = "Use project-local policy overlays?";
      details.push(target || stringField(fields.project_root)?.trim() || "unknown project");
      const paths = stringList(fields.overlay_paths);
      const names = stringList(fields.overlay_names);
      const overlays = paths.length > 0 ? paths : names;
      if (overlays.length > 0) details.push(`Overlays: ${overlays.slice(0, 4).join(", ")}${overlays.length > 4 ? ", …" : ""}`);
      const rules = overlayRuleSummary(fields.rule_counts);
      if (rules) details.push(rules);
      break;
    }
    case "package":
      title = "Allow this package operation?";
      details.push(target || "unknown package operation");
      if (Number.isSafeInteger(Number(fields.findings)) && Number(fields.findings) > 0) details.push(`Findings: ${Number(fields.findings)}`);
      break;
    case "skillcheck": {
      title = "Allow this flagged skill?";
      details.push(target || stringField(fields.skill_name)?.trim() || "unknown skill");
      const path = stringField(fields.skill_path)?.trim();
      if (path && path !== target) details.push(path);
      const summary = stringField(fields.summary)?.trim();
      if (summary) details.push(summary);
      const hash = stringField(fields.skill_sha256)?.trim();
      if (hash) details.push(`SHA-256: ${hash.slice(0, 12)}${hash.length > 12 ? "…" : ""}`);
      break;
    }
    default:
      title = `${kind === "approval" ? "Allow this operation" : `Allow this ${kind.replace(/_/g, " ")}`}?`;
      if (target) details.push(target);
      break;
  }

  const message = meaningfulApprovalMessage(a, target);
  if (message && !details.includes(message)) details.push(message);
  const actor = formatActor(approvalActor(a));
  if (actor) details.push(`Requested by ${actor}`);
  return { title, details };
}

function scopeFromObject(value: unknown): ApprovalResolution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const kind = typeof obj.scope_kind === "string" ? obj.scope_kind.trim() : "";
  const key = typeof obj.scope_key === "string" ? obj.scope_key.trim() : "";
  if (!kind || !key) return undefined;
  const commandLifetime = obj.scope_lifetime === "command";
  return {
    decision: "approve",
    scope: commandLifetime ? "once" : "session",
    reason: commandLifetime ? "approved for command invocation in parent Pi" : "approved for session in parent Pi",
    scope_kind: kind,
    scope_key: key,
    scope_label: typeof obj.scope_label === "string" ? obj.scope_label : undefined,
    scope_operation: typeof obj.scope_operation === "string" ? obj.scope_operation : undefined,
    scope_path: typeof obj.scope_path === "string" ? obj.scope_path : undefined,
    scope_rule: typeof obj.scope_rule === "string" ? obj.scope_rule : undefined,
    scope_prefix: typeof obj.scope_prefix === "boolean" ? obj.scope_prefix : undefined,
  };
}

function commandRunScope(option: ApprovalResolution) {
  return option.scope === "once" && option.scope_kind === "command-run" && option.scope_key === "command-run:all-approvals";
}

function commandScopeIsExact(option: ApprovalResolution) {
  return option.scope_kind === "command" && (option.scope_key || "").startsWith("command-invocation:");
}

function sessionScopeOptions(approval: ApprovalRequest): ApprovalResolution[] {
  const fields = approval.fields || {};
  const rawOptions = Array.isArray(fields.scope_options) ? fields.scope_options : [];
  const options = rawOptions.map(scopeFromObject).filter((value): value is ApprovalResolution => Boolean(value));
  const fallback = scopeFromObject(fields);
  if (fallback && !options.some((option) => option.scope_key === fallback.scope_key)) options.unshift(fallback);
  return approval.kind?.trim().toLowerCase() === "command"
    ? options.sort((left, right) => Number(commandScopeIsExact(right)) - Number(commandScopeIsExact(left)))
    : options;
}

function scopePathLabel(path: string, recursive: boolean) {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return recursive ? "/**" : "/*";
  return `${clean}/${recursive ? "**" : "*"}`;
}

function commandScopeExecutable(approval: ApprovalRequest, option: ApprovalResolution) {
  const command = option.scope_path?.trim()
    || stringField(approval.fields?.command)?.trim()
    || (!commandScopeIsExact(option) ? option.scope_label?.trim() : "")
    || approval.target
    || "this executable";
  return displayExecutable(command);
}

function sessionScopeLabel(approval: ApprovalRequest, option: ApprovalResolution, decision: "approve" | "deny") {
  const verb = decision === "approve" ? "Allow" : "Deny";
  const path = option.scope_path?.trim() || "";
  switch (option.scope_kind) {
    case "file": return `${verb} this file for session`;
    case "file-dir": return `${verb} ${scopePathLabel(path, false)} for session (one level)`;
    case "file-tree": return `${verb} ${scopePathLabel(path, true)} for session`;
    case "directory": return `${verb} ${scopePathLabel(path, option.scope_prefix === true)} for session${option.scope_prefix ? "" : " (one level)"}`;
    case "command":
      if (commandScopeIsExact(option)) return `${verb} this exact invocation for session`;
      return `${verb} any ${commandScopeExecutable(approval, option)} invocation for session`;
    case "network": return `${verb} this destination for session`;
    default: return `${verb} for session${option.scope_label ? `: ${option.scope_label}` : ""}`;
  }
}

function sessionDenyOptions(approval: ApprovalRequest, options: ApprovalResolution[]) {
  const kind = approval.kind?.trim().toLowerCase();
  if (kind === "file") return [];
  if (kind === "command") {
    const exact = options.find(commandScopeIsExact);
    return exact ? [exact] : options.slice(0, 1);
  }
  return options;
}

export function approvalChoices(approval: ApprovalRequest): ApprovalChoice[] {
  const approveOnce: ApprovalChoice = { label: "Allow once", decision: "approve", scope: "once", reason: "approved in parent Pi" };
  const denyOnce: ApprovalChoice = { label: "Deny once", decision: "deny", scope: "once", reason: "denied in parent Pi" };
  const options = sessionScopeOptions(approval);
  const commandRun = options.find(commandRunScope);
  const sessionOptions = options.filter((option) => option.scope === "session");
  const networkDestination = sessionOptions.find((option) => option.scope_kind === "network");
  if (approval.kind?.trim().toLowerCase() === "network" && networkDestination) {
    const destination = networkDestination;
    const allForCommand = commandRun || {
      scope: "once" as const,
      scope_kind: "command-run",
      scope_key: "command-run:all-approvals",
      scope_label: "all accesses for this command",
    };
    const choices: ApprovalChoice[] = [
      { ...denyOnce, label: "Deny" },
      approveOnce,
    ];
    if (destination) {
      choices.push({
        ...destination,
        decision: "approve",
        scope: "session",
        reason: `approved for session network destination: ${destination.scope_label || destination.scope_key || approvalTitle(approval)} in parent Pi`,
        label: "Allow for session",
      });
    }
    choices.push({
      ...allForCommand,
      decision: "approve",
      scope: "once",
      reason: "approved all network accesses for this command in parent Pi",
      label: "Allow all accesses for command",
    });
    return choices;
  }
  const choices: ApprovalChoice[] = [denyOnce, approveOnce];
  if (commandRun) {
    choices.push({
      ...commandRun,
      decision: "approve",
      scope: "once",
      reason: "approved all requests for this command invocation in parent Pi",
      label: "Allow all requests for this command invocation",
    });
  }
  for (const option of sessionOptions) {
    const target = option.scope_label || option.scope_key || approvalTitle(approval);
    choices.push({ ...option, decision: "approve", scope: "session", reason: `approved for session ${option.scope_kind || "scope"}: ${target} in parent Pi`, label: sessionScopeLabel(approval, option, "approve") });
  }
  for (const option of sessionDenyOptions(approval, sessionOptions)) {
    const target = option.scope_label || option.scope_key || approvalTitle(approval);
    choices.push({ ...option, decision: "deny", scope: "session", reason: `denied for session ${option.scope_kind || "scope"}: ${target} in parent Pi`, label: sessionScopeLabel(approval, option, "deny") });
  }
  return choices;
}

export function resolveChoice(choices: ApprovalChoice[], choice: string | undefined): ApprovalResolution {
  const selected = choices.find((candidate) => candidate.label === choice);
  return selected || { decision: "deny", scope: "once", reason: "denied in parent Pi" };
}

export function approvalResolutionBody(resolution: ApprovalResolution) {
  return {
    decision: resolution.decision,
    scope: resolution.scope || "once",
    reason: resolution.reason || `${resolution.decision}d in parent Pi`,
    scope_kind: resolution.scope_kind,
    scope_key: resolution.scope_key,
    scope_label: resolution.scope_label,
    scope_operation: resolution.scope_operation,
    scope_path: resolution.scope_path,
    scope_rule: resolution.scope_rule,
    scope_prefix: resolution.scope_prefix,
  };
}
