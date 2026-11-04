// Test-only actual dedicated-goal executor probe. All state belongs to the
// disposable native-profile fixture; all provider responses are synthetic.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import workflows from "../workflows/index.ts";
import progress from "../progress/index.ts";

async function dispatchRows(childId: string) {
  return (await readFile(process.env.PROFILE_FIXTURE_LOG!, "utf8")).split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.role === "child" && row.childId === childId);
}

async function retainedManagedChild(child: any, owner: string) {
  const root = process.env.PI_TUI_WORKER_STATE_ROOT!;
  const group = JSON.parse(await readFile(join(root, "groups", `${child.jobId}.json`), "utf8"));
  assert.equal(group.owner, owner);
  const record = group.children.find((value: any) => value.taskId === child.taskId);
  assert.equal(record?.childId, child.childId);
  assert.equal(record?.attempt, child.attempt);
  // Keep private manager/control credentials out of the fixture proof log.
  const { model, systemPrompt, tools, cleanupWorktreesOnReap } = record.spec;
  return { spec: { model, systemPrompt, tools, cleanupWorktreesOnReap } };
}

async function dispatched(childId: string, occurrence = 1) {
  const file = process.env.PROFILE_FIXTURE_LOG!;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
    const check = async () => {
      try {
        if ((await dispatchRows(childId)).length >= occurrence) finish();
      } catch (error) { finish(error as Error); }
    };
    const watcher = watch(file, () => { void check(); });
    const timer = setTimeout(() => finish(new Error(`No synthetic dedicated request for ${childId}`)), 20000);
    void check();
  });
}

export function registerDedicatedCoordinatorProbe(pi: any, append: (row: any) => Promise<void>) {
  progress(pi);
  workflows(pi);
  pi.registerTool({ name: "fixture_dedicated_probe", label: "Offline dedicated coordinator probe", description: "Test-owned dedicated coordinator launch and resume", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) {
      const executor = (globalThis as any).__paeDelegatedGoalExecutorV1;
      assert(executor, "actual subagent session_start must install the dedicated executor");
      const entry = { id: randomUUID(), revision: 1, text: "Offline deterministic coordinator role fixture", status: "paused", tasks: [], child: null as any,
        tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null,
        continuationLimits: { automaticTurns: null, noProgressTurns: null } };
      const owner = ctx.sessionManager.getSessionId();
      entry.child = await executor.start(entry);
      await dispatched(entry.child.childId);
      const firstChild = structuredClone(entry.child);
      const first = await retainedManagedChild(firstChild, owner);
      assert.equal(first.spec.model, "offline-profile-fixture/gpt-6.1-sol:high");
      assert.equal(first.spec.cleanupWorktreesOnReap, true);
      await executor.pause(entry);
      await executor.verifyStopped(entry);
      const paused = await executor.observe(entry);
      assert.equal(paused.status, "paused");
      assert.equal(paused.executionStopped, true);
      const beforeResume = (await dispatchRows(entry.child.childId)).length;
      // This edit must affect NEW launches, never this retained coordinator.
      await writeFile(join(getAgentDir(), "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Changed offline fixture\nmodel: gpt-6-astra\nthinking: low\n---\nCHANGED_COORDINATOR_MUST_NOT_REPLACE_RETAINED\n");
      entry.child = await executor.resume(entry);
      // The ordinary managed Goal path retains its stopped, live worker. Goal
      // activation changes; task/child/attempt/worker authority must NOT change.
      assert.deepEqual(entry.child, firstChild);
      await dispatched(entry.child.childId, beforeResume + 1);
      const active = await executor.observe(entry);
      assert.equal(active.goalId, paused.goalId);
      assert.notEqual(active.activationId, paused.activationId);
      assert.equal(typeof active.activationId, "string");
      const resumed = await retainedManagedChild(entry.child, owner);
      assert.deepEqual(resumed.spec, first.spec);
      for (const field of ["taskId", "childId", "jobId", "attempt"]) {
        const stale = structuredClone(entry);
        const value = stale.child[field];
        stale.child[field] = field === "attempt" ? value + 1 : value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
        await assert.rejects(executor.observe(stale), /Stale dedicated goal child binding/);
      }
      await assert.rejects(executor.start(entry), /already has a child/);
      await executor.pause(entry);
      await executor.verifyStopped(entry);
      await append({ event: "dedicated_probe", first: { child: firstChild, spec: first.spec, dispatchIndex: 0 }, resumed: { child: entry.child, spec: resumed.spec, dispatchIndex: beforeResume }, sameManagedWorker: true, activationChanged: true, exactChildFencing: true, verifiedStopped: true, network: false });
      return { content: [{ type: "text", text: "Actual dedicated coordinator launch/resume and exact-child fencing passed" }], details: {} };
    },
  });
}
