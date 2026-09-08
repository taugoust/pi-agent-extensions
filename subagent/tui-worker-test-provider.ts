import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Explicit integration-test fixture only. Never auto-discovered or deployed. */
export default function deterministicWorkerProvider(pi: ExtensionAPI): void {
  pi.registerProvider("harness-test", {
    baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "mock", name: "Deterministic worker fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple: (_model: unknown, context: any, options: any) => {
      const source = JSON.stringify(context.messages);
      const results = context.messages.filter((m: any) => m.role === "toolResult");
      let content: any[] = [{ type: "text", text: source.includes("ASSERT_READ_ONLY") ? `TOOLS:${(context.tools ?? []).map((t: any) => t.name).sort().join(",")}` : "Deterministic completed task." }];
      if (source.includes("RUN_LOCAL_JOB") && !results.some((r: any) => r.toolName === "background_job")) content = [{ type: "toolCall", id: "fixture-local-job", name: "background_job", arguments: { action: "start", command: "printf child-job-marker; sleep 30", name: "Child-local fixture" } }];
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
          // Long enough to exercise active reaping against a genuine direct turn.
          await new Promise(resolve => setTimeout(resolve, source.includes("WAIT_FOR_PARENT") ? 8000 : 1000));
          if (options?.signal?.aborted) yield { type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } };
          else yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      } as any;
    },
  });
}
