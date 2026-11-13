import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkPr, gateResult, MAX_GOAL_PRS, parsePrRef, prFromCheck, type GoalPr, type PrCheck, type PrEvent } from "./prs.ts";
import type { GoalRuntime, StatusContext } from "./runtime.js";
import { ownedWorktrees } from "../../shared/subagent-worktrees.ts";
import { currentOwnerWorktreeSafety, ownedWorktreeCompletionHost, type CompletionContext } from "../../shared/worktree-completion-host.ts";
import { cleanupCompletedWorktree, markWorktreeComplete } from "../../shared/worktree-completion.ts";

export const GOAL_PR_EVENT_MESSAGE_TYPE = "goal-pr-event";

const DESCRIPTION = [
  "Record a pull or merge request this goal produced, as host/owner/repo#number or its URL.",
  "The goal can only complete once all its PRs are merged with green CI.",
  "While the goal waits, you are woken when a PR gets a review, comment, push, CI result, merge or close.",
  "When a PR merges, the worktree it came from is completed and cleaned up.",
  "Set remove to true to drop a PR recorded by mistake.",
].join(" ");

const describe = (pr: GoalPr) => `${pr.title ? `"${pr.title}" ` : ""}${pr.url}`;

/** The merge gate: every PR merged with green CI. Returns why not, or undefined. */
export async function unmergedPrs(runtime: GoalRuntime, ctx: StatusContext | undefined, signal?: AbortSignal): Promise<string | undefined> {
  const goal = runtime.activeGoal;
  if (!goal?.prs?.length) return undefined;
  const results: Array<{ pr: GoalPr; check: PrCheck }> = [];
  for (const pr of goal.prs) {
    const check = await checkPr(pr.ref, true, signal);
    results.push({ pr: prFromCheck(pr.ref, check, pr), check });
  }
  // Keep what the check saw, so the goal and the UI show current state.
  const current = runtime.activeGoal;
  if (current?.id === goal.id) {
    const checks = results.map(result => gateResult(result.pr.ref, result.check));
    runtime.activeGoal = { ...current, prs: results.map(result => result.pr), checks };
    runtime.persistGoal(runtime.activeGoal);
  }
  for (const { pr } of results) if (pr.state === "merged") await completeMergedWorktree(ctx, pr);

  const closed = results.filter(result => result.check.verdict === "closed");
  if (closed.length) return `${closed.map(result => describe(result.pr)).join(", ")} closed without merging; report the goal blocked with goal_blocked`;
  const waiting = results.filter(result => result.check.verdict !== "ok");
  if (!waiting.length) return undefined;
  const lines = waiting.map(({ pr, check }) => `${describe(pr)}: ${check.state}, CI ${check.ci ?? "unknown"}`);
  return `these PRs are not merged with green CI yet: ${lines.join("; ")}. Wait for them with goal_wait`;
}

/** Complete and clean up the coordinator's worktree that a merged PR came from.
 * Returns what happened, for the wake message. All cleanup safeguards still apply. */
async function completeMergedWorktree(ctx: StatusContext | undefined, pr: GoalPr): Promise<string | undefined> {
  const context = ctx as unknown as CompletionContext | undefined;
  if (!pr.branch || !context?.sessionManager) return undefined;
  try {
    const owner = context.sessionManager.getSessionId();
    const worktree = (await ownedWorktrees(owner)).find(record => record.branch === pr.branch);
    if (!worktree) return undefined;
    const host = ownedWorktreeCompletionHost(context, record => currentOwnerWorktreeSafety(context, record));
    await markWorktreeComplete(host, worktree.taskId, `PR merged: ${pr.url}`);
    const result = await cleanupCompletedWorktree(host, worktree.taskId);
    return result.blockedReason
      ? `Its worktree ${worktree.path} is marked complete, but cleanup is blocked: ${result.blockedReason}`
      : `Its worktree ${worktree.path} is cleaned up.`;
  } catch (error) {
    return `Its worktree could not be completed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function eventSummary(pr: GoalPr, event: PrEvent): string {
  switch (event.event) {
    case "merged": return `${describe(pr)} was merged.`;
    case "closed": return `${describe(pr)} was closed without merging. Report the goal blocked with goal_blocked unless the user wants otherwise.`;
    case "review": return `${describe(pr)} got a review (${String(event.state ?? "unknown")}).`;
    case "comment": return `${describe(pr)} got ${Number(event.new ?? 1)} new comment(s).`;
    case "push": return `${describe(pr)} got a new push.`;
    case "ci-green": return `CI passed on ${describe(pr)}.`;
    case "ci-failed": {
      const nixbot = event.nixbot as { failed_attrs?: string[]; logs?: string } | undefined;
      const attrs = nixbot?.failed_attrs?.length ? ` Failed nixbot attributes: ${nixbot.failed_attrs.join(", ")}. Logs: ${nixbot.logs}.` : "";
      return `CI failed on ${describe(pr)}.${attrs}`;
    }
    default: return `${describe(pr)}: ${event.event}.`;
  }
}

export function registerGoalPrTool(pi: ExtensionAPI, runtime: GoalRuntime) {
  runtime.onPrEvent = (ctx, pr, event) => {
    void (async () => {
      const worktree = event.event === "merged" ? await completeMergedWorktree(ctx, pr) : undefined;
      const content = [eventSummary(pr, event), worktree, "Check the PR with forge (see the forge-pr skill) and continue the goal."]
        .filter(Boolean).join(" ");
      pi.sendMessage({ customType: GOAL_PR_EVENT_MESSAGE_TYPE, content, display: true, details: { ref: pr.ref, event } },
        { deliverAs: "followUp", triggerTurn: true });
    })();
  };

  pi.registerTool(defineTool({
    name: "goal_pr",
    label: "Goal PR",
    executionMode: "sequential",
    description: DESCRIPTION,
    parameters: Type.Object({
      pr: Type.String({ minLength: 1, maxLength: 512, description: "host/owner/repo#number or the PR URL." }),
      remove: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const goal = runtime.activeGoal;
      if (!goal) throw new Error("No current goal");
      const { ref } = parsePrRef(params.pr);
      const prs = goal.prs ?? [];
      if (params.remove) {
        if (!prs.some(pr => pr.ref === ref)) throw new Error(`${ref} is not recorded on this goal`);
        const command = gateResult(ref, { verdict: "pending", pr: "", state: "open" }).command;
        runtime.activeGoal = { ...goal, prs: prs.filter(pr => pr.ref !== ref), checks: goal.checks?.filter(check => check.command !== command) };
        runtime.persistGoal(runtime.activeGoal);
        return { content: [{ type: "text", text: `Removed ${ref} from the goal.` }], details: { prs: runtime.activeGoal.prs } };
      }
      if (prs.length >= MAX_GOAL_PRS && !prs.some(pr => pr.ref === ref)) throw new Error(`A goal can record at most ${MAX_GOAL_PRS} PRs`);
      const previous = prs.find(pr => pr.ref === ref);
      // Run the merge gate right away, so its condition shows before completion is tried.
      const check = await checkPr(ref, true, signal);
      const pr = prFromCheck(ref, check, previous);
      const current = runtime.activeGoal;
      if (current?.id !== goal.id) throw new Error("The goal changed while the PR was being checked");
      const next = previous ? prs.map(candidate => candidate.ref === ref ? pr : candidate) : [...prs, pr];
      const gate = gateResult(ref, check);
      const checks = [...(current.checks ?? []).filter(item => item.command !== gate.command), gate];
      runtime.activeGoal = { ...current, prs: next, checks };
      runtime.persistGoal(runtime.activeGoal);
      return {
        content: [{ type: "text", text: `Recorded ${describe(pr)} (${pr.state}). The goal completes once its PRs are merged with green CI.` }],
        details: { prs: next },
      };
    },
  }));
}
