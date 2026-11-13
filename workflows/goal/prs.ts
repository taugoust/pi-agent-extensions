import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** A pull or merge request that a goal produced. Its state comes from `forge-pr`. */
export interface GoalPr {
  /** Canonical reference: host/owner/repo#number. */
  ref: string;
  url: string;
  title?: string;
  /** The PR's source branch, used to find the worktree it came from. */
  branch?: string;
  state: "open" | "merged" | "closed";
  ci: "green" | "pending" | "failed" | null;
  checkedAt: number;
}

/** One run of the merge gate for one PR, as shown to the user. */
export interface GoalCheck {
  command: string;
  verdict: PrCheck["verdict"];
  /** Why it didn't pass, for example "CI failed". */
  detail?: string;
  at: number;
}

export interface PrCheck {
  verdict: "ok" | "pending" | "failed" | "closed";
  pr: string;
  state: GoalPr["state"];
  title?: string;
  branch?: string;
  ci?: GoalPr["ci"];
  checks?: Record<string, string>;
}

export interface PrEvent {
  event: string;
  pr?: string;
  [key: string]: unknown;
}

export const MAX_GOAL_PRS = 20;
const CHECK_TIMEOUT_MS = 120_000;
const PR_URL = /^https:\/\/([^/]+)\/(.+?)\/(?:pull|-\/merge_requests)\/(\d+)\/?$/;
const PR_REF = /^([a-z0-9.-]+\.[a-z]{2,})\/([^#\s]+\/[^#\s]+)#(\d+)$/i;

/** The forge-pr executable. Tests point this at a fixture. */
const forgePrBin = () => process.env.PI_FORGE_PR_BIN || "forge-pr";

/** Parse "host/owner/repo#12" or a PR/MR URL into its repository and number. */
export function parsePrRef(input: string): { repo: string; number: number; ref: string } {
  const value = input.trim();
  const match = PR_URL.exec(value) ?? PR_REF.exec(value);
  if (!match) throw new Error("Give the PR as host/owner/repo#number or as its URL");
  const repo = `${match[1].toLowerCase()}/${match[2]}`;
  const number = Number(match[3]);
  return { repo, number, ref: `${repo}#${number}` };
}

/** The exact command line the merge gate runs for a PR. */
export function checkCommand(ref: string, requireGreenCi = true): string[] {
  const { repo, number } = parsePrRef(ref);
  return ["forge-pr", "-R", repo, "check", String(number), ...(requireGreenCi ? ["--ci-green"] : [])];
}

export function gateResult(ref: string, check: PrCheck): GoalCheck {
  const detail = check.verdict === "closed" ? "Closed without merging"
    : check.verdict === "failed" ? "CI failed"
    : check.verdict === "pending" ? (check.ci === "pending" ? "CI running" : "Not merged yet")
    : undefined;
  return { command: checkCommand(ref).join(" "), verdict: check.verdict, ...(detail ? { detail } : {}), at: Date.now() };
}

/** Validate stored gate results. Bad entries are dropped. */
export function normalizeGoalChecks(value: unknown): GoalCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((check): check is GoalCheck => !!check && typeof check === "object"
    && typeof check.command === "string" && check.command.length <= 1024
    && ["ok", "pending", "failed", "closed"].includes(check.verdict)
    && (check.detail === undefined || typeof check.detail === "string")
    && Number.isFinite(check.at)).slice(0, MAX_GOAL_PRS);
}

/** Run `forge-pr check` once. Fails if forge-pr is missing or prints no verdict. */
export function checkPr(ref: string, requireGreenCi: boolean, signal?: AbortSignal): Promise<PrCheck> {
  const args = checkCommand(ref, requireGreenCi).slice(1);
  return new Promise((resolve, reject) => {
    execFile(forgePrBin(), args, { timeout: CHECK_TIMEOUT_MS, signal, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error && !stdout.trim()) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new Error(missing ? "forge-pr is not installed" : `forge-pr check failed: ${stderr.trim() || error.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as PrCheck;
        if (!["ok", "pending", "failed", "closed"].includes(result.verdict)) throw new Error("no verdict");
        resolve(result);
      } catch {
        reject(new Error(`forge-pr check printed no verdict: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

export function prFromCheck(ref: string, check: PrCheck, previous?: GoalPr): GoalPr {
  return {
    ref,
    url: check.pr,
    title: check.title ?? previous?.title,
    branch: check.branch ?? previous?.branch,
    state: check.state,
    ci: check.ci ?? previous?.ci ?? null,
    checkedAt: Date.now(),
  };
}

/** How a watch event changes a PR's stored state, if at all. */
export function applyPrEvent(pr: GoalPr, event: PrEvent): GoalPr | undefined {
  switch (event.event) {
    case "merged": return { ...pr, state: "merged", checkedAt: Date.now() };
    case "closed": return { ...pr, state: "closed", checkedAt: Date.now() };
    case "ci-green": return { ...pr, ci: "green", checkedAt: Date.now() };
    case "ci-failed": return { ...pr, ci: "failed", checkedAt: Date.now() };
    case "push": return { ...pr, ci: "pending", checkedAt: Date.now() };
    default: return undefined;
  }
}

/** Events worth waking the goal for. `watching` and `error` are not. */
export const isWakeEvent = (event: PrEvent) => event.event !== "watching" && event.event !== "error";

/** One `forge-pr watch` process per open PR of a waiting goal. The goal runtime
 * calls `sync` whenever the goal changes, so watchers start and stop with the wait. */
export class PrWatchers {
  private readonly running = new Map<string, ChildProcess>();

  constructor(private readonly onEvent: (ref: string, event: PrEvent) => void) {}

  /** Watch exactly these PRs. */
  sync(refs: readonly string[]) {
    const wanted = new Set(refs);
    for (const [ref, child] of this.running) {
      if (wanted.has(ref)) continue;
      this.running.delete(ref);
      child.kill("SIGTERM");
    }
    for (const ref of wanted) {
      if (!this.running.has(ref)) this.start(ref);
    }
  }

  stopAll() {
    this.sync([]);
  }

  watching(): string[] {
    return [...this.running.keys()];
  }

  private start(ref: string) {
    const { repo, number } = parsePrRef(ref);
    const child = spawn(forgePrBin(), ["-R", repo, "watch", String(number)], { stdio: ["ignore", "pipe", "ignore"] });
    this.running.set(ref, child);
    const forget = () => {
      if (this.running.get(ref) === child) this.running.delete(ref);
    };
    child.on("error", forget);
    child.on("exit", forget);
    createInterface({ input: child.stdout! }).on("line", line => {
      let event: PrEvent;
      try { event = JSON.parse(line); } catch { return; }
      if (this.running.get(ref) === child && event && typeof event.event === "string") this.onEvent(ref, event);
    });
  }
}

/** The PRs a waiting goal should be watching: the open ones. */
export function openPrRefs(prs: readonly GoalPr[] | undefined): string[] {
  return (prs ?? []).filter(pr => pr.state === "open").map(pr => pr.ref);
}

/** Validate PRs loaded from a goal record. Bad entries are dropped. */
export function normalizeGoalPrs(value: unknown): GoalPr[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prs = value.filter((pr): pr is GoalPr => !!pr && typeof pr === "object"
    && typeof pr.ref === "string" && typeof pr.url === "string"
    && ["open", "merged", "closed"].includes(pr.state)
    && (pr.ci === null || ["green", "pending", "failed"].includes(pr.ci))
    && Number.isFinite(pr.checkedAt));
  return prs.slice(0, MAX_GOAL_PRS);
}
