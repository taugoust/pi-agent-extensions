// Test-only actual dedicated-goal executor probe. All state belongs to the
// disposable native-profile fixture; all provider responses are synthetic.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NativeTaskStore } from "../subagent/resume.ts";
import workflows from "../workflows/index.ts";
import progress from "../progress/index.ts";

async function dispatched(childId: string) {
  const file = process.env.PROFILE_FIXTURE_LOG!;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
    const check = async () => {
      try {
        const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        if (rows.some(row => row.role === "child" && row.childId === childId)) finish();
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
        tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null };
      const store = new NativeTaskStore(join(getAgentDir(), "state", "native-tasks-v1"));
      const owner = ctx.sessionManager.getSessionId();
      entry.child = await executor.start(entry);
      await dispatched(entry.child.childId);
      const first = store.get(owner, entry.child.taskId);
      assert.equal(first.spec.model, "offline-profile-fixture/gpt-6.1-sol:high");
      assert.match(first.spec.systemPrompt!, /single-coordinator execution controls/);
      await executor.pause(entry);
      const stale = structuredClone(entry);
      // This edit must affect NEW launches, never this retained coordinator.
      await writeFile(join(getAgentDir(), "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Changed offline fixture\nmodel: gpt-6-astra\nthinking: low\n---\nCHANGED_COORDINATOR_MUST_NOT_REPLACE_RETAINED\n");
      entry.child = await executor.resume(entry);
      assert.equal(entry.child.taskId, stale.child.taskId);
      assert.equal(entry.child.attempt, stale.child.attempt + 1);
      assert.notEqual(entry.child.childId, stale.child.childId);
      await dispatched(entry.child.childId);
      const resumed = store.get(owner, entry.child.taskId);
      assert.equal(resumed.spec.model, first.spec.model);
      assert.equal(resumed.spec.systemPrompt, first.spec.systemPrompt);
      assert.deepEqual(resumed.spec.tools, first.spec.tools);
      await assert.rejects(executor.observe(stale), /Stale dedicated goal child binding/);
      await assert.rejects(executor.start(entry), /already has a child/);
      await executor.pause(entry);
      await store.verifyStopped(owner, entry.child.taskId, entry.child.childId, entry.child.attempt);
      await append({ event: "dedicated_probe", first: { child: stale.child, spec: first.spec }, resumed: { child: entry.child, spec: resumed.spec }, exactChildFencing: true, verifiedStopped: true, network: false });
      return { content: [{ type: "text", text: "Actual dedicated coordinator launch/resume and exact-child fencing passed" }], details: {} };
    },
  });
}
