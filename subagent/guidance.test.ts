import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuidanceBroker, guidanceTarget, requestGuidance, guidanceLaunchEnvironment, GUIDANCE_ENV, validateGuidanceInput } from "./guidance.ts";
import type { GuidanceRecord, GuidanceInput } from "./guidance.ts";

const input: GuidanceInput = { kind: "guidance", prompt: "Which existing helper implements the assigned parser?", context: "Implementation only; no new product preference." };
const human: GuidanceInput = { kind: "human", questionnaire: { kind: "questionnaire", questions: [{ id: "preference", prompt: "Which output style do you prefer?", allowOther: false, options: [{ value: "compact", label: "Compact" }] }] } };
const humanAnswer = { kind: "questionnaire" as const, cancelled: false, answers: [{ id: "preference", value: "compact", wasCustom: false }] };
const identity = (ownerSessionId: string, n = 1) => ({ ownerSessionId, taskId: `task-${n}`, childId: `child-${n}`, attempt: 1, workerEpoch: `worker-${n}` });
function inbox() {
  const buffered: GuidanceRecord[] = []; const waiters: Array<(record: GuidanceRecord) => void> = [];
  return { notify(record: GuidanceRecord) { const waiter = waiters.shift(); if (waiter) waiter(record); else buffered.push(record); }, next() { return buffered.length ? Promise.resolve(buffered.shift()!) : new Promise<GuidanceRecord>(resolve => waiters.push(resolve)); }, buffered };
}
async function fixture(t: any, owner = "root", upstream?: any) {
  const root = await mkdtemp(join(tmpdir(), "guidance-test-")), notices = inbox();
  const broker = new GuidanceBroker(owner, root, notices.notify, upstream); await broker.start();
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }); });
  return { broker, root, notices };
}

test("actual waiter awaits exact owner reply; request/receipt durable before notification/resolution", async t => {
  const { broker, root, notices } = await fixture(t); const binding = broker.bind(identity("root"));
  let resolved = false;
  const promise = requestGuidance(binding, "process-1", input).then(answer => { resolved = true; return answer; });
  const record = await notices.next(); assert.equal(resolved, false);
  const files = await import("node:fs/promises").then(fs => fs.readdir(root));
  const journal = join(root, files[0], "guidance.json");
  assert.equal(JSON.parse(await readFile(journal, "utf8")).records[0].status, "pending");
  const target = guidanceTarget(record), answer = { kind: "guidance" as const, guidance: "Use parseExisting; retain the current grammar." };
  const receipt = broker.reply(target, "reply-1", answer);
  assert.equal(receipt.status, "answered");
  assert.equal(JSON.parse(await readFile(journal, "utf8")).records[0].receipt.replyId, "reply-1");
  assert.deepEqual(await promise, answer);
  assert.deepEqual(broker.reply(target, "reply-1", answer), receipt);
  assert.throws(() => broker.reply(target, "reply-1", { ...answer, guidance: "Different" }), /Conflicting/);
  assert.throws(() => broker.reply(target, "reply-2", answer), /Conflicting/);
});

test("two-level ordinary guidance resolves both waiters without human interaction", async t => {
  const top = await fixture(t), parentBinding = top.broker.bind(identity("root"));
  const middle = await fixture(t, "middle", Object.assign((value: GuidanceInput, signal?: AbortSignal, requestId?: string) => requestGuidance(parentBinding, "middle-runtime", value, signal, requestId), { scope: parentBinding.scope }));
  const child = middle.broker.bind(identity("middle", 2));
  const waiting = requestGuidance(child, "child-runtime", input);
  const local = await middle.notices.next(); assert.equal(top.notices.buffered.length, 0, "ordinary work first routes only to direct parent");
  const forwarding = middle.broker.forward(guidanceTarget(local));
  const escalated = await top.notices.next(); assert.equal(escalated.input.kind, "guidance");
  assert.deepEqual(middle.broker.list()[0].forwarded, { requestId: escalated.requestId, scope: parentBinding.scope });
  const answer = { kind: "guidance" as const, guidance: "Reuse the existing parser; this is within the delegated assignment." };
  top.broker.reply(guidanceTarget(escalated), "top-reply", answer);
  await forwarding; assert.deepEqual(await waiting, answer);
  assert.equal(middle.broker.list()[0].status, "answered");
});

test("genuine human question automatically reaches only top level and returns exact human result", async t => {
  const top = await fixture(t), parentBinding = top.broker.bind(identity("root"));
  const middle = await fixture(t, "middle", Object.assign((value: GuidanceInput, signal?: AbortSignal, requestId?: string) => requestGuidance(parentBinding, "middle-runtime", value, signal, requestId), { scope: parentBinding.scope }));
  const waiting = requestGuidance(middle.broker.bind(identity("middle", 2)), "child-runtime", human);
  const escalated = await top.notices.next(); assert.equal(escalated.input.kind, "human"); assert.equal(middle.notices.buffered.length, 0);
  assert.throws(() => top.broker.reply(guidanceTarget(escalated), "model-answer", { kind: "guidance", guidance: "compact" }), /Human decision/);
  await assert.rejects(middle.broker.askHuman(guidanceTarget(middle.broker.list()[0]), async () => humanAnswer), /top-level/);
  let asked = 0;
  await top.broker.askHuman(guidanceTarget(escalated), async value => { asked++; assert.deepEqual(value, human.questionnaire); return humanAnswer; });
  assert.deepEqual(await waiting, { kind: "human", answer: humanAnswer }); assert.equal(asked, 1);
});

test("exact session/task/child/attempt/epochs/goal/request/revision fencing", async t => {
  const { broker, notices } = await fixture(t); const binding = broker.bind({ ...identity("root"), goalId: "goal-1" });
  const waiting = requestGuidance(binding, "worker-runtime", input); const record = await notices.next(), target = guidanceTarget(record);
  const answer = { kind: "guidance" as const, guidance: "Use existing implementation" };
  for (const key of ["ownerSessionId", "ownerRuntimeEpoch", "taskId", "childId", "workerEpoch", "goalId", "requestId", "workerRuntimeEpoch"] as const) assert.throws(() => broker.reply({ ...target, [key]: "foreign" }, "reply", answer), /identity/);
  assert.throws(() => broker.reply({ ...target, attempt: 2 }, "reply", answer), /identity/);
  assert.throws(() => broker.reply({ ...target, expectedRevision: 2 }, "reply", answer), /revision/);
  assert.throws(() => broker.reply({ ...target, permission: true } as any, "reply", answer), /Unexpected/);
  for (const scope of [{ ...binding.scope, childId: "foreign" }, { ...binding.scope, ownerRuntimeEpoch: "old" }]) await assert.rejects(requestGuidance({ ...binding, scope }, "worker-runtime", input), /scope/);
  broker.reply(target, "good", answer); await waiting;
});

test("permission payloads and model-supplied human answers never enter guidance", async t => {
  const { broker, notices } = await fixture(t); const waiting = requestGuidance(broker.bind(identity("root")), "worker-runtime", input); const record = await notices.next();
  for (const value of [{ kind: "permission", value: "allow" }, { ...input, permission: "approve" }, { kind: "human", questionnaire: { kind: "permission", title: "Allow", options: ["yes"] } }]) assert.throws(() => validateGuidanceInput(value as any), /permission|Unexpected/);
  for (const answer of [{ kind: "human", answer: humanAnswer }, { kind: "guidance", guidance: "ok", approved: true }]) assert.throws(() => broker.reply(guidanceTarget(record), "reply", answer as any), /Unexpected/);
  broker.reply(guidanceTarget(record), "good", { kind: "guidance", guidance: "No permission granted" }); await waiting;
});

test("explicit abort retains cancelled state and rejects stale answers", async t => {
  const { broker, notices } = await fixture(t), controller = new AbortController();
  const waiting = requestGuidance(broker.bind(identity("root")), "worker-runtime", input, controller.signal); const record = await notices.next();
  controller.abort(); await assert.rejects(waiting, /cancelled/);
  // Socket-close callbacks execute on the next event-loop iteration, not sleeps.
  for (let i = 0; i < 20 && broker.list()[0].status === "pending"; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.list()[0].status, "cancelled");
  assert.throws(() => broker.reply(guidanceTarget(record), "late", { kind: "guidance", guidance: "late" }), /revision|unavailable/);
});

test("parent replacement, worker restart, attempt replacement, absent owner never replay", async t => {
  const { broker, root, notices } = await fixture(t); const binding = broker.bind(identity("root"));
  const waiting = requestGuidance(binding, "runtime-1", input); const record = await notices.next();
  await assert.rejects(requestGuidance(binding, "runtime-2", input), /runtime replaced/);
  const replaced = broker.bind({ ...identity("root"), attempt: 2, workerEpoch: "new-worker" });
  await assert.rejects(waiting, /attempt replaced/); assert.equal(broker.list()[0].status, "cancelled");
  await assert.rejects(requestGuidance(binding, "runtime-1", input), /scope/);
  const second = requestGuidance(replaced, "runtime-2", input); await notices.next();
  const rejected = assert.rejects(second, /closed|unavailable/); await broker.close(); await rejected;
  const restored = new GuidanceBroker("root", root); await restored.start();
  assert.equal(restored.list().at(-1)?.status, "unavailable");
  assert.throws(() => restored.reply(guidanceTarget(record), "old-owner", { kind: "guidance", guidance: "old" }), /identity/);
  await assert.rejects(requestGuidance(replaced, "runtime-2", input), /ENOENT|unavailable/);
  await restored.close();
});

test("crash-retained pending records become unavailable without recreating promises", async t => {
  const { broker, root, notices } = await fixture(t);
  const waiting = requestGuidance(broker.bind(identity("root")), "runtime", input); const record = await notices.next();
  const journal = join(root, (await readdir(root))[0], "guidance.json");
  const beforeCrash = await readFile(journal, "utf8");
  const rejected = assert.rejects(waiting, /closed|unavailable/); await broker.close(); await rejected;
  // Reproduce the last fsynced image from before abrupt owner death.
  await writeFile(journal, beforeCrash, { mode: 0o600 });
  const recovered = new GuidanceBroker("root", root); await recovered.start();
  assert.equal(recovered.list()[0].status, "unavailable");
  assert.equal(JSON.parse(await readFile(journal, "utf8")).records[0].status, "unavailable");
  assert.throws(() => recovered.reply(guidanceTarget(record), "stale", { kind: "guidance", guidance: "no replay" }), /identity/);
  await recovered.close();
});

test("failed receipt persistence cannot resolve/replay the waiter", async t => {
  const { broker, notices } = await fixture(t);
  const waiting = requestGuidance(broker.bind(identity("root")), "runtime", input); const record = await notices.next();
  const persist = (broker as any).persist.bind(broker);
  (broker as any).persist = () => { throw new Error("fixture fsync failed"); };
  const rejected = assert.rejects(waiting, /unavailable/);
  assert.throws(() => broker.reply(guidanceTarget(record), "reply", { kind: "guidance", guidance: "not delivered" }), /fsync/);
  await rejected; assert.equal(broker.list()[0].status, "unavailable");
  assert.throws(() => broker.reply(guidanceTarget(record), "reply", { kind: "guidance", guidance: "not delivered" }), /receipt unavailable/);
  (broker as any).persist = persist;
});

test("concurrent human invocation is single-flight; no human result replay on failure", async t => {
  const { broker, notices } = await fixture(t);
  const waiting = requestGuidance(broker.bind(identity("root")), "runtime", human); const record = await notices.next();
  let answer!: (value: typeof humanAnswer) => void;
  const first = broker.askHuman(guidanceTarget(record), async () => await new Promise(resolve => { answer = resolve; }));
  await assert.rejects(broker.askHuman(guidanceTarget(record), async () => humanAnswer), /already in flight/);
  answer(humanAnswer); await first; assert.equal((await waiting).kind, "human");
  await assert.rejects(broker.askHuman(guidanceTarget(record), async () => humanAnswer), /pending waiter/);
});

test("another live owner cannot overwrite the journal or invalidate its pending waiter", async t => {
  const { broker, notices, root } = await fixture(t);
  const waiting = requestGuidance(broker.bind(identity("root")), "runtime", input); const record = await notices.next();
  assert.throws(() => new GuidanceBroker("root", root), /Another live runtime/);
  assert.equal(broker.list()[0].status, "pending");
  broker.reply(guidanceTarget(record), "reply", { kind: "guidance", guidance: "exact owner" }); await waiting;
});

test("launch binding registry explicitly fences absent owner instead of inheriting ancestor capability", async t => {
  assert.deepEqual(JSON.parse(guidanceLaunchEnvironment(identity("absent"))[GUIDANCE_ENV]), { unavailable: true });
  const { broker } = await fixture(t);
  const env = guidanceLaunchEnvironment({ ...identity("root"), goalId: "goal-1" });
  const binding = JSON.parse(env[GUIDANCE_ENV]); assert.equal(binding.scope.ownerRuntimeEpoch, broker.epoch); assert.equal(binding.scope.goalId, "goal-1");
});
