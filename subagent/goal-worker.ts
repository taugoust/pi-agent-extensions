import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows from "../workflows/index.ts";
import progress from "../progress/index.ts";
import { serveGoalWorker, type GoalWorkerIdentity } from "./goal-rpc.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";
import { dirname, join } from "node:path";
import { WORKER_INTERACTIONS_KEY } from "../shared/foreground-tasks.ts";
import { createGoalQuestions, GOAL_QUESTIONS_ENTRY } from "../workflows/goal-questions.ts";
import type { GoalQuestionReply } from "../workflows/goal-story.ts";
import { dedicatedGoalPolicy, sameGoalLimits, type DedicatedGoalPolicy } from "./goal-policy.ts";
import type { createDelegatedChildGoalService } from "../workflows/delegated-child.ts";

/** Explicit helper extension, including for guarded workers. It registers no
 * shell/file tools and does not alter the inherited permission/tool allowlist. */
export default async function goalWorker(pi: ExtensionAPI) {
  if (process.env.PI_DEDICATED_GOAL_CHILD !== "1") throw new Error("Dedicated goal worker mode is required");
  const raw = process.env.PI_DEDICATED_GOAL_BINDING;
  if (!raw) throw new Error("Dedicated goal worker binding is missing");
  const binding = JSON.parse(raw) as { path: string; token: string; entryId: string; policy: DedicatedGoalPolicy; identity: GoalWorkerIdentity; questionnaireEnabled?: boolean };
  if (!binding.path || !binding.entryId || !binding.identity || binding.identity.childId !== process.env.PI_SUBAGENT_ID)
    throw new Error("Dedicated goal worker launch identity mismatch");
  const policy = dedicatedGoalPolicy(binding.policy);
  progress(pi);
  if (binding.questionnaireEnabled) (await import("../questionnaire/index.ts")).default(pi);
  workflows(pi, { delegatedChild: true, goalSettingsPath: join(dirname(binding.path), "goal-settings.json") });
  let current = false;
  let questions: ReturnType<typeof createGoalQuestions> | undefined;
  let server: Awaited<ReturnType<typeof serveGoalWorker>> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (server) { current = false; await server.close(); server = undefined; }
    questions?.dispose();
    questions = createGoalQuestions(binding.entryId, binding.identity.workerEpoch, ctx.sessionManager.getBranch() as unknown[], data => pi.appendEntry(GOAL_QUESTIONS_ENTRY, data));
    if (binding.questionnaireEnabled) (globalThis as any)[WORKER_INTERACTIONS_KEY] = { protocol: 1, mode: "headless", workerEpoch: binding.identity.workerEpoch, supportedKinds: ["questionnaire"], request: questions.request };
    current = true;
    server = await serveGoalWorker({ ...binding, isCurrent: () => current, async handle(input) {
      const service = (globalThis as any).__paeDelegatedChildGoalV1 as ReturnType<typeof createDelegatedChildGoalService> | undefined;
      if (!service) throw new Error("Dedicated child goal engine is unavailable");
      if (!input || typeof input !== "object") throw new Error("Invalid child goal request");
      const r = input as { operation: string; entry?: DelegatedGoalEntry; reply?: GoalQuestionReply; requestId?: string };
      if (Object.keys(r).some(k => !["operation", "entry", "reply", "requestId"].includes(k))) throw new Error("Unknown child goal request field");
      let snapshot = service.snapshot();
      if (!sameGoalLimits(policy.continuationLimits, snapshot.limits)) throw new Error("Dedicated child effective limits differ from parent confirmation");
      if (r.operation !== "start" && snapshot.entryId !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
      if (r.entry && !sameGoalLimits(policy.continuationLimits, r.entry.continuationLimits)) throw new Error("Goal metadata differs from confirmed continuation limits");
      if (r.operation === "start" && r.entry) {
        if (r.entry.id !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
        snapshot = await service.bootstrap(r.entry);
      }
      else {
        if (r.entry !== undefined && r.operation !== "resume") throw new Error("Entry is start/resume-only");
        if (r.operation === "resume" && (!r.entry || r.entry.id !== binding.entryId)) throw new Error("Dedicated Resume requires matching parent metadata");
        if (r.operation === "resume" || r.operation === "pause") {
          if (!snapshot.entryId || !snapshot.childGoalId) throw new Error("Dedicated child binding is missing");
          snapshot = r.operation === "resume"
            ? await service.resume(snapshot.entryId, snapshot.childGoalId, r.entry!)
            : await service.pause(snapshot.entryId, snapshot.childGoalId);
        } else if (r.operation === "answer") {
          if (!binding.questionnaireEnabled || !r.reply || !r.requestId) throw new Error("Goal question reply unavailable");
          questions!.answer(r.reply, r.requestId);
          snapshot = service.snapshot();
        } else if (r.operation !== "observe") throw new Error("Unknown child goal operation");
      }
      if (snapshot.entryId !== binding.entryId) throw new Error("Dedicated parent goal identity changed");
      if (!sameGoalLimits(policy.continuationLimits, snapshot.limits)) throw new Error("Dedicated child effective limits changed during operation");
      if (!snapshot.childGoalId || !snapshot.goal) throw new Error("Dedicated child goal state is missing");
      return { goalId: snapshot.childGoalId, status: snapshot.goal.status,
        executionStopped: ctx.isIdle() && !ctx.hasPendingMessages(), waiting: snapshot.goal.waiting,
        tasks: snapshot.goal.tasks, tokensUsed: snapshot.goal.tokensUsed,
        automaticTurns: snapshot.goal.automaticTurns, noProgressTurns: snapshot.goal.noProgressTurns,
        summary: snapshot.goal.summary, story: { ...(snapshot.story ?? { version: 1, timeline: [], activity: [] }), questions: questions!.snapshot() }, limits: snapshot.limits };
    } });
  });
  pi.on("tool_result", (event) => {
    const service = (globalThis as any).__paeDelegatedChildGoalV1 as ReturnType<typeof createDelegatedChildGoalService> | undefined;
    if (!current || !service || event.isError) return;
    if (event.toolName === "notify_parent" && typeof event.input.message === "string") service.recordActivity(`${binding.identity.workerEpoch}:${event.toolCallId}`, event.input.message);
    service.recordState();
  });
  pi.on("agent_end", () => {
    if (current) ((globalThis as any).__paeDelegatedChildGoalV1 as ReturnType<typeof createDelegatedChildGoalService> | undefined)?.recordState();
  });
  pi.on("session_shutdown", async () => {
    current = false; questions?.dispose();
    if ((globalThis as any)[WORKER_INTERACTIONS_KEY]?.workerEpoch === binding.identity.workerEpoch) delete (globalThis as any)[WORKER_INTERACTIONS_KEY];
    await server?.close(); server = undefined;
  });
}
