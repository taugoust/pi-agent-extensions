// Offline provider fixture for native named-subagent-profile acceptance tests.
// Loaded explicitly by the parent and from isolated child settings; never uses HTTP.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFile } from "node:fs/promises";

const providerId = "offline-profile-fixture";
const models = ["parent", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "scout-v1", "worker-v1", "reviewer-v1", "oracle-v1", "changed-v2"].map((id) => ({
  id, name: id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

function contentText(message: any): string {
  return typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n") : "";
}

function offlineMessage(model: any, content: any[], stopReason: string) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason,
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export default async function profileFixture(pi: any) {
  globalThis.fetch = (async () => { throw new Error("HTTP_FORBIDDEN_PROFILE_FIXTURE"); }) as any;
  let handledUserCount = 0;
  let toolCallId = 0;
  const log = process.env.PROFILE_FIXTURE_LOG;
  const append = async (row: Record<string, unknown>) => {
    if (!log) throw new Error("PROFILE_FIXTURE_LOG is required");
    await appendFile(log, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };

  const scenario = JSON.parse(process.env.PROFILE_SCENARIO ?? "{}");
  if (scenario.dedicated && !process.env.PI_SUBAGENT_ID) {
    const { registerDedicatedCoordinatorProbe } = await import("./dedicated-coordinator-native-probe.ts");
    registerDedicatedCoordinatorProbe(pi, append);
  }

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName === "subagent") await append({ event: "subagent_call", args: event.input,
      cwd: ctx.cwd, processCwd: process.cwd(), home: process.env.HOME,
      agentDir: process.env.PI_CODING_AGENT_DIR, projectTrusted: ctx.isProjectTrusted?.() === true, network: false });
  });

  if (process.env.PROFILE_FIXTURE_UNTRUSTED_PROJECT === "1") pi.on("project_trust", async (event: any, ctx: any) => {
    await append({ event: "project_trust", cwd: event.cwd, processCwd: process.cwd(), home: process.env.HOME,
      agentDir: process.env.PI_CODING_AGENT_DIR, decision: "no", network: false });
    return { trusted: "no" };
  });

  if (process.env.PROFILE_FIXTURE_AGENTSH === "1") {
    (globalThis as any).__AGENTSH_PI__ = {
      getSupervisorState: () => ({ configured: true, active: true, protocol: "mock-ndjson", status: "connected" }),
      subagentAdapter: {
        async execute(_toolCallId: string, args: any) {
          await append({ event: "adapter_call", args, network: false });
          const tasks = Array.isArray(args.tasks) ? args.tasks : args.chain;
          return { content: [{ type: "text", text: "Offline adapter result" }], details: {
            mode: Array.isArray(args.chain) ? "chain" : Array.isArray(args.tasks) ? "parallel" : "single",
            results: (tasks ?? [args]).map((task: any, index: number) => ({ child: index + 1, label: `task ${index + 1}`,
              task: task.task, exitCode: 0, messages: [], stderr: "", usage: {} })),
          } };
        },
        detailsFailed: () => false,
        renderCall: () => undefined,
        renderResult: () => undefined,
      },
    };
  }

  pi.registerProvider(providerId, {
    api: "offline-profile-fixture", apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1",
    models,
    streamSimple(model: any, context: any, options: any = {}) {
      const child = Boolean(process.env.PI_SUBAGENT_ID);
      const systemMessages = (context.messages ?? []).filter((message: any) => message.role === "system");
      const request = {
        event: "dispatch", role: child ? "child" : "parent", childId: process.env.PI_SUBAGENT_ID,
        provider: model.provider, model: model.id, reasoning: options.reasoning,
        systems: systemMessages.map((message: any) => ({ content: message.content, sections: message.sections,
          toolsAdded: message.toolsAdded?.map((tool: any) => tool.name), toolsRemoved: message.toolsRemoved?.map((tool: any) => tool.name) })),
        userMessages: (context.messages ?? []).filter((message: any) => message.role === "user").map(contentText),
      };
      const users = request.userMessages as string[];
      let content: any[] = [{ type: "text", text: child ? "Offline profile child complete" : "Offline parent complete" }];
      let stopReason = "stop";
      if (!child && users.length > handledUserCount) {
        handledUserCount = users.length;
        const last = users.at(-1) ?? "";
        let args: Record<string, unknown>;
        const resume = last.match(/resume-task:\s*(subagent-task-[a-f0-9]{24})/i);
        const reap = last.match(/reap-group:\s*(subagent-job-[a-f0-9]{24})/i);
        if (resume) args = { operation: "resume", task_id: resume[1], message: "Continue using the retained profile contract." };
        else if (reap) args = { operation: "reap", job_id: reap[1] };
        else {
          const scenario = JSON.parse(process.env.PROFILE_SCENARIO ?? "{}") as Record<string, unknown>;
          args = (scenario.params && typeof scenario.params === "object" ? scenario.params : scenario) as Record<string, unknown>;
        }
        content = [{ type: "toolCall", id: `profile-test-${++toolCallId}`, name: scenario.dedicated ? "fixture_dedicated_probe" : "subagent", arguments: scenario.dedicated ? {} : args }];
        stopReason = "toolUse";
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          await append({ ...request, network: false });
          const message = offlineMessage(model, content, stopReason);
          stream.push({ type: "done", reason: stopReason, message });
          stream.end();
        } catch (error) {
          const message = offlineMessage(model, [], "error");
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
        }
      });
      return stream;
    },
  });
}
