import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { TUI_WORKER_MANIFEST_ENV } from "../shared/tui-worker-protocol.ts";

/** Explicit integration-test fixture only. Never auto-discovered or deployed. */
if (process.env[TUI_WORKER_MANIFEST_ENV] && Number(process.env.PI_TUI_TEST_HEADLESS_START_DELAY_MS) > 0) {
  const delay = Math.min(Number(process.env.PI_TUI_TEST_HEADLESS_START_DELAY_MS), 5000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}
export default function deterministicWorkerProvider(pi: ExtensionAPI): void {
  pi.registerProvider("harness-test", {
    baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "mock", name: "Deterministic worker fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }, { id: "gpt-6.1-sol", name: "Deterministic coordinator fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple: (_model: unknown, context: any, options: any) => {
      const source = JSON.stringify(context.messages);
      const results = context.messages.filter((m: any) => m.role === "toolResult");
      let content: any[] = [{ type: "text", text: source.includes("ASSERT_READ_ONLY") ? `TOOLS:${getCurrentTools(context.messages).map((t: any) => t.name).sort().join(",")}` : "Deterministic completed task." }];
      const pauseBeforeOutcome = source.includes("PAUSE_BEFORE_TASK_OUTCOME") && !results.some((r: any) => r.toolName === "task_outcome");
      if (pauseBeforeOutcome) content = [{ type: "toolCall", id: "fixture-paused-outcome", name: "task_outcome", arguments: { version: 1, state: "delivered", summary: "Must not execute before stream completion", acceptance: [], artifacts: [], remaining: [] } }];
      if (source.includes("ASK_QUESTIONNAIRE") && !results.some((r: any) => r.toolName === "questionnaire")) content = [{ type: "toolCall", id: "fixture-questionnaire", name: "questionnaire", arguments: { questions: [{ id: "continue", prompt: "Continue?", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], allowOther: false }] } }];
      else if (source.includes("ASK_GUARDED_PERMISSION") && !results.some((r: any) => r.toolName === "bash")) {
        const target = process.env.PI_TUI_ROOT_PERMISSION_FILE;
        if (!target) throw new Error("Guarded permission fixture path is missing");
        const quoted = `'${target.replaceAll("'", "'\\''")}'`;
        content = [{ type: "toolCall", id: "fixture-guarded-bash", name: "bash", arguments: { command: `chmod 777 ${quoted} && printf guarded-panel-approval` } }];
      }
      else if (source.includes("CHECKPOINT_SMALL") && !results.some((r: any) => r.toolName === "task_outcome")) content = [{ type: "toolCall", id: "fixture-checkpoint", name: "task_outcome", arguments: { version: 1, state: "checkpointed", summary: "Small checkpoint fixture", acceptance: [], artifacts: [], remaining: ["Explicit resume"], next_action: "Continue with retained context" } }];
      else if (source.includes("RUN_LOCAL_JOB") && !results.some((r: any) => r.toolName === "background_job")) content = [{ type: "toolCall", id: "fixture-local-job", name: "background_job", arguments: { action: "start", command: "printf child-job-marker; sleep 30", name: "Child-local fixture" } }];
      else if (source.includes("RUN GUARDED CHECK") && !results.some((r: any) => r.toolName === "bash")) content = [{ type: "toolCall", id: "fixture-bash", name: "bash", arguments: { command: "printf guard-ok" } }];
      else if (source.includes("REPORT_OUTCOME") && !results.some((r: any) => r.toolName === "task_outcome")) content = [{ type: "toolCall", id: "fixture-outcome", name: "task_outcome", arguments: { version: 1, state: "delivered", summary: "Fixture outcome", acceptance: [{ criterion: "fixture", status: "passed", evidence: "Deterministic test" }], artifacts: [], remaining: [] } }];
      else if (source.includes("REPORT_OUTCOME") && !results.some((r: any) => r.toolName === "notify_parent")) content = [{ type: "toolCall", id: "fixture-note", name: "notify_parent", arguments: { message: "Routine fixture finding", requires_guidance: false } }];
      if (source.includes("AUTO_ROUTINE")) {
        const count = results.filter((r: any) => r.toolName === "task_outcome").length;
        const continued = source.includes("One automatic continuation of the same assignment.");
        if (count === 0 || continued && count === 1) {
          const partial = count === 0 || source.includes("AUTO_REPEAT");
          content = [{ type: "toolCall", id: `fixture-auto-${count}`, name: "task_outcome", arguments: {
            version: 1, state: partial ? "partial" : "delivered", summary: partial ? "Routine fixture work remains" : "Automatic continuation finished",
            acceptance: [{ criterion: "Routine continuation runs once", status: partial ? "not_run" : "passed", ...(!partial ? { evidence: "Continuation marker observed by provider" } : {}) }],
            artifacts: [], remaining: partial ? ["Finish routine fixture"] : [], ...(partial ? { next_action: "Finish routine fixture", continuation: "routine" } : {}) } }];
        }
      }
      if (source.includes("AUTOMATIC_WORKTREE_COORDINATOR_FIXTURE")) {
        const calls = results.filter((r: any) => r.toolName === "subagent");
        const launch = calls.find((r: any) => r.details?.operation === "start");
        const last = calls.at(-1);
        let args: any;
        if (!launch) args = { task: "AUTOMATIC_WORKTREE_LEAF_FIXTURE", model: "harness-test/mock:off", background: true, acceptance: ["Complete the offline non-Goal worktree fixture"] };
        else if (last?.details?.operation === "reap") content = [{ type: "text", text: "AUTOMATIC_WORKTREE_NESTED_REAP_COMPLETE" }];
        else if (last?.details?.operation === "result") args = { operation: "reap", job_id: launch.details.job_id };
        else if (last?.details?.group?.status === "completed") args = { operation: "result", job_id: launch.details.job_id };
        else args = { operation: "status", job_id: launch.details.job_id };
        if (args) content = [{ type: "toolCall", id: `automatic-worktree-${results.length}`, name: "subagent", arguments: args }];
      }
      if (process.env.PI_DEDICATED_GOAL_CHILD === "1" && source.includes("MANAGED_GOAL_FIXTURE")) {
        const state = (globalThis as any).__paeDelegatedChildGoalV1?.snapshot();
        if (!state?.childGoalId) throw new Error("Managed Goal fixture missing engine binding");
        if (source.includes("FINISH_MANAGED_GOAL")) {
          content = state.goal.tasks.some((step: any) => step.status !== "completed")
            ? [{ type: "toolCall", id: `fixture-goal-progress-${results.length}`, name: "update_progress", arguments: { action: "update", steps: state.goal.tasks.map((step: any) => ({ ...step, status: "completed" })) } }]
            : [{ type: "toolCall", id: `fixture-goal-complete-${results.length}`, name: "goal_complete", arguments: { summary: "Verified ordinary managed Goal lifecycle in the offline native integration fixture." } }];
        } else if (source.includes("STEER_MANAGED_GOAL") && !results.some((r: any) => r.toolName === "notify_parent")) {
          content = [{ type: "toolCall", id: `fixture-goal-steer-${results.length}`, name: "notify_parent", arguments: { message: "MANAGED_STEER_ACK", requires_guidance: false } }];
        } else content = [{ type: "toolCall", id: `fixture-goal-wait-${results.length}`, name: "goal_wait", arguments: { reason: "Await deterministic parent steering" } }];
      }
      const message = { role: "assistant", content,
        api: "openai-completions", provider: "harness-test", model: (_model as any).id, stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          // Provider emitted a partial tool-call frame but never completed the
          // assistant response. Pi must not dispatch the tool until stream done.
          if (pauseBeforeOutcome) {
            const manifestPath = process.env[TUI_WORKER_MANIFEST_ENV];
            if (!manifestPath) throw new Error("Paused-stream fixture requires a worker manifest");
            writeFileSync(`${manifestPath}.paused-stream.json`, JSON.stringify({ emitted: true, toolName: "task_outcome", toolCallId: "fixture-paused-outcome", timestamp: Date.now() }), { mode: 0o600 });
            await new Promise<void>(resolve => {
              const timer = setTimeout(done, 60_000);
              const abort = () => done();
              function done() { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); resolve(); }
              options?.signal?.addEventListener("abort", abort, { once: true });
              if (options?.signal?.aborted) done();
            });
          }
          // Long enough to exercise active reaping against genuine direct turns.
          else if (source.includes("OWNER_LOSS_HEADLESS")) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(done, 60_000);
              const abort = () => done();
              function done() { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); resolve(); }
              options?.signal?.addEventListener("abort", abort, { once: true });
              if (options?.signal?.aborted) done();
            });
          } else await new Promise(resolve => setTimeout(resolve, source.includes("WAIT_FOR_PARENT") ? 8000 : 1000));
          if (options?.signal?.aborted) yield { type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } };
          else yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      } as any;
    },
  });
}
