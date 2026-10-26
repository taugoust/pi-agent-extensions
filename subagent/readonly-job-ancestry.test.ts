import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { atomicPrivateJson, TuiWorkerStore } from "./tui-worker-store.ts";
import { readJobAncestry, ownsJob } from "../shared/readonly-job-ancestry.ts";
function fixture(depth = 3) {
  const root = mkdtempSync(join(tmpdir(), "job-ancestry-"));
  mkdirSync(join(root, "groups"), { mode: 0o700 });
  const manifests: any[] = [], groups: any[] = [];
  for (let i = 0; i <= depth; i++) {
    const id = (i + 1).toString(16).padStart(24, "0"), nonce = id.padStart(64, "0");
    const directory = join(root, "workers", id), store = new TuiWorkerStore(directory, true);
    const owner = i === depth ? "unrelated" : `session-${i}`;
    const manifest = { protocol: 1, ownerSessionId: owner, taskId: `subagent-task-${id}`, runtimeId: `runtime-${i}`,
      groupId: `subagent-job-${id}`, childId: `subagent-child-${id}`, attempt: 1, workerEpoch: id.padStart(32, "0"), controlToken: nonce,
      controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), presentation: "background", launchMode: "none",
      operatorCapabilityHash: createHash("sha256").update(nonce).digest("hex"),
      placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: `@${i}`, paneId: `%${i}`, ownershipNonce: nonce } };
    store.writeManifest(manifest as any);
    writeFileSync(manifest.sessionFile, JSON.stringify({ type: "session", id: `session-${i + 1}` }) + "\n", { mode: 0o600 });
    const group = { version: 1, id: manifest.groupId, owner, children: [{ taskId: manifest.taskId, childId: manifest.childId,
      directory, attempt: 1, started: true, reaped: i % 2 === 0, operatorCapability: nonce }] };
    atomicPrivateJson(join(root, "groups", `${group.id}.json`), group);
    manifests.push(manifest); groups.push(group);
  }
  return { root, manifests, groups, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("verified direct, nested and grandchild sessions and broker child identities; unrelated and infrastructure excluded", () => {
  const f = fixture(); try {
    const proof = readJobAncestry(f.root, "session-0");
    for (let i = 0; i <= 3; i++) assert.ok(ownsJob(proof.owners, { sessionId: `session-${i}` }));
    for (let i = 0; i < 3; i++) assert.ok(ownsJob(proof.owners, { sessionId: `session-${i}`, childId: f.manifests[i].childId }));
    assert.equal(ownsJob(proof.owners, { sessionId: "unrelated" }), false);
    assert.equal(ownsJob(proof.owners, { sessionId: "session-0", childId: f.manifests[3].childId }), false);
    assert.equal(ownsJob(proof.owners, { sessionId: "session-3", infrastructure: true }), false);
    assert.equal(readJobAncestry(f.root, "session-0").fingerprint, proof.fingerprint);
  } finally { f.close(); }
});
test("iterative ancestry crosses old depth32 limit, retaining idle/reaped evidence", () => {
  const f = fixture(45); try { assert.ok(ownsJob(readJobAncestry(f.root, "session-0").owners, { sessionId: "session-45" })); } finally { f.close(); }
});
test("changed nonce/attempt/header, cycles and unsafe files fail closed", () => {
  const f = fixture(); try {
    const before = readJobAncestry(f.root, "session-0").fingerprint;
    writeFileSync(f.manifests[2].sessionFile, '{"type":"session","id":"new-session"}\n', { mode: 0o600 });
    assert.notEqual(readJobAncestry(f.root, "session-0").fingerprint, before);
    writeFileSync(f.manifests[2].sessionFile, '{"type":"session","id":"session-0"}\n');
    const cyclic = readJobAncestry(f.root, "session-0");
    assert.equal(cyclic.owners.filter(owner => owner.sessionId === "session-0" && !owner.childId).length, 1);
    assert.equal(ownsJob(cyclic.owners, { sessionId: "session-3" }), false);
    writeFileSync(f.manifests[2].sessionFile, '{"type":"session","id":"session-3"}\n');
    f.groups[1].children[0].operatorCapability = "f".repeat(64);
    atomicPrivateJson(join(f.root, "groups", `${f.groups[1].id}.json`), f.groups[1]);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
    assert.equal(ownsJob(readJobAncestry(f.root, "session-0").owners, { sessionId: "session-2" }), false);
    f.groups[1].children[0].operatorCapability = f.manifests[1].controlToken;
    f.groups[1].children[0].attempt = 2;
    atomicPrivateJson(join(f.root, "groups", `${f.groups[1].id}.json`), f.groups[1]);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
  } finally { f.close(); }
});
test("headless foreground retained nonce evidence authorizes its session, not unrelated workers", () => {
  const f = fixture(); try {
    mkdirSync(join(f.root, "headless-groups"), { mode: 0o700 });
    const group = f.groups[0], manifest = f.manifests[0];
    group.ownerToken = "parent-process-token";
    group.children[0].launcherToken = "123:456"; group.children[0].launcherPid = 123;
    manifest.execution = "rpc-headless"; manifest.operatorCapabilityHash = undefined;
    manifest.processToken = "123:456"; manifest.processPid = 123;
    manifest.foregroundOwner = { pid: 321, token: group.ownerToken };
    atomicPrivateJson(join(f.root, "groups", `${group.id}.json`), group);
    renameSync(join(f.root, "groups", `${group.id}.json`), join(f.root, "headless-groups", `${group.id}.json`));
    atomicPrivateJson(join(group.children[0].directory, "manifest.json"), manifest);
    assert.ok(ownsJob(readJobAncestry(f.root, "session-0").owners, { sessionId: "session-3" }));
    manifest.processToken = "123:789";
    atomicPrivateJson(join(group.children[0].directory, "manifest.json"), manifest);
    const stale = readJobAncestry(f.root, "session-0");
    assert.equal(stale.unavailable, true); assert.equal(ownsJob(stale.owners, { sessionId: "session-1" }), false);
  } finally { f.close(); }
});
test("non-regular evidence cannot block read-only discovery", () => {
  const f = fixture(); try {
    const path = f.manifests[0].sessionFile;
    rmSync(path); assert.equal(spawnSync("mkfifo", ["-m", "600", path]).status, 0);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
    const manifest = join(f.groups[0].children[0].directory, "manifest.json");
    rmSync(manifest); assert.equal(spawnSync("mkfifo", ["-m", "600", manifest]).status, 0);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
  } finally { f.close(); }
});
test("symlinked worker/session paths and public files grant no ownership", () => {
  const f = fixture(); try {
    chmodSync(f.manifests[0].sessionFile, 0o644);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
    assert.equal(ownsJob(readJobAncestry(f.root, "session-0").owners, { sessionId: "session-1" }), false);
    chmodSync(f.manifests[0].sessionFile, 0o600);
    rmSync(f.manifests[0].sessionFile);
    symlinkSync(f.manifests[1].sessionFile, f.manifests[0].sessionFile);
    assert.equal(readJobAncestry(f.root, "session-0").unavailable, true);
  } finally { f.close(); }
});
