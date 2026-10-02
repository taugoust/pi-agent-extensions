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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
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
      const message = { role: "assistant", content,
        api: "openai-completions", provider: "harness-test", model: "mock", stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
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
