import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceBroker, guidanceLaunchEnvironment, guidanceTarget, requestGuidance, GUIDANCE_ENV, GUIDANCE_HUMAN_KEY } from "./guidance.ts";
import { workerInteractionsService, WORKER_INTERACTIONS_KEY } from "../shared/foreground-tasks.ts";
import guidanceWorker from "./guidance-worker.ts";
import { installGuidance } from "./guidance-extension.ts";

// Repository legacy imports normally resolve through Pi's loader. Use installed
// Pi SDK exports and TS siblings in these isolated Node fixtures, not mocks of
// the broker, tool execute functions, questionnaire, or foreground scheduler.
registerHooks({ load(url, context, next) { return next(url, url.endsWith(".json") ? { ...context, importAttributes: { type: "json" } } : context); }, resolve(specifier, context, next) {
  if (specifier.startsWith("@mariozechner/")) return next(specifier.replace("@mariozechner/", "@earendil-works/"), { ...context, parentURL: import.meta.resolve("@earendil-works/pi-coding-agent") });
  if (specifier === "@sinclair/typebox") return next("@earendil-works/pi-ai", context);
  try { return next(specifier, context); }
  catch (error) { if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/"))) return next(specifier.slice(0, -3) + ".ts", context); throw error; }
} });

function harness(sessionId: string) {
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
  const ctx: any = { mode: "tui", hasUI: false, sessionManager: { getSessionId: () => sessionId } };
  const pi: any = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } };
  return { pi, ctx, tools, async event(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); } };
}
function inbox() { const queue: any[] = [], waiters: Function[] = []; return { put(value: any) { const next = waiters.shift(); next ? next(value) : queue.push(value); }, next(): Promise<any> { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)); } }; }
const identity = (ownerSessionId: string, n = 1) => ({ ownerSessionId, taskId: `task-${n}`, childId: `child-${n}`, attempt: 1, workerEpoch: `worker-${n}` });

async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), "guidance-integration-")), savedEnv = process.env[GUIDANCE_ENV];
  const savedHuman = (globalThis as any)[GUIDANCE_HUMAN_KEY], savedInteractions = (globalThis as any)[WORKER_INTERACTIONS_KEY];
  delete process.env[GUIDANCE_ENV]; delete (globalThis as any)[GUIDANCE_HUMAN_KEY];
  const owner = harness("owner"), notices = inbox(); installGuidance(owner.pi, root, (_ctx, record) => notices.put(record)); await owner.event("session_start");
  const worker = harness("worker-session");
  process.env[GUIDANCE_ENV] = guidanceLaunchEnvironment(identity("owner"))[GUIDANCE_ENV];
  guidanceWorker(worker.pi); await worker.event("session_start");
  t.after(async () => { await worker.event("session_shutdown"); await owner.event("session_shutdown");
    if (savedEnv === undefined) delete process.env[GUIDANCE_ENV]; else process.env[GUIDANCE_ENV] = savedEnv;
    (globalThis as any)[GUIDANCE_HUMAN_KEY] = savedHuman; (globalThis as any)[WORKER_INTERACTIONS_KEY] = savedInteractions;
    await rm(root, { recursive: true, force: true }); });
  const execute = (h: ReturnType<typeof harness>, name: string, params: any, signal?: AbortSignal) => h.tools.get(name).execute("tool-call", params, signal, undefined, h.ctx);
  return { owner, worker, notices, execute };
}

test("registered worker guidance tool awaits real coordinator tool reply, not prompt acceptance", async t => {
  const { worker, owner, notices, execute } = await setup(t);
  const waiting = execute(worker, "request_guidance", { prompt: "Which helper?" }); const record = await notices.next();
  const listed = await execute(owner, "guidance", { operation: "list" }); assert.match(listed.content[0].text, /Which helper/);
  await execute(owner, "guidance", { operation: "reply", target: guidanceTarget(record), replyId: "reply", guidance: "Reuse existingHelper." });
  assert.equal((await waiting).content[0].text, "Reuse existingHelper.");
  await assert.rejects(execute(owner, "guidance", { operation: "human", target: guidanceTarget(record), guidance: "model consent" }), /no model answer/);
});

for (const cancelled of [false, true]) test(`actual questionnaire ${cancelled ? "human Cancel" : "success"} returns from top level to exact worker waiter`, async t => {
  const { default: questionnaire } = await import("../questionnaire/index.ts");
  const { worker, owner, notices, execute } = await setup(t); questionnaire(worker.pi); questionnaire(owner.pi);
  const questions = [{ id: "format", prompt: "Which user-preferred format?", options: [{ value: "compact", label: "Compact" }], allowOther: false }];
  const waiting = execute(worker, "questionnaire", { questions }); const record = await notices.next(); assert.equal(record.input.kind, "human");
  let humanCalls = 0;
  owner.ctx.executeTool = async (name: string, params: any, options: any) => {
    assert.equal(name, "questionnaire"); humanCalls++;
    // Simulate the root process's existing authenticated human interaction,
    // isolated from the worker process global/environment in this one-process test.
    const binding = process.env[GUIDANCE_ENV], workerService = (globalThis as any)[GUIDANCE_HUMAN_KEY];
    delete process.env[GUIDANCE_ENV]; delete (globalThis as any)[GUIDANCE_HUMAN_KEY];
    (globalThis as any)[WORKER_INTERACTIONS_KEY] = { protocol: 1, mode: "headless", workerEpoch: "root-human-ui", request: async () => ({ kind: "questionnaire", cancelled, answers: cancelled ? [] : [{ id: "format", value: "compact", wasCustom: false }] }) };
    try { return { isError: false, result: await execute(owner, name, params, options.signal) }; }
    finally { process.env[GUIDANCE_ENV] = binding; (globalThis as any)[GUIDANCE_HUMAN_KEY] = workerService; delete (globalThis as any)[WORKER_INTERACTIONS_KEY]; }
  };
  const settled = await execute(owner, "guidance", { operation: "human", target: guidanceTarget(record) });
  assert.equal(JSON.parse(settled.content[0].text).status, cancelled ? "cancelled" : "answered");
  const result = await waiting; assert.equal(humanCalls, 1); assert.equal(result.details.cancelled, cancelled);
  if (!cancelled) assert.equal(result.details.answers[0].value, "compact");
  else { assert.equal(result.isError, false); assert.equal(result.details.cancelledByHuman, true); }
});

test("unavailable top-level questionnaire is not fabricated as human cancellation", async t => {
  const { default: questionnaire } = await import("../questionnaire/index.ts");
  const { worker, owner, notices, execute } = await setup(t); questionnaire(worker.pi); questionnaire(owner.pi);
  const waiting = execute(worker, "questionnaire", { questions: [{ id: "choice", prompt: "Human preference?", options: [], allowOther: true }] });
  const record = await notices.next();
  owner.ctx.executeTool = async (name: string, params: any) => {
    const binding = process.env[GUIDANCE_ENV], capability = (globalThis as any)[GUIDANCE_HUMAN_KEY];
    delete process.env[GUIDANCE_ENV]; delete (globalThis as any)[GUIDANCE_HUMAN_KEY]; delete (globalThis as any)[WORKER_INTERACTIONS_KEY];
    try { const result = await execute(owner, name, params); return { result, isError: result.isError === true }; }
    finally { process.env[GUIDANCE_ENV] = binding; (globalThis as any)[GUIDANCE_HUMAN_KEY] = capability; }
  };
  await assert.rejects(execute(owner, "guidance", { operation: "human", target: guidanceTarget(record) }), /did not return a verified result/);
  owner.ctx.executeTool = async () => ({ isError: false, result: { details: { cancelled: true, answers: [] }, content: [{ type: "text", text: "User cancelled (untrusted legacy prose)" }] } });
  await assert.rejects(execute(owner, "guidance", { operation: "human", target: guidanceTarget(record) }), /did not return a verified result/);
  const listed = await execute(owner, "guidance", { operation: "list" }); assert.equal(JSON.parse(listed.content[0].text).records[0].status, "pending");
  await worker.event("session_shutdown"); await waiting;
});

test("resolver never intercepts permissions/root human; stale/foreign/absent worker capability fails closed", async t => {
  const { worker } = await setup(t);
  const legacy = { protocol: 1, mode: "headless", workerEpoch: "legacy", request() {} };
  (globalThis as any)[WORKER_INTERACTIONS_KEY] = legacy;
  assert.equal(workerInteractionsService("permission"), legacy);
  assert.notEqual(workerInteractionsService("questionnaire"), legacy);
  const original = (globalThis as any)[GUIDANCE_HUMAN_KEY];
  delete (globalThis as any)[GUIDANCE_HUMAN_KEY]; assert.throws(() => workerInteractionsService("questionnaire"), /refusing direct/);
  (globalThis as any)[GUIDANCE_HUMAN_KEY] = { ...original, isCurrentWorker: () => false }; assert.throws(() => workerInteractionsService("questionnaire"), /refusing direct/);
  (globalThis as any)[GUIDANCE_HUMAN_KEY] = original;
  worker.ctx.sessionManager.getSessionId = () => "foreign-session";
  assert.throws(() => workerInteractionsService("questionnaire"), /refusing direct/);
  worker.ctx.sessionManager.getSessionId = () => "worker-session";
  const saved = process.env[GUIDANCE_ENV]; process.env[GUIDANCE_ENV] = "foreign-binding";
  assert.throws(() => workerInteractionsService("questionnaire"), /refusing direct/);
  delete process.env[GUIDANCE_ENV]; assert.equal(workerInteractionsService("questionnaire"), legacy, "root keeps existing human lane");
  process.env[GUIDANCE_ENV] = saved; await worker.event("session_shutdown");
  assert.equal((globalThis as any)[GUIDANCE_HUMAN_KEY], undefined);
  assert.throws(() => workerInteractionsService("questionnaire"), /refusing direct/);
});

test("new worker with absent owner cannot fall back to a direct human or ancestor lane", async t => {
  const { execute } = await setup(t);
  process.env[GUIDANCE_ENV] = guidanceLaunchEnvironment(identity("missing-owner"))[GUIDANCE_ENV];
  const unavailable = harness("unavailable-worker"); guidanceWorker(unavailable.pi); await unavailable.event("session_start");
  let legacyCalls = 0;
  (globalThis as any)[WORKER_INTERACTIONS_KEY] = { protocol: 1, mode: "headless", workerEpoch: "legacy", request() { legacyCalls++; } };
  await assert.rejects(execute(unavailable, "request_guidance", { prompt: "Implementation question" }), /Owning coordinator guidance unavailable/);
  await assert.rejects(workerInteractionsService("questionnaire")!.request({ kind: "questionnaire", questions: [{ id: "q", prompt: "Human preference?", options: [], allowOther: true }] }), /no child-to-human fallback/);
  assert.equal(legacyCalls, 0); await unavailable.event("session_shutdown");
});

test("worker shutdown cancels actual structured promise; late coordinator reply rejected", async t => {
  const { worker, owner, notices, execute } = await setup(t);
  const waiting = execute(worker, "request_guidance", { prompt: "Implementation question" }); const record = await notices.next();
  const rejected = assert.rejects(waiting, /cancelled/); await worker.event("session_shutdown"); await rejected;
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(execute(owner, "guidance", { operation: "reply", target: guidanceTarget(record), replyId: "late", guidance: "Too late" }), /revision|unavailable/);
});

for (const mode of ["chain", "parallel"]) for (const cancelled of [false, true]) test(`headless ${mode} guidance yield ${cancelled ? "honors cancellation before later launches" : "preserves waiter and later children"}`, async () => {
  const { HeadlessForegroundManager } = await import("./headless-foreground.ts");
  const root = await mkdtemp(join(tmpdir(), "guidance-headless-")), notices = inbox();
  const broker = new GuidanceBroker("headless-parent", join(root, "guidance"), notices.put); await broker.start();
  let completions = 0;
  const manager: any = new HeadlessForegroundManager(join(root, "manager"), () => "native", () => true, 16, update => { if (update.completion) completions++; return true; });
  manager.owner = "headless-parent"; manager.ownerToken = "fixture";
  const prior = { launcher: process.env.PI_TUI_WORKER_LAUNCHER, mode: process.env.PI_TUI_WORKER_LAUNCH_MODE };
  process.env.PI_TUI_WORKER_LAUNCHER = "/fixture/not-executed"; process.env.PI_TUI_WORKER_LAUNCH_MODE = "none";
  const launched: string[] = []; let workerWait!: Promise<any>;
  manager.launchWorker = async (group: any, child: any) => {
    launched.push(child.childId); child.started = true; child.status = "running";
    if (launched.length === 1) {
      const binding = broker.bind({ ownerSessionId: group.owner, taskId: child.taskId, childId: child.childId, attempt: child.attempt, workerEpoch: "fixture-epoch" });
      workerWait = requestGuidance(binding, "fixture-runtime", { kind: "guidance", prompt: "Which helper?" }).then(answer => { child.status = "completed"; return answer; });
    } else child.status = "completed";
  };
  manager.observe = async () => {}; manager.readMessages = () => [{ role: "assistant", text: "first delivered" }];
  try {
    const params = mode === "chain" ? { chain: [{ task: "first" }, { task: "then {previous}" }] } : { tasks: Array.from({ length: 5 }, (_, index) => ({ task: `parallel ${index}` })) };
    const launch = manager.launch(params, "headless-parent", root);
    const record = await notices.next(); const yielded = await launch;
    const initial = mode === "chain" ? 1 : 4;
    assert.equal(yielded.details.guidance_waiting, true); assert.equal(launched.length, initial);
    const flights = [...manager.activeLaunches] as Promise<any>[]; assert.equal(flights.length, 1);
    if (cancelled) {
      const group = [...manager.groups.values()][0] as any; group.cancelled = true; for (const child of group.children) child.status = "cancelled";
      const rejected = assert.rejects(workerWait, /fixture explicit cancel/); broker.cancel(record.requestId, "fixture explicit cancel"); await rejected;
    } else {
      broker.reply(guidanceTarget(record), "headless-reply", { kind: "guidance", guidance: "Use helper" });
      assert.equal((await workerWait).guidance, "Use helper");
    }
    await Promise.all(flights);
    assert.equal(launched.length, cancelled ? initial : mode === "chain" ? 2 : 5, "retained scheduler respects continuation/cancellation after tool return");
    assert.equal(completions, 1, "early-return foreground completion must still notify coordinator");
    manager.notifyGuidanceCompletion([...manager.groups.values()][0]); assert.equal(completions, 1, "completion receipt deduplicates observer retries");
  } finally {
    await broker.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true });
    if (prior.launcher === undefined) delete process.env.PI_TUI_WORKER_LAUNCHER; else process.env.PI_TUI_WORKER_LAUNCHER = prior.launcher;
    if (prior.mode === undefined) delete process.env.PI_TUI_WORKER_LAUNCH_MODE; else process.env.PI_TUI_WORKER_LAUNCH_MODE = prior.mode;
  }
});

test("native TUI foreground yields with worker live, then exact reply resolves waiter", async () => {
  const { TuiNativeManager } = await import("./tui-native.ts");
  const root = await mkdtemp(join(tmpdir(), "guidance-tui-")), notices = inbox();
  const broker = new GuidanceBroker("tui-parent", join(root, "guidance"), notices.put); await broker.start();
  const manager: any = new TuiNativeManager(join(root, "manager"), () => "native", () => true, 16);
  manager.owner = "tui-parent";
  const prior = { launcher: process.env.PI_TUI_WORKER_LAUNCHER, mode: process.env.PI_TUI_WORKER_LAUNCH_MODE };
  process.env.PI_TUI_WORKER_LAUNCHER = "/fixture/not-executed"; process.env.PI_TUI_WORKER_LAUNCH_MODE = "none";
  manager.tmux.resolveCaller = async () => ({ socketPath: "/fixture/not-opened", serverEpoch: "1", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "a".repeat(64) });
  let workerWait!: Promise<any>, child: any;
  manager.refresh = async () => {
    const group = [...manager.groups.values()][0] as any; child = group.children[0]; child.state = "running"; child.started = true;
    workerWait = requestGuidance(broker.bind({ ownerSessionId: group.owner, taskId: child.taskId, childId: child.childId, attempt: child.attempt, workerEpoch: "tui-epoch" }), "tui-runtime", { kind: "guidance", prompt: "Which helper?" });
  };
  try {
    const launch = manager.launch({ task: "implementation" }, "tui-parent", root);
    const record = await notices.next(); const yielded = await launch;
    assert.equal(yielded.details.guidance_waiting, true); assert.equal(child.state, "running");
    broker.reply(guidanceTarget(record), "tui-reply", { kind: "guidance", guidance: "Use helper" });
    assert.equal((await workerWait).guidance, "Use helper"); child.state = "completed";
    const group = [...manager.groups.values()][0] as any;
    assert.equal(group.background, false, "guidance yield is not implicit background promotion");
    let completions = 0; manager.notify = (update: any) => { if (update.completion) completions++; return true; };
    manager.notifyTerminal(group, child); manager.notifyTerminal(group, child);
    assert.equal(completions, 1, "early-return foreground completion must still notify coordinator exactly once");
  } finally {
    await broker.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true });
    if (prior.launcher === undefined) delete process.env.PI_TUI_WORKER_LAUNCHER; else process.env.PI_TUI_WORKER_LAUNCHER = prior.launcher;
    if (prior.mode === undefined) delete process.env.PI_TUI_WORKER_LAUNCH_MODE; else process.env.PI_TUI_WORKER_LAUNCH_MODE = prior.mode;
  }
});

test("all native launch paths explicitly bind guidance and activate worker tool", async () => {
  // Entrypoint contract coverage complements real shared-tool/socket tests above.
  const native = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const tui = await readFile(new URL("./tui-worker-tmux.ts", import.meta.url), "utf8");
  const headless = await readFile(new URL("./headless-foreground.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("./tui-worker-extension.ts", import.meta.url), "utf8");
  assert.match(native, /nativeHelperEntrypoint\("guidance-worker"/); assert.match(native, /guidanceLaunchEnvironment\(\{ ownerSessionId, taskId: taskRecord.taskId/);
  assert.match(native, /workerEpoch: spec.goalExecution\?\.binding.identity.workerEpoch/); assert.match(native, /goalId: spec.goalExecution.binding.entryId/);
  assert.match(tui, /guidanceLaunchEnvironment\(\{ ownerSessionId: input.ownerSessionId/);
  assert.match(headless, /guidanceLaunchEnvironment\(\{ ownerSessionId: group.owner/);
  assert.match(worker, /guidanceWorker\(pi\)/); assert.match(worker, /headlessTools, "notify_parent", "task_outcome", "request_guidance"/);
});
