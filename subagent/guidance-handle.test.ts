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
import { guidanceHandle } from "./guidance.ts";

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
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>(), entries: any[] = [];
  const ctx: any = { mode: "tui", hasUI: false, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } };
  const pi: any = { appendEntry(customType: string, data: unknown) { entries.push({type:"custom",customType,data}); }, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } };
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

test("coordinators reply by opaque handle; duplicates, stale, foreign and malformed handles fail closed", async t => {
  const { worker, owner, notices, execute } = await setup(t);
  const waiting = execute(worker, "request_guidance", { prompt: "Which branch?" }); const record = await notices.next();
  const listed = JSON.parse((await execute(owner, "guidance", { operation: "list" })).content[0].text);
  const handle = listed.records[0].handle;
  assert.equal(handle, guidanceHandle(record)); assert.equal(listed.records[0].target, undefined, "list no longer hands out the routing target");
  await assert.rejects(execute(owner, "guidance", { operation: "reply", handle, target: guidanceTarget(record), replyId: "r", guidance: "x" }), /not both/);
  await assert.rejects(execute(owner, "guidance", { operation: "reply", handle: "guidance-" + "0".repeat(24), replyId: "r", guidance: "x" }), /Unknown, stale or foreign/);
  await assert.rejects(execute(owner, "guidance", { operation: "reply", handle: guidanceHandle({ ...record, ownerSessionId: "someone-else" }), replyId: "r", guidance: "x" }), /Unknown, stale or foreign/);
  await assert.rejects(execute(owner, "guidance", { operation: "reply", handle: guidanceHandle({ ...record, attempt: record.attempt + 1 }), replyId: "r", guidance: "x" }), /Unknown, stale or foreign/);
  await assert.rejects(execute(owner, "guidance", { operation: "human", handle, guidance: "model consent" }), /no model answer/);
  await execute(owner, "guidance", { operation: "reply", handle, replyId: "reply", guidance: "Use main." });
  assert.equal((await waiting).content[0].text, "Use main.");
  // Same reply again is idempotent; a different answer to the settled request is rejected.
  await execute(owner, "guidance", { operation: "reply", handle, replyId: "reply", guidance: "Use main." });
  await assert.rejects(execute(owner, "guidance", { operation: "reply", handle, replyId: "other", guidance: "Use dev." }));
});
