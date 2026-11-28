// Automatic answers for AgentSH approval requests, tried before the user is asked.
//
// Order: off switch, requests that go to the user, deterministic rules,
// session cache, classifier, user. Any failure hands the request to the user.
// Automatic answers approve once and carry no session scope.
// The classifier design (a forced decision tool, the request marked as
// untrusted data, failures going to the user) follows ideas from
// czottmann/pi-automode (MIT). No code is copied.
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { posix as posixPath } from "node:path";
import { approvalActor, type ApprovalRequest, type ApprovalResolution } from "./approval-model.js";

// ---------------------------------------------------------------------------
// Requests that go to the user without a model call.
// ---------------------------------------------------------------------------

/** Approval kinds that change policy or trust, not single accesses. */
const NEVER_AUTO_KINDS = new Set(["policy_overlay", "skillcheck", "package"]);

/** Kinds the classifier may judge. Anything else goes to the user. */
const CLASSIFIABLE_KINDS = new Set(["command", "file", "network", "dns", "http_service"]);

/** Policy rules about credentials, secrets and private material. */
const SENSITIVE_RULE = /credential|secret|ssh|private|env-file|proc-sensitive/i;

/** Paths that hold credentials or run code later (persistence). */
const PROTECTED_PATHS: RegExp[] = [
  /(^|\/)\.git\/hooks(\/|$)/,
  /(^|\/)\.git\/(.*\/)?config(\.worktree)?$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/fish(\/|$)/,
  /(^|\/)\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|zlogout|login|cshrc|tcshrc)$/,
];

/** Commands that change privileges. Matched by basename. */
const PRIVILEGE_COMMANDS = new Set([
  "sudo",
  "sudoedit",
  "su",
  "doas",
  "pkexec",
  "run0",
  "setpriv",
  "capsh",
  "chsh",
  "chfn",
  "passwd",
  "newgrp",
  "gpasswd",
]);

/** Cloud instance metadata services. */
const METADATA_DESTINATIONS = [
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.azure.com",
];

type JsonObject = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function argsOf(approval: ApprovalRequest) {
  const args = approval.fields?.args;
  return Array.isArray(args) ? args.filter((v): v is string => typeof v === "string") : [];
}

function approvalPath(approval: ApprovalRequest) {
  return text(approval.fields?.path) || text(approval.target);
}

/** Why a request must go to the user without a model call, if it must. */
export function neverAutoReason(approval: ApprovalRequest): string | undefined {
  const kind = (approval.kind || "").trim().toLowerCase();
  const rule = (approval.rule || "").trim();
  if (rule.toLowerCase().startsWith("base-")) return `base policy rule ${rule}`;
  if (NEVER_AUTO_KINDS.has(kind)) return `${kind} approvals go to the user`;
  if (!CLASSIFIABLE_KINDS.has(kind)) return `unsupported approval kind ${kind || "(none)"}`;
  if (SENSITIVE_RULE.test(rule)) return `sensitive rule ${rule}`;

  // Command words: the executable, its arguments and the displayed command line.
  const words =
    kind === "command"
      ? [approval.target, text(approval.fields?.command), ...argsOf(approval)]
          .filter((v): v is string => typeof v === "string")
          .flatMap((v) => v.split(/\s+/))
          .map((v) => v.replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : [];
  const paths =
    kind === "file" ? [approvalPath(approval), text(approval.fields?.scope_path)] : words;
  for (const candidate of paths) {
    if (!candidate) continue;
    const normalized = posixPath.normalize(candidate.replace(/\\/g, "/"));
    if (PROTECTED_PATHS.some((pattern) => pattern.test(normalized)))
      return `protected path ${candidate}`;
  }
  for (const word of words) {
    const base = posixPath.basename(word);
    if (PRIVILEGE_COMMANDS.has(base)) return `privilege escalation command ${base}`;
  }
  const destinations = [
    approval.target,
    approval.fields?.host,
    approval.fields?.domain,
    approval.fields?.url,
    approval.fields?.address,
    ...(kind === "command" ? argsOf(approval) : []),
  ]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  for (const destination of METADATA_DESTINATIONS) {
    if (destinations.some((value) => value.includes(destination)))
      return `cloud metadata endpoint ${destination}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Git worktree discovery. Reads git's own files and runs no commands.
// ---------------------------------------------------------------------------

export type AutoApprovalFs = {
  realpath(path: string): string;
  readFile(path: string): string;
  readdir(path: string): string[];
  kind(path: string): "file" | "directory" | undefined;
};

export const nodeAutoApprovalFs: AutoApprovalFs = {
  realpath: (path) => realpathSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  readdir: (path) => readdirSync(path),
  kind(path) {
    try {
      const stats = statSync(path);
      return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  },
};

function isUnder(path: string, root: string) {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Realpath of an absolute path that may not exist yet: resolve the nearest existing parent. */
export function realpathNearest(fs: AutoApprovalFs, path: string): string | undefined {
  if (!posixPath.isAbsolute(path)) return undefined;
  let current = posixPath.normalize(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return posixPath.join(fs.realpath(current), ...rest.reverse());
    } catch {
      if (current === "/") return undefined;
      rest.push(posixPath.basename(current));
      current = posixPath.dirname(current);
    }
  }
}

export type GitCheckout = {
  /** Working tree root (real path). */
  root: string;
  /** Shared git directory of the repository (real path). */
  commonDir: string;
  /** Name under <commonDir>/worktrees when this is a linked worktree. */
  linkedName?: string;
};

function readGitdirPointer(fs: AutoApprovalFs, file: string): string | undefined {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFile(file));
    if (!match) return undefined;
    return posixPath.resolve(posixPath.dirname(file), match[1].trim());
  } catch {
    return undefined;
  }
}

/** Find the checkout that contains `start` by walking up to a `.git` entry. */
export function findGitCheckout(fs: AutoApprovalFs, start: string): GitCheckout | undefined {
  let current = realpathNearest(fs, start);
  for (let depth = 0; current && depth < 64; depth++) {
    const dotGit = posixPath.join(current, ".git");
    const kind = fs.kind(dotGit);
    if (kind === "directory") return { root: current, commonDir: dotGit };
    if (kind === "file") {
      const pointer = readGitdirPointer(fs, dotGit);
      if (!pointer) return undefined;
      let gitDir: string;
      try {
        gitDir = fs.realpath(pointer);
      } catch {
        return undefined;
      }
      let commonDir = gitDir;
      try {
        commonDir = fs.realpath(
          posixPath.resolve(gitDir, fs.readFile(`${gitDir}/commondir`).trim()),
        );
      } catch {
        return undefined;
      }
      const worktreesDir = posixPath.join(commonDir, "worktrees");
      const linkedName =
        posixPath.dirname(gitDir) === worktreesDir ? posixPath.basename(gitDir) : undefined;
      return linkedName ? { root: current, commonDir, linkedName } : undefined;
    }
    if (current === "/") return undefined;
    current = posixPath.dirname(current);
  }
  return undefined;
}

/** Linked worktrees registered in a repository, verified in both directions. */
export function linkedWorktrees(fs: AutoApprovalFs, commonDir: string) {
  const result: Array<{ name: string; root: string }> = [];
  let names: string[] = [];
  try {
    names = fs.readdir(posixPath.join(commonDir, "worktrees"));
  } catch {
    return result;
  }
  for (const name of names) {
    const adminDir = posixPath.join(commonDir, "worktrees", name);
    try {
      const pointer = fs.readFile(posixPath.join(adminDir, "gitdir")).trim();
      const root = fs.realpath(posixPath.dirname(posixPath.resolve(adminDir, pointer)));
      const back = readGitdirPointer(fs, posixPath.join(root, ".git"));
      if (back && fs.realpath(back) === fs.realpath(adminDir)) result.push({ name, root });
    } catch {
      // Stale or partial worktree entries are ignored.
    }
  }
  return result;
}

/** Files git writes into the shared git dir when a linked worktree commits. */
function commonDirWriteAllowed(rel: string, worktreeNames: Set<string>) {
  if (/^(objects|refs|logs)(\/|$)/.test(rel)) return true;
  if (["packed-refs", "packed-refs.lock", "FETCH_HEAD", "ORIG_HEAD"].includes(rel)) return true;
  const match = /^worktrees\/([^/]+)(\/|$)/.exec(rel);
  return Boolean(match && worktreeNames.has(match[1]));
}

// ---------------------------------------------------------------------------
// Deterministic approvals.
// ---------------------------------------------------------------------------

export type RequesterContext = {
  kind: "parent" | "subagent";
  label?: string;
  /** Real path of the requester's working directory, when known. */
  cwd?: string;
};

export type AutoApprovalContext = {
  /** Real paths of the session workspace roots. */
  workspaceRoots: string[];
  requester: RequesterContext;
  /** Latest user message text in the session (untrusted). */
  latestUserMessage?: string;
};

type RuleApproval = { reason: string; resolution: ApprovalResolution };

function sessionCheckouts(fs: AutoApprovalFs, roots: string[]) {
  const checkouts: GitCheckout[] = [];
  for (const root of roots) {
    const checkout = findGitCheckout(fs, root);
    if (checkout && !checkouts.some((c) => c.root === checkout.root)) checkouts.push(checkout);
  }
  return checkouts;
}

function hasGitSegment(path: string) {
  return path.split("/").includes(".git");
}

/** Approve outside-workspace file access that stays inside the session's own git worktrees. */
export function ruleApproval(
  approval: ApprovalRequest,
  context: AutoApprovalContext,
  fs: AutoApprovalFs = nodeAutoApprovalFs,
): RuleApproval | undefined {
  if ((approval.kind || "").trim().toLowerCase() !== "file") return undefined;
  if (!(approval.rule || "").includes("outside-workspace")) return undefined;
  const raw = approvalPath(approval);
  const path = raw && realpathNearest(fs, raw);
  if (!path) return undefined;
  const once = (reason: string): RuleApproval => ({
    reason,
    resolution: { decision: "approve", scope: "once", reason },
  });

  for (const checkout of sessionCheckouts(fs, context.workspaceRoots)) {
    for (const worktree of linkedWorktrees(fs, checkout.commonDir)) {
      if (!isUnder(path, worktree.root)) continue;
      if (hasGitSegment(path.slice(worktree.root.length))) continue;
      return once(`path is inside linked worktree ${worktree.root} of the session repository`);
    }
    if (checkout.linkedName && isUnder(path, checkout.commonDir)) {
      const names = new Set([checkout.linkedName]);
      const requester = context.requester.cwd && findGitCheckout(fs, context.requester.cwd);
      if (requester?.linkedName && requester.commonDir === checkout.commonDir)
        names.add(requester.linkedName);
      const rel = path.slice(checkout.commonDir.length + 1);
      if (commonDirWriteAllowed(rel, names))
        return once(`git metadata ${rel} of the session's worktree repository`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Classifier contract.
// ---------------------------------------------------------------------------

export type ClassifierRequest = {
  request: {
    kind: string;
    rule?: string;
    target?: string;
    path?: string;
    operation?: string;
    command?: string;
    args?: string[];
    policy_message?: string;
  };
  session_workspace: string[];
  requester: {
    kind: "parent" | "subagent";
    label?: string;
    cwd?: string;
    worktree?: string;
  };
  latest_user_message?: string;
};

export type ClassifierVerdict = {
  decision: "approve" | "ask";
  reason: string;
  model?: string;
  /** Set when no valid decision was produced. Failures are not cached. */
  failure?: "infrastructure" | "malformed";
};

export type ClassifyFn = (
  request: ClassifierRequest,
  options: { signal: AbortSignal; deadline: number },
) => Promise<ClassifierVerdict>;

const USER_MESSAGE_LIMIT = 2000;

export function classifierRequest(
  approval: ApprovalRequest,
  context: AutoApprovalContext,
  fs: AutoApprovalFs = nodeAutoApprovalFs,
): ClassifierRequest {
  const fields = approval.fields || {};
  const args = argsOf(approval);
  const worktree = context.requester.cwd ? findGitCheckout(fs, context.requester.cwd) : undefined;
  const user = context.latestUserMessage?.trim();
  return {
    request: {
      kind: (approval.kind || "").trim(),
      rule: text(approval.rule),
      target: text(approval.target),
      path: text(fields.path),
      operation: text(fields.operation),
      command: text(fields.command),
      args: args.length ? args.slice(0, 64) : undefined,
      policy_message: text(approval.message),
    },
    session_workspace: context.workspaceRoots,
    requester: {
      kind: context.requester.kind,
      label: context.requester.label,
      cwd: context.requester.cwd,
      worktree: worktree?.linkedName
        ? `linked git worktree ${worktree.root} of repository ${posixPath.dirname(worktree.commonDir)}`
        : worktree
          ? `main checkout ${worktree.root}`
          : undefined,
    },
    latest_user_message: user
      ? user.length > USER_MESSAGE_LIMIT
        ? `${user.slice(0, USER_MESSAGE_LIMIT)}…`
        : user
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Decision engine.
// ---------------------------------------------------------------------------

export type AutoSource = "rule" | "cache" | "classifier";

export type AutoDecision =
  | {
      action: "approve";
      source: AutoSource;
      reason: string;
      resolution: ApprovalResolution;
      model?: string;
    }
  | {
      action: "ask";
      source: "disabled" | "never-auto" | AutoSource;
      reason: string;
      model?: string;
    };

type CacheEntry = { decision: "approve" | "ask"; reason: string };

export type AutoApproverOptions = {
  enabled: () => boolean;
  classify?: ClassifyFn;
  /** Time budget for one classifier attempt. */
  attemptTimeoutMs: number;
  /** Number of models the classifier may try (primary plus fallbacks). */
  attempts?: () => number;
  fs?: AutoApprovalFs;
  now?: () => number;
  /** Do not start the classifier this close to the approval's expiry. */
  expirySlackMs?: number;
};

export function requestSignature(approval: ApprovalRequest, requesterCwd?: string) {
  const fields = approval.fields || {};
  return JSON.stringify([
    (approval.kind || "").trim().toLowerCase(),
    approval.rule || "",
    approval.target || "",
    text(fields.path) || "",
    text(fields.operation) || "",
    text(fields.command) || "",
    argsOf(approval),
    requesterCwd || "",
  ]);
}

export function autoApprovalReason(source: AutoSource, reason: string) {
  return `auto-approved in Pi (${source}): ${reason}`;
}

export class AutoApprover {
  readonly #options: AutoApproverOptions;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: AutoApproverOptions) {
    this.#options = options;
  }

  get #fs() {
    return this.#options.fs || nodeAutoApprovalFs;
  }
  #now() {
    return (this.#options.now || Date.now)();
  }

  /** Forget cached answers, e.g. on session switch or reset. */
  clear() {
    this.#cache.clear();
  }

  /** After a user denial Pi asks the user again for this signature. Allow-once is not remembered. */
  recordUserResolution(
    approval: ApprovalRequest,
    context: AutoApprovalContext,
    resolution: ApprovalResolution,
  ) {
    if (resolution.decision !== "deny") return;
    this.#cache.set(requestSignature(approval, context.requester.cwd), {
      decision: "ask",
      reason: "the user denied this request earlier",
    });
  }

  async decide(
    approval: ApprovalRequest,
    context: AutoApprovalContext,
    signal?: AbortSignal,
  ): Promise<AutoDecision> {
    if (!this.#options.enabled())
      return { action: "ask", source: "disabled", reason: "automatic approvals are off" };
    const never = neverAutoReason(approval);
    if (never) return { action: "ask", source: "never-auto", reason: never };

    let rule: RuleApproval | undefined;
    try {
      rule = ruleApproval(approval, context, this.#fs);
    } catch {
      rule = undefined;
    }
    if (rule) return withReason({ action: "approve", source: "rule", ...rule });

    const signature = requestSignature(approval, context.requester.cwd);
    const cached = this.#cache.get(signature);
    if (cached?.decision === "approve")
      return withReason({
        action: "approve",
        source: "cache",
        reason: cached.reason,
        resolution: { decision: "approve", scope: "once" },
      });
    if (cached) return { action: "ask", source: "cache", reason: cached.reason };

    const verdict = await this.#classify(approval, context, signal);
    if (!verdict.failure) this.#cache.set(signature, verdict);
    if (verdict.decision === "approve" && !verdict.failure)
      return withReason({
        action: "approve",
        source: "classifier",
        reason: verdict.reason,
        model: verdict.model,
        resolution: { decision: "approve", scope: "once" },
      });
    return { action: "ask", source: "classifier", reason: verdict.reason, model: verdict.model };
  }

  async #classify(
    approval: ApprovalRequest,
    context: AutoApprovalContext,
    outer?: AbortSignal,
  ): Promise<ClassifierVerdict> {
    const ask = (reason: string, failure: ClassifierVerdict["failure"] = "infrastructure") => ({
      decision: "ask" as const,
      reason,
      failure,
    });
    const classify = this.#options.classify;
    if (!classify) return ask("no classifier is configured");
    const now = this.#now();
    const attempts = Math.max(1, this.#options.attempts?.() ?? 1);
    let deadline = now + this.#options.attemptTimeoutMs * attempts;
    const expires = approval.expires_at ? Date.parse(approval.expires_at) : NaN;
    if (Number.isFinite(expires)) {
      const latest = expires - (this.#options.expirySlackMs ?? 3000);
      if (latest - now < 1000) return ask("the approval expires too soon to classify");
      deadline = Math.min(deadline, latest);
    }

    let request: ClassifierRequest;
    try {
      request = classifierRequest(approval, context, this.#fs);
    } catch (error) {
      return ask(`classifier context failed: ${message(error)}`);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer?.addEventListener("abort", abort, { once: true });
    if (outer?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ClassifierVerdict>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(ask("the classifier timed out"));
      }, deadline - now);
    });
    try {
      const verdict = await Promise.race([
        classify(request, { signal: controller.signal, deadline }).then(validVerdict),
        timeout,
      ]);
      return verdict;
    } catch (error) {
      return ask(`the classifier failed: ${message(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
    }
  }
}

function validVerdict(value: ClassifierVerdict): ClassifierVerdict {
  if (
    !value ||
    (value.decision !== "approve" && value.decision !== "ask") ||
    typeof value.reason !== "string"
  )
    return { decision: "ask", reason: "the classifier returned no decision", failure: "malformed" };
  return value;
}

// Automatic answers approve once with no scope fields. A session scope would
// let AgentSH allow later requests, protected paths included, without asking,
// and it would outlast the off switch and Pi restarts.
function withReason<
  T extends { source: AutoSource; reason: string; resolution: ApprovalResolution },
>(decision: T): T {
  return {
    ...decision,
    resolution: {
      decision: "approve",
      scope: "once",
      reason: autoApprovalReason(decision.source, decision.reason),
    },
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Requester and audit helpers.
// ---------------------------------------------------------------------------

/** Who asked: the parent session or an AgentSH subagent (with its cwd when known). */
export function approvalRequester(
  approval: ApprovalRequest,
  subagentCwds: ReadonlyMap<string, string>,
  parentCwd?: string,
): RequesterContext {
  const actor = approvalActor(approval) as JsonObject | undefined;
  const subagentId = text(actor?.subagent_id);
  if (subagentId)
    return { kind: "subagent", label: text(actor?.label), cwd: subagentCwds.get(subagentId) };
  return { kind: "parent", label: text(actor?.label), cwd: parentCwd };
}

export type AutoDecisionRecord = {
  timestamp: string;
  approval_id: string;
  kind?: string;
  rule?: string;
  target?: string;
  source: string;
  decision: "approve" | "ask";
  reason: string;
  model?: string;
  requester?: string;
};

export function autoDecisionRecord(
  approval: ApprovalRequest,
  decision: AutoDecision,
  requester: RequesterContext,
  now = new Date(),
): AutoDecisionRecord {
  return {
    timestamp: now.toISOString(),
    approval_id: approval.id,
    kind: approval.kind,
    rule: approval.rule,
    target: approval.target || text(approval.fields?.path),
    source: decision.source,
    decision: decision.action,
    reason: decision.reason,
    model: decision.model,
    requester:
      requester.kind === "subagent"
        ? `subagent${requester.label ? ` ${requester.label}` : ""}${requester.cwd ? ` in ${requester.cwd}` : ""}`
        : "parent",
  };
}

/** Append one JSON line. A failed write does not block the approval. */
export function appendAutoDecisionLog(file: string, record: AutoDecisionRecord) {
  try {
    mkdirSync(posixPath.dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort only.
  }
}
