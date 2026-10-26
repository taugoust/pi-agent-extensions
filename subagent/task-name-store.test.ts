import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskNameStore } from "./task-name-store.ts";

const identity = { ownerSessionId: "owner", taskId: "task-one", groupId: "group-one", childId: "child-one", attempt: 1, runtimeId: "runtime-one", workerEpoch: "epoch-one" };

test("canonical task metadata revisions preserve user names through new attempts and reject stale epochs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-canonical-name-"));
  try {
    const first = new TaskNameStore(join(root, "workers", "one"), { ...identity, controlToken: "must-never-enter-name-metadata", sessionFile: "/private/session" } as any);
    const initial = first.claim("Parser Review");
    assert.equal(initial.revision, 1);
    assert.equal("controlToken" in initial, false);
    assert.equal("sessionFile" in initial, false);
    assert.equal("controlToken" in first.read()!, false);
    assert.equal((await readFile(first.path, "utf8")).includes("must-never-enter-name-metadata"), false);
    const renamed = first.rename("User Parser Name", initial.revision, "paseo");
    assert.equal(renamed.revision, 2);
    assert.equal(renamed.alias, "user-parser");
    assert.equal(first.rename(renamed.displayName, renamed.revision, "pi").revision, 2, "echo is a no-op");
    assert.throws(() => first.rename("Lost Rename", 1, "pi"), /revision conflict/);
    const nextIdentity = { ...identity, groupId: "group-two", childId: "child-two", attempt: 2, runtimeId: "runtime-two", workerEpoch: "epoch-two" };
    const next = new TaskNameStore(join(root, "workers", "two"), nextIdentity);
    const claimed = next.claim("Prompt Derived Replacement");
    assert.equal(claimed.displayName, "User Parser Name");
    assert.equal(claimed.source, "paseo");
    assert.equal(claimed.revision, 3);
    assert.equal(first.read(false)?.displayName, claimed.displayName, "retained attempts share the same stable task name");
    assert.throws(() => first.rename("Stale Epoch", 3, "pi"), /Stale/);
    assert.throws(() => first.claim("Old Attempt"), /Cannot reclaim/);
    assert.throws(() => new TaskNameStore(join(root, "workers", "forged"), { ...nextIdentity, runtimeId: "wrong" }).rename("Wrong Runtime", 3, "pi"), /Stale/);
    assert.equal(next.rename("Current Name", 3, "pi").revision, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parallel children allocate readable collision aliases independently without cross-owner names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-canonical-parallel-"));
  try {
    const a = new TaskNameStore(join(root, "workers", "a"), identity);
    const b = new TaskNameStore(join(root, "workers", "b"), { ...identity, taskId: "task-two", childId: "child-two" });
    assert.equal(a.claim("Parser Review").alias, "parser-review");
    assert.equal(b.claim("Parser Review").alias, "parser-review-2");
    assert.equal(b.rename("Other Name", 1, "pi").alias, "other-name");
    assert.equal(a.read()?.displayName, "Parser Review");
    const privateOwner = new TaskNameStore(join(root, "workers", "private"), { ...identity, ownerSessionId: "other-owner" });
    assert.equal(privateOwner.read(false), undefined);
    assert.equal(privateOwner.claim("Private Task").displayName, "Private Task");
    assert.equal(a.read()?.displayName, "Parser Review");
    assert.throws(() => a.rename("one two three four five", 1, "pi"), /displayName/);
    assert.equal(a.read()?.revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
