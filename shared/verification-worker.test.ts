import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readNativeVerificationManifest } from "./verification-worker.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "verify-manifest-")), path = join(directory, "manifest.json");
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: "task-1", runtimeId: "runtime-1",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, attempt: 1,
    workerEpoch: "c".repeat(32), controlToken: "d".repeat(64), sessionFile: join(directory, "session.jsonl"), controlSocket: join(directory, "control.sock"),
    presentation: "background", launchMode: "none", placement: { socketPath: "/tmp/test-tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } };
  const save = (value = manifest) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save();
  return { directory, path, manifest, save, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("standalone shared reader preserves native identity without subagent runtime imports", () => {
  const f = fixture();
  try {
    const actual = readNativeVerificationManifest(f.path);
    assert.deepEqual(actual, f.manifest); actual.placement!.paneId = "%2";
    assert.equal(readNativeVerificationManifest(f.path).placement!.paneId, "%1");
  } finally { f.close(); }
});

test("native verification manifest rejects wrong identity, placement, paths and unsupported headless execution", () => {
  const f = fixture();
  try {
    for (const patch of [{ attempt: 0 }, { workerEpoch: "bad" }, { ownerSessionId: "" }, { execution: "rpc-headless" }, { presentation: "headless-foreground" },
      { sessionFile: "/tmp/foreign-session" }, { controlSocket: "/tmp/foreign-control" }, { placement: { ...f.manifest.placement, ownershipNonce: "bad" } },
      { panePid: process.pid }, { operatorCapabilityHash: "bad" }]) {
      f.save({ ...f.manifest, ...patch }); assert.throws(() => readNativeVerificationManifest(f.path), JSON.stringify(patch));
    }
    assert.throws(() => readNativeVerificationManifest(join(f.directory, "other.json")));
  } finally { f.close(); }
});

test("verification manifest reads are private, bounded, nofollow and strict UTF-8", () => {
  const f = fixture();
  try {
    chmodSync(f.path, 0o644); assert.throws(() => readNativeVerificationManifest(f.path)); chmodSync(f.path, 0o600);
    writeFileSync(f.path, " ".repeat(256 * 1024 + 1)); assert.throws(() => readNativeVerificationManifest(f.path));
    writeFileSync(f.path, Buffer.from([0xff])); assert.throws(() => readNativeVerificationManifest(f.path));
    unlinkSync(f.path); const target = join(f.directory, "target.json"); writeFileSync(target, JSON.stringify(f.manifest), { mode: 0o600 });
    symlinkSync(target, f.path); assert.throws(() => readNativeVerificationManifest(f.path));
  } finally { f.close(); }
});
