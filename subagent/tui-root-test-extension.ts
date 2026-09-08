import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { sharedBackgroundSubagentManager } from "./background.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import subagent from "./index.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

/** Explicit real-root integration fixture. Never enabled outside tests. */
export default function rootTest(pi: ExtensionAPI) {
  let tool: any;
  const commands = new Map<string, any>();
  const proxy = new Proxy(pi, { get(target, property) {
    if (property === "registerTool") return (value: any) => { if (value.name === "subagent") tool = value; return target.registerTool(value); };
    if (property === "registerCommand") return (name: string, value: any) => { commands.set(name, value); return target.registerCommand(name, value); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  subagent(proxy);
  const output = process.env.PI_TUI_ROOT_RESULT!;
  const backgroundFile = `${output}.background`;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const register = (name: string, work: (ctx: any) => Promise<unknown>) => pi.registerCommand(name, {
    description: "Deterministic root tool integration test",
    handler: async (_args, ctx) => {
      try { await writeFile(output, JSON.stringify({ ok: true, result: await work(ctx) })); }
      catch (error) { await writeFile(output, JSON.stringify({ ok: false, error: String(error), stack: (error as Error).stack })); }
    },
  });
  let sequence = 0;
  const execute = (ctx: any, params: any) => tool.execute(`root-test-${++sequence}`, params, undefined, undefined, ctx);
  const manifestFor = (group: any, index = 0) => new TuiWorkerStore(dirname(group.children[index].runtime.sessionFile)).readManifest();
  const wait = async (ctx: any, job: string) => {
    const value = await execute(ctx, { operation: "wait", job_id: job, wait_ms: 60_000 });
    assert.equal(value.details.group.status, "completed", JSON.stringify(value));
    return value.details.group;
  };
  register("tui-root-background", async ctx => {
    pi.setSessionName("tui-root-test");
    const gate = (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__;
    gate?.applyMode(ctx.sessionManager.getSessionId(), false);
    const started = await execute(ctx, { task: "WAIT_FOR_PARENT", model: "harness-test/mock:off", background: true });
    const deadline = Date.now() + 30_000;
    let group: any;
    while (Date.now() < deadline) {
      group = (await execute(ctx, { operation: "status", job_id: started.details.job_id })).details.group;
      if (group.children[0].runtime && group.children[0].status === "running") break;
      await sleep(100);
    }
    const manifest = manifestFor(group);
    const status = await callTuiWorker(manifest, { operation: "status" });
    assert.ok(status.ok);
    const saved = { rootPid: process.pid, job: started.details.job_id, childPid: (status.data as any).pid, sessionId: ctx.sessionManager.getSessionId() };
    await writeFile(backgroundFile, JSON.stringify(saved));
    return saved;
  });
  register("tui-root-check", async ctx => {
    const saved = JSON.parse(await readFile(backgroundFile, "utf8"));
    assert.equal(saved.sessionId, ctx.sessionManager.getSessionId());
    let group = (await execute(ctx, { operation: "status", job_id: saved.job })).details.group;
    assert.notEqual(group.children[0].status, "lost");
    const survivor = manifestFor(group);
    assert.equal((await callTuiWorker(survivor, { operation: "status" }) as any).data.pid, saved.childPid);
    await wait(ctx, saved.job);
    // Resume a still-live idle task preserves the exact Pi process.
    await execute(ctx, { operation: "resume", task_id: group.children[0].task_id, message: "Continue briefly", compact: false });
    assert.equal((await callTuiWorker(survivor, { operation: "status" }) as any).data.pid, saved.childPid);
    await wait(ctx, saved.job);
    await execute(ctx, { operation: "reap", job_id: saved.job });
    // Explicit resume after verified reap opens a new owned attempt from session.
    const resumed = await execute(ctx, { operation: "resume", task_id: group.children[0].task_id, message: "Continue after retained attempt", compact: false });
    const resumedGroup = await wait(ctx, resumed.details.job_id);
    assert.equal(resumedGroup.children[0].task_id, group.children[0].task_id);
    assert.equal(resumedGroup.children[0].attempt, 2);
    assert.notEqual((await callTuiWorker(manifestFor(resumedGroup), { operation: "status" }) as any).data.pid, saved.childPid);
    await execute(ctx, { operation: "reap", job_id: resumed.details.job_id });
    // Real root API inventory/waits must cover the legacy manager as well.
    const nativeWait = await execute(ctx, { task: "WAIT_FOR_PARENT mixed waits", model: "harness-test/mock:off", background: true });
    const legacyManager = sharedBackgroundSubagentManager(join(getAgentDir(), "state", "background-subagents-v1"));
    let finishLegacy!: (value: any) => void;
    const legacy = await legacyManager.start({ sessionId: ctx.sessionManager.getSessionId(), backend: "agentsh", mode: "single", summary: "Deterministic legacy wait fixture", children: [{ label: "legacy fixture" }] }, () => new Promise(resolve => { finishLegacy = resolve; }));
    const inventory = await execute(ctx, { operation: "list", limit: 50 });
    assert.ok(inventory.details.legacy_groups?.some((g: any) => g.job_id === legacy.id), JSON.stringify({ inventory, agentDir: getAgentDir(), roots: [...((globalThis as any).__paeBackgroundSubagentManagersV4?.keys() ?? [])] }));
    const anyWait = execute(ctx, { operation: "wait_any", wait_ms: 60_000 });
    await sleep(300); finishLegacy({ text: "legacy completed", failed: false });
    const anyResult = await anyWait;
    assert.equal(anyResult.details.job_id, legacy.id, JSON.stringify({ anyResult, legacy: await legacyManager.get(legacy.id) }));
    assert.equal(anyResult.details.timed_out, false);
    let finishSecond!: (value: any) => void;
    const second = await legacyManager.start({ sessionId: ctx.sessionManager.getSessionId(), backend: "agentsh", mode: "single", summary: "Second legacy fixture", children: [{ label: "second" }] }, () => new Promise(resolve => { finishSecond = resolve; }));
    const allWait = execute(ctx, { operation: "wait_all", wait_ms: 1000 });
    await sleep(300); finishSecond({ text: "second completed", failed: false });
    const mixed = await allWait;
    assert.equal(mixed.details.timed_out, true);
    assert.deepEqual(mixed.details.groups.map((g: any) => g.job_id).sort(), [nativeWait.details.job_id, second.id].sort());
    const complete = await execute(ctx, { operation: "wait_all", wait_ms: 60_000 });
    assert.equal(complete.details.timed_out, false);
    await execute(ctx, { operation: "reap", job_id: nativeWait.details.job_id });
    const gate = (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__;
    gate?.applyMode(ctx.sessionManager.getSessionId(), false);
    const localJobs = await execute(ctx, { task: "RUN_LOCAL_JOB", model: "harness-test/mock:off", background: true });
    const jobsGroup = await wait(ctx, localJobs.details.job_id);
    const jobsWorker = manifestFor(jobsGroup);
    const beforeJobs = (await callTuiWorker(jobsWorker, { operation: "status" }) as any).data;
    const localPid = beforeJobs.pid;
    const listJobs = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "list" } });
    assert.ok(listJobs.ok, JSON.stringify(listJobs));
    const ownedJobs = (listJobs as any).data.details.jobs;
    assert.equal(ownedJobs.length, 1, JSON.stringify(listJobs));
    const job = ownedJobs[0].job_id;
    const output = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "output", job_id: job } });
    assert.match((output as any).data.content[0].text, /child-job-marker/);
    // Parent-local controller must not access a child's job, even by known ID.
    const rootController = (globalThis as any).__paeLocalJobControllerV1;
    await assert.rejects(rootController.execute("foreign-job", { action: "output", job_id: job }), /different|own|session/i);
    await assert.rejects(rootController.execute("no-start", { action: "start", command: "false" }), /existing jobs/);
    assert.equal((await callTuiWorker({ ...jobsWorker, ownerSessionId: "foreign-parent" }, { operation: "jobs", params: { action: "list" } })).ok, false);
    assert.ok((await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "cancel", job_id: job } })).ok);
    const jobDone = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "wait", job_id: job, timeout_ms: 5000 } }, { timeoutMs: 10_000 });
    assert.equal((jobDone as any).data.details.status, "cancelled");
    assert.ok((await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "reap", job_id: job } })).ok);
    const afterJobs = (await callTuiWorker(jobsWorker, { operation: "status" }) as any).data;
    assert.equal(afterJobs.pid, localPid);
    assert.equal(afterJobs.sequence, beforeJobs.sequence, "Job controls must not start a model turn");
    await execute(ctx, { operation: "reap", job_id: localJobs.details.job_id });
    const parallel = await execute(ctx, { tasks: [
      { task: "ASSERT_READ_ONLY", model: "harness-test/mock:off", tools: ["read"] },
      { task: `${gate ? "RUN GUARDED CHECK " : ""}REPORT_OUTCOME`, model: "harness-test/mock:off", acceptance: ["fixture"] },
    ], background: true });
    const parallelGroup = await wait(ctx, parallel.details.job_id);
    assert.equal(parallelGroup.children[0].runtime.placement.windowId, parallelGroup.children[1].runtime.placement.windowId);
    const readOnly = await execute(ctx, { operation: "result", job_id: parallel.details.job_id, child: 1 });
    assert.equal(readOnly.content[0].text, "TOOLS:notify_parent,read,task_outcome");
    assert.equal(parallelGroup.children[1].task_outcome?.state, "delivered");
    if (gate) {
      const guarded = manifestFor(parallelGroup, 1);
      const transcript = await readFile(guarded.sessionFile, "utf8");
      assert.match(transcript, /guard-ok/);
      assert.equal((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled, false);
      gate.applyMode(ctx.sessionManager.getSessionId(), true);
      const deadline = Date.now() + 5000;
      while ((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled !== true && Date.now() < deadline) await sleep(100);
      assert.equal((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled, true);
    }
    // A real direct human turn invalidates the previous model-reported outcome.
    const human = manifestFor(parallelGroup, 1);
    const keys = async (m: any, ...args: string[]) => promisify(execFile)("tmux", ["-S", m.placement.socketPath, "send-keys", "-t", m.placement.paneId, ...args]);
    await keys(human, "-l", "WAIT_FOR_PARENT direct human scope change"); await keys(human, "Enter");
    await sleep(400);
    const direct = (await execute(ctx, { operation: "status", job_id: parallel.details.job_id })).details.group;
    assert.equal(direct.children[1].status, "running");
    assert.equal(direct.children[1].task_outcome, undefined);
    await keys(human, "Escape");
    const stopped = (await execute(ctx, { operation: "wait", job_id: parallel.details.job_id, wait_ms: 60_000 })).details.group;
    assert.equal(stopped.children[1].status, "cancelled");
    await execute(ctx, { operation: "reap", job_id: parallel.details.job_id });
    // Esc on the first chain step must not advance to the next assignment.
    const cancelledChain = await execute(ctx, { chain: [
      { task: "WAIT_FOR_PARENT human Esc", model: "harness-test/mock:off" },
      { task: "Must never start", model: "harness-test/mock:off" },
    ], background: true });
    const waiting = (await execute(ctx, { operation: "status", job_id: cancelledChain.details.job_id })).details.group;
    await sleep(400); await keys(manifestFor(waiting), "Escape");
    const cancelled = (await execute(ctx, { operation: "wait", job_id: cancelledChain.details.job_id, wait_ms: 60_000 })).details.group;
    assert.equal(cancelled.children[0].status, "cancelled");
    assert.equal(cancelled.children[1].status, "skipped");
    assert.equal(cancelled.children[1].runtime, undefined);
    await execute(ctx, { operation: "reap", job_id: cancelledChain.details.job_id });
    const chain = await execute(ctx, { chain: [
      { task: "First chain step", model: "harness-test/mock:off" },
      { task: "Second chain step uses {previous}", model: "harness-test/mock:off" },
    ], background: true });
    const chainGroup = await wait(ctx, chain.details.job_id);
    assert.equal(chainGroup.children[0].runtime.placement.windowId, chainGroup.children[1].runtime.placement.windowId);
    assert.match(await readFile(chainGroup.children[1].runtime.sessionFile, "utf8"), /Second chain step uses Deterministic/);
    await execute(ctx, { operation: "reap", job_id: chain.details.job_id });
    // Foreground still waits until explicit promotion; no second Pi is launched.
    const foreground = execute(ctx, { task: "WAIT_FOR_PARENT foreground", model: "harness-test/mock:off" });
    await sleep(100);
    await commands.get("background").handler("", ctx);
    const moved = await foreground;
    assert.equal(moved.details.group.background, true);
    await wait(ctx, moved.details.job_id);
    await execute(ctx, { operation: "reap", job_id: moved.details.job_id });
    const parentSession = await readFile(ctx.sessionManager.getSessionFile()!, "utf8");
    assert.doesNotMatch(parentSession, /tui-subagent-update/);
    const entries = parentSession.split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "harness-state").length, 0);
    assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "harness-state-receipt"));
    return { rootTool: true, guard: Boolean(gate), survivorPid: saved.childPid, parallel: parallel.details.job_id, chain: chain.details.job_id, resume: resumed.details.job_id };
  });
}
