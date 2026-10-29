// Actual Pi AgentSession + deterministic in-process provider. No external model,
// child process, network, user session, or repository mutation.
// Usage: node tests/goal-progress-runtime.mjs <installed pi package directory>
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const sdk = resolve(process.argv[2]);
const { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, initTheme } = await import(pathToFileURL(join(sdk, "dist/index.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const { createJiti } = await import(pathToFileURL(join(sdk, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(sdk, "dist/index.js"),
  "@earendil-works/pi-ai": join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(sdk, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: join(sdk, "node_modules/typebox/build/index.mjs"),
} });
const { default: goal } = await jiti.import("../workflows/goal/goal.ts");
const { default: progress } = await jiti.import("../progress/progress-widget.ts");
const { DEFAULT_PROGRESS_SETTINGS } = await jiti.import("../progress/settings.ts");
const { bindGoalMutations } = await jiti.import("../workflows/goal/mutations.ts");
const text = message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
function currentGoal(context) {
  const message = context.messages.findLast(message => text(message).startsWith("Current goal data: "));
  assert.ok(message, "the actual provider must receive canonical goal-task-context");
  return JSON.parse(text(message).split("\n")[0].slice("Current goal data: ".length));
}
const call = (name, args, id) => ({ type: "toolCall", id, name, arguments: args });

test("actual Pi preserves generated task/status revisions through message_end and sibling usage checkpoints", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-revision-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Network forbidden in goal revision regression"); };
  let session, owner, engine, calls = 0, probes = 0, timer;
  const trace = [], errors = [];
  try {
    initTheme("dark", false);
    const models = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models"), allowModelNetwork: false, refreshOnCreate: false });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const fixture = pi => {
      ({ runtime: engine } = goal(pi, { settingsPath: join(directory, "absent-goal-settings.json") }));
      progress(pi, { loadSettings: async () => ({ kind: "loaded", settings: DEFAULT_PROGRESS_SETTINGS }) });
      let dispose;
      pi.on("session_start", (_event, ctx) => { dispose = bindGoalMutations(pi, ctx, engine, { child: false, busy: () => false }); });
      pi.on("session_shutdown", () => dispose?.());
      pi.on("message_end", event => { if (event.message.role === "assistant") trace.push({ kind: "assistant-end", calls }); });
      pi.on("tool_execution_end", event => {
        if (event.toolName === "revision_probe") trace.push({ kind: "checkpoint", calls, revision: engine.activeGoal?.revision, tokens: engine.activeGoal?.tokensUsed });
      });
      pi.registerTool({ name: "revision_probe", label: "Offline verification probe", description: "Verify fixture-local state without external effects", executionMode: "sequential", parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, _args, _signal, _onUpdate, ctx) {
          const latest = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
          assert.equal(latest.message.usage.totalTokens, 11, "SDK persists assistant usage before executing its tools");
          probes++;
          return { content: [{ type: "text", text: "Verified fixture-local state" }], details: { probes } };
        },
      });
      pi.registerProvider("goal-revision-test", {
        api: "openai-completions", apiKey: "offline", baseUrl: "https://invalid.invalid",
        models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(_model, context) {
          calls++;
          assert.ok(calls <= 5, "bounded fixture must not retry or dispatch another model turn");
          let content;
          if (calls === 1) content = [call("update_progress", { action: "create", objective: "Verify the offline fixture", request_id: "create", steps: [{ text: "Verify fixture-local state", status: "pending" }] }, "create")];
          else {
            const current = currentGoal(context);
            trace.push({ kind: "context", calls, revision: current.revision, activation: current.activation_id, status: current.status });
            assert.equal(current.status, "active", "default create starts the goal without a second activation");
            assert.equal(current.revision, engine.activeGoal.revision);
            if (calls === 2) content = [call("revision_probe", {}, "probe-before-progress"), call("update_progress", { action: "update", goal_id: current.goal_id, expected_revision: current.revision, request_id: "finish-task", steps: [{ ...current.tasks[0], status: "completed" }] }, "progress")];
            else if (calls === 3) {
              const update = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "update_progress");
              assert.equal(update.isError ?? false, false, text(update));
              content = [call("goal_manage", { action: "status" }, "status")];
            } else if (calls === 4) {
              const status = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "goal_manage");
              const observed = JSON.parse(text(status));
              assert.equal(observed.revision, current.revision, "status revision remains usable in the next model response");
              content = [call("revision_probe", {}, "probe-before-control"), call("goal_manage", { action: "update", goal_id: observed.id, activation_id: observed.activationId, expected_revision: observed.revision, user_authorized: true, objective: "Verify the renamed offline fixture" }, "scope")];
            } else {
              const updated = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "goal_manage");
              assert.equal(updated.isError ?? false, false, text(updated));
              assert.equal(current.tasks[0].status, "completed");
              assert.equal(probes, 2);
              content = [call("goal_complete", { goal_id: current.goal_id, activation_id: current.activation_id, summary: "Verified both fixture-local probes and the completed required task" }, "complete")];
            }
          }
          const message = { role: "assistant", provider: "goal-revision-test", model: "offline", api: "openai-completions", timestamp: Date.now(), stopReason: "toolUse", content,
            usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = new AssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
          return stream;
        },
      });
    };
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [fixture] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(directory, join(directory, "sessions")), noTools: "builtin" }));
    owner = new AgentSessionRuntime(session, { cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, async () => { throw Error("Unexpected session replacement"); });
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.setModel(models.getModel("goal-revision-test", "offline"));
    timer = setTimeout(() => session.abort(), 10000);
    await session.prompt("Exercise only this offline fixture: create the goal, verify its task, inspect status, explicitly rename its outcome to 'Verify the renamed offline fixture', then verify and complete it.");
    await session.waitForIdle();
    assert.equal(calls, 5, JSON.stringify(session.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant").map(entry => entry.message.errorMessage)));
    assert.equal(probes, 2); assert.deepEqual(errors, []);
    const branch = session.sessionManager.getBranch();
    const results = branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult").map(entry => entry.message);
    assert.ok(results.every(result => !result.isError), JSON.stringify(results));
    assert.match(text(results.at(-1)), /^Goal complete:/);
    assert.equal(engine.activeGoal, undefined);
    for (const response of [2, 4]) {
      const context = trace.find(event => event.kind === "context" && event.calls === response);
      const checkpoint = trace.find(event => event.kind === "checkpoint" && event.calls === response);
      const ended = trace.find(event => event.kind === "assistant-end" && event.calls === response);
      assert.ok(trace.indexOf(context) < trace.indexOf(ended) && trace.indexOf(ended) < trace.indexOf(checkpoint));
      assert.equal(checkpoint.revision, context.revision);
      assert.ok(checkpoint.tokens > 0, "the pre-mutation checkpoint persisted real assistant usage");
    }
    const contexts = trace.filter(event => event.kind === "context");
    assert.equal(contexts[1].revision, contexts[0].revision + 1, "task mutation advances the canonical context revision");
    assert.equal(contexts[3].revision, contexts[2].revision + 1, "scope mutation advances the canonical context revision");
    assert.notEqual(contexts[3].activation, contexts[2].activation);
  } finally {
    clearTimeout(timer);
    await session?.abort(); await owner?.dispose(); engine?.clearCompletionStatusTimer();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
