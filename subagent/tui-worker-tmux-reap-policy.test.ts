import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiWorkerTmux } from "./tui-worker-tmux.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-reap-policy-"));
  const manifest: any = {
    protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, attempt: 1,
    workerEpoch: "c".repeat(32), controlToken: "d".repeat(64), controlSocket: join(root, "control.sock"),
    sessionFile: join(root, "session.jsonl"), presentation: "background",
    placement: { socketPath: "/fixture/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
  };
  const store = new TuiWorkerStore(root, true);
  store.writeManifest(manifest);
  const state = store.readState();
  state.sealed = true;
  state.reapReservation = "reservation";
  state.jobCleanup = { workerEpoch: manifest.workerEpoch, artifact: store.artifact("job-cleanup", 1,
    { workerEpoch: manifest.workerEpoch, report: { jobs: [], subagents: { groups: [] } } }) };
  store.writeState(state);
  const tmux = new TuiWorkerTmux();
  const calls: string[] = [];
  let inspections = 0;
  (tmux as any).inspect = async () => { inspections++; return { dead: true, placement: manifest.placement, panePid: 123, processToken: "123:fixture" }; };
  (tmux as any).run = async (_socket: string, args: string[]) => { calls.push(args[0] === "if-shell" ? "kill-pane" : args[0]); return ""; };
  return { root, manifest, store, tmux, calls, resetInspections() { inspections = 0; } };
}

test("verified dead-pane reap runs worktree callback before kill and retains pane on callback failure", async () => {
  const f = await fixture();
  try {
    let cleanup = 0;
    await assert.rejects(f.tmux.reap(f.manifest, undefined, { beforeRemove: async () => { cleanup++; throw new Error("registry unavailable"); } }), /registry unavailable/);
    assert.equal(cleanup, 1);
    assert.equal(f.calls.includes("kill-pane"), false, "failed registry cleanup must preserve the dead coordinator pane");
    f.calls.length = 0;
    f.resetInspections();
    await f.tmux.reap(f.manifest, undefined, { beforeRemove: async () => { f.calls.push("worktree-cleanup"); } });
    assert.deepEqual(f.calls.slice(0, 2), ["worktree-cleanup", "kill-pane"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("force does not bypass required cleanup callback or the post-cleanup activity recheck", async () => {
  const f = await fixture();
  try {
    let cleaned = 0;
    await assert.rejects(f.tmux.reap(f.manifest, undefined, { force: true, reason: "audit", beforeRemove: async () => { cleaned++; throw new Error("force cleanup blocked"); } }), /force cleanup blocked/);
    assert.equal(cleaned, 1);
    assert.equal(f.calls.includes("kill-pane"), false);

    f.calls.length = 0;
    f.resetInspections();
    // The pane is dead before cleanup but becomes live before the destructive boundary.
    (f.tmux as any).inspect = async () => ({ dead: inspections++ === 0, placement: f.manifest.placement, panePid: 123, processToken: "123:fixture" });
    let inspections = 0;
    await assert.rejects(f.tmux.reap(f.manifest, undefined, { force: true, reason: "audit", beforeRemove: async () => { cleaned++; } }), /Worker is active/);
    assert.equal(cleaned, 2);
    assert.equal(f.calls.includes("kill-pane"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
