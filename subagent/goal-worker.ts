import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workflows from "../workflows/index.ts";
import progress from "../progress/index.ts";
import { serveGoalWorker, type GoalWorkerIdentity } from "./goal-rpc.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";
import { dirname, join } from "node:path";
import { WORKER_INTERACTIONS_KEY } from "../shared/foreground-tasks.ts";
import { createGoalQuestions, GOAL_QUESTIONS_ENTRY, GOAL_QUESTION_RECORDER_KEY } from "../workflows/goal-questions.ts";
import type { GoalQuestionReply } from "../workflows/goal-story.ts";
import { dedicatedGoalPolicy, sameGoalLimits, type DedicatedGoalPolicy } from "./goal-policy.ts";
import type { createDelegatedChildGoalService } from "../workflows/delegated-child.ts";
import { createWorkerGoalReview, GOAL_REVIEW_ENTRY, GOAL_REVIEW_WORKER_KEY } from "../workflows/goal-review-worker.ts";

type Binding = {
  path: string; token: string; entryId: string; policy: DedicatedGoalPolicy; identity: GoalWorkerIdentity;
  questionnaireEnabled?: boolean; reviewEnabled?: boolean;
};
type ChildGoalService = ReturnType<typeof createDelegatedChildGoalService>;
type Snapshot = ReturnType<ChildGoalService["snapshot"]>;
type Questions = ReturnType<typeof createGoalQuestions>;
type Reviews = ReturnType<typeof createWorkerGoalReview>;
type ParentRequest = {
  operation: string; entry?: DelegatedGoalEntry; reply?: GoalQuestionReply; requestId?: string;
  expectedGoalId?: string; expectedActivationId?: string; expectedPolicyRevision?: number;
};
const PARENT_REQUEST_FIELDS = ["operation", "entry", "reply", "requestId", "expectedGoalId", "expectedActivationId", "expectedPolicyRevision"];

const globals = globalThis as any;
const childGoalService = () => globals.__paeDelegatedChildGoalV1 as ChildGoalService | undefined;

function readBinding(): Binding {
  if (process.env.PI_DEDICATED_GOAL_CHILD !== "1") throw new Error("Dedicated goal worker mode is required");
  const raw = process.env.PI_DEDICATED_GOAL_BINDING;
  if (!raw) throw new Error("Dedicated goal worker binding is missing");
  const binding = JSON.parse(raw) as Binding;
  if (!binding.path || !binding.entryId || !binding.identity || binding.identity.childId !== process.env.PI_SUBAGENT_ID)
    throw new Error("Dedicated goal worker launch identity mismatch");
  return binding;
}

/** Explicit helper extension, including guarded workers. It grants no additional
 * filesystem authority: optional review registration delegates to the inherited
 * read tool/hooks and never widens the parent/profile/retained allowlist. */
export default async function goalWorker(pi: ExtensionAPI) {
  const binding = readBinding();
  const { workerEpoch } = binding.identity;
  const policy = dedicatedGoalPolicy(binding.policy);
  progress(pi, { assignedGoalBootstrap: true });
  if (binding.questionnaireEnabled) (await import("../questionnaire/index.ts")).default(pi, { assignedGoalBootstrap: true });
  workflows(pi, { delegatedChild: true, goalSettingsPath: join(dirname(binding.path), "goal-settings.json") });

  let current = false;
  let questions: Questions | undefined;
  let reviews: Reviews | undefined;
  let server: Awaited<ReturnType<typeof serveGoalWorker>> | undefined;

  function startReviews(ctx: ExtensionContext): Reviews | undefined {
    if (!binding.reviewEnabled) return undefined;
    const { taskId, childId, jobId, attempt } = binding.identity;
    const review = createWorkerGoalReview({
      entryId: binding.entryId,
      child: { taskId, childId, jobId, attempt },
      workerEpoch,
      root: ctx.cwd,
      branch: ctx.sessionManager.getBranch() as unknown[],
      persist: data => pi.appendEntry(GOAL_REVIEW_ENTRY, data),
      current: () => {
        const service = childGoalService();
        if (!current || !service) throw Error("Goal reference worker unavailable");
        return service.snapshot();
      },
      readEnabled: () => pi.getActiveTools().includes("read") && pi.getActiveTools().includes("goal_reference"),
    });
    globals[GOAL_REVIEW_WORKER_KEY] = { protocol: 1, sessionId: ctx.sessionManager.getSessionId(), workerEpoch, register: review.register };
    return review;
  }

  function startQuestions(ctx: ExtensionContext): Questions {
    const bindAttachments = (id: string, input: Parameters<Reviews["bindAttachments"]>[1]) => {
      if (!reviews && input.questions.some(question => question.attachmentIds?.length)) throw Error("Goal attachment registration unavailable");
      return reviews?.bindAttachments(id, input) ?? [];
    };
    const created = createGoalQuestions(binding.entryId, workerEpoch, ctx.sessionManager.getBranch() as unknown[],
      data => pi.appendEntry(GOAL_QUESTIONS_ENTRY, data), { bindAttachments });
    if (binding.questionnaireEnabled) {
      globals[WORKER_INTERACTIONS_KEY] = { protocol: 1, mode: "headless", workerEpoch, supportedKinds: ["questionnaire"], request: created.request };
      globals[GOAL_QUESTION_RECORDER_KEY] = {
        protocol: 1, sessionId: ctx.sessionManager.getSessionId(), workerEpoch,
        request: (input: any, signal: AbortSignal | undefined, upstream: any) => {
          if (!current || !questions) throw Error("Goal question recorder unavailable");
          const forward = upstream.request === questions.request ? undefined
            : (request: any, forwardSignal?: AbortSignal) => upstream.request(request, forwardSignal);
          return questions.request(input, signal, forward);
        },
      };
    }
    return created;
  }

  /** Run one parent operation against the child goal engine and return its new snapshot. */
  async function apply(service: ChildGoalService, r: ParentRequest, snapshot: Snapshot, ctx: ExtensionContext): Promise<Snapshot> {
    const sameActivation = r.expectedGoalId === snapshot.childGoalId && r.expectedActivationId === snapshot.childActivationId;
    switch (r.operation) {
      case "limits": {
        if (!r.entry || r.entry.id !== binding.entryId || !sameActivation || r.expectedPolicyRevision !== snapshot.policyRevision)
          throw new Error("Dedicated child identity or policy revision changed");
        const nextPolicy = dedicatedGoalPolicy({ continuationLimits: r.entry.continuationLimits });
        const next = await service.updateLimits(binding.entryId, r.expectedGoalId!, r.expectedPolicyRevision, r.entry, r.expectedActivationId!);
        policy.continuationLimits = nextPolicy.continuationLimits;
        return next;
      }
      case "start":
        if (!r.entry) break;
        if (r.entry.id !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
        return service.bootstrap(r.entry);
    }
    if (r.entry !== undefined && r.operation !== "resume") throw new Error("Entry is start/resume-only");
    switch (r.operation) {
      case "settle": {
        const stopped = sameActivation && snapshot.goal?.status !== "active" && ctx.isIdle() && !ctx.hasPendingMessages();
        if (!stopped) throw new Error("Goal questionnaire stop is not verified");
        questions!.cancelPending();
        return service.snapshot();
      }
      case "resume":
      case "pause":
        if (r.operation === "resume" && r.entry?.id !== binding.entryId) throw new Error("Dedicated Resume requires matching parent metadata");
        if (!snapshot.entryId || !snapshot.childGoalId) throw new Error("Dedicated child binding is missing");
        if (!sameActivation) throw new Error("Dedicated child goal identity or activation changed");
        return r.operation === "resume"
          ? service.resume(snapshot.entryId, r.expectedGoalId!, r.entry!, r.expectedActivationId!)
          : service.pause(snapshot.entryId, r.expectedGoalId!, r.expectedActivationId!);
      case "answer":
        if (!binding.questionnaireEnabled || !r.reply || !r.requestId) throw new Error("Goal question reply unavailable");
        questions!.answer(r.reply, r.requestId);
        return service.snapshot();
      case "observe":
        return snapshot;
    }
    throw new Error("Unknown child goal operation");
  }

  function report(snapshot: Snapshot, ctx: ExtensionContext) {
    const goal = snapshot.goal!;
    const { questionsTruncated: _previous, ...eventCoverage } = snapshot.story?.coverage ?? {};
    const questionsTruncated = questions!.coverage();
    const story = {
      ...(snapshot.story ?? { version: 1, timeline: [], activity: [] }),
      questions: questions!.snapshot(),
      coverage: { ...eventCoverage, ...(questionsTruncated === undefined ? {} : { questionsTruncated }) },
    };
    return {
      goalId: snapshot.childGoalId, activationId: snapshot.childActivationId, revision: snapshot.revision, status: goal.status,
      executionStopped: ctx.isIdle() && !ctx.hasPendingMessages(), waiting: goal.waiting,
      tasks: goal.tasks, prs: goal.prs, checks: goal.checks, tokensUsed: goal.tokensUsed, automaticTurns: goal.automaticTurns, noProgressTurns: goal.noProgressTurns,
      policyRevision: snapshot.policyRevision, tokenBudget: snapshot.tokenBudget, limitsEditable: true,
      ...(reviews ? { review: reviews.snapshot() } : {}),
      summary: goal.summary, diagnostics: goal.diagnostics, story, limits: snapshot.limits,
    };
  }

  async function handle(input: unknown, ctx: ExtensionContext) {
    const service = childGoalService();
    if (!service) throw new Error("Dedicated child goal engine is unavailable");
    if (!input || typeof input !== "object") throw new Error("Invalid child goal request");
    const r = input as ParentRequest;
    if (Object.keys(r).some(key => !PARENT_REQUEST_FIELDS.includes(key))) throw new Error("Unknown child goal request field");

    const before = service.snapshot();
    if (!sameGoalLimits(policy.continuationLimits, before.limits)) throw new Error("Dedicated child effective limits differ from parent confirmation");
    if (r.operation !== "start" && before.entryId !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
    if (r.entry && r.operation !== "limits" && !sameGoalLimits(policy.continuationLimits, r.entry.continuationLimits))
      throw new Error("Goal metadata differs from confirmed continuation limits");

    const after = await apply(service, r, before, ctx);
    if (after.entryId !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
    if (!sameGoalLimits(policy.continuationLimits, after.limits)) throw new Error("Dedicated child effective limits changed during operation");
    if (!after.childGoalId || !after.goal) throw new Error("Dedicated child goal state is missing");
    return report(after, ctx);
  }

  function stop() {
    current = false;
    questions?.dispose();
    reviews?.dispose();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (server) { current = false; await server.close(); server = undefined; }
    stop();
    reviews = startReviews(ctx);
    questions = startQuestions(ctx);
    current = true;
    server = await serveGoalWorker({ ...binding, isCurrent: () => current, handle: input => handle(input, ctx) });
  });
  pi.on("tool_result", (event) => {
    const service = childGoalService();
    if (!current || !service || event.isError) return;
    if (event.toolName === "notify_parent" && typeof event.input.message === "string") service.recordActivity(`${workerEpoch}:${event.toolCallId}`, event.input.message);
    service.recordState();
  });
  pi.on("agent_end", () => {
    if (current) childGoalService()?.recordState();
  });
  pi.on("session_shutdown", async () => {
    stop();
    for (const key of [GOAL_REVIEW_WORKER_KEY, GOAL_QUESTION_RECORDER_KEY, WORKER_INTERACTIONS_KEY])
      if (globals[key]?.workerEpoch === workerEpoch) delete globals[key];
    await server?.close();
    server = undefined;
  });
}
