import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TuiWorkerTmux, WorkerAliasProjection } from "./tui-worker-tmux.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function manifest(): any {
  return { ownerSessionId: "owner", taskId: randomUUID(), groupId: "group", childId: "child", attempt: 1, runtimeId: randomUUID(), workerEpoch: randomUUID(), execution: "tmux", presentation: "background",
    placement: { socketPath: "/owned/socket", serverEpoch: "server", sessionId: "$1", windowId: "@1", paneId: "%1", nonce: "owned-nonce" } };
}
function backend(inspect: (manifest: any) => Promise<any>, applied: string[], Backend: any = TuiWorkerTmux) {
  const tmux = new Backend() as any;
  tmux.inspect = inspect;
  tmux.run = async (_socket: string, args: string[]) => {
    if (args[0] === "select-pane") applied.push(args.at(-1)!);
    else assert.fail(`Unexpected tmux command: ${args[0]}`);
    return "";
  };
  return tmux as TuiWorkerTmux;
}

test("delayed old alias inspection cannot finish after a newer application across backend instances", async () => {
  const m = manifest(), old = deferred(), started = deferred(), readyNew = deferred();
  const inspected: string[] = [], applied: string[] = [];
  const first = backend(async input => { assert.deepEqual(input, m); inspected.push("old"); started.resolve(); await old.promise; return { dead: false, placement: input.placement }; }, applied);
  const second = backend(async input => { assert.deepEqual(input, m); inspected.push("new"); await readyNew.promise; return { dead: false, placement: input.placement }; }, applied);
  const oldWrite = first.rename(m, "old-name", false);
  await started.promise;
  const newWrite = second.rename(m, "new-name", false);
  readyNew.resolve(); // Exact old regression: newer work is ready before the old inspection completes.
  await turn();
  assert.deepEqual(inspected, ["old"], "newer application must not overlap the old rename");
  assert.deepEqual(applied, []);
  old.resolve(); await Promise.all([oldWrite, newWrite]);
  assert.deepEqual(inspected, ["old", "new"], "each serialized application re-verifies identity");
  assert.deepEqual(applied, ["old-name", "new-name"]);
  assert.equal(applied.at(-1), "new-name");
});

test("failed identity inspection releases the worker queue and never applies an unverified alias", async () => {
  const m = manifest(), applied: string[] = [];
  let verified = 0;
  const failed = backend(async () => { throw new Error("ownership changed"); }, applied);
  const valid = backend(async input => { verified++; return { dead: false, placement: input.placement }; }, applied);
  const first = failed.rename(m, "invalid-old", false);
  const next = valid.rename(m, "verified-new", false);
  await assert.rejects(first, /ownership changed/); await next;
  await valid.rename(m, "after-recovery", false);
  assert.deepEqual(applied, ["verified-new", "after-recovery"]);
  assert.equal(verified, 2, "a rejected predecessor neither poisons nor orphans later queue work");
});

test("projection coalesces the latest desired alias and retries failures without metadata changes", async () => {
  const old = deferred(), started = deferred(), applied: string[] = [], warnings: unknown[] = [];
  let fail = true;
  const projection = new WorkerAliasProjection(async alias => {
    applied.push(alias);
    if (alias === "old") { started.resolve(); await old.promise; }
    if (alias === "latest" && fail) throw new Error("temporary tmux failure");
  }, error => warnings.push(error));
  const running = projection.request("old"); await started.promise;
  void projection.request("middle"); void projection.request("latest");
  old.resolve(); await running;
  assert.deepEqual(applied, ["old", "latest"]);
  assert.equal(warnings.length, 1);
  await projection.request("latest");
  assert.equal(warnings.length, 1, "retry warnings are bounded while the same alias is unavailable");
  fail = false; await projection.request("latest");
  const count = applied.length; await projection.retry();
  assert.equal(applied.length, count, "successful unchanged projections do not issue redundant writes");
  assert.equal(applied.at(-1), "latest");
  projection.stop(); await projection.request("stopped");
  assert.equal(applied.length, count);
});

test("reload stops old desired work while new factory waits for in-flight alias and leaves no orphan queue", async () => {
  const m = manifest(), held = deferred(), started = deferred(), applied: string[] = [];
  const oldBackend = backend(async input => { started.resolve(); await held.promise; return { dead: false, placement: input.placement }; }, applied);
  const reloaded = await import(`${new URL("./tui-worker-tmux.ts", import.meta.url).href}?alias-reload=${randomUUID()}`);
  const newBackend = backend(async input => ({ dead: false, placement: input.placement }), applied, reloaded.TuiWorkerTmux);
  const old = new WorkerAliasProjection(alias => oldBackend.rename(m, alias, false));
  const pending = old.request("old-inflight"); await started.promise;
  void old.request("old-pending"); old.stop();
  const replacement = new reloaded.WorkerAliasProjection((alias: string) => newBackend.rename(m, alias, false));
  const resumed = replacement.request("new-after-reload");
  await turn(); assert.deepEqual(applied, []);
  held.resolve(); await Promise.all([pending, resumed]);
  assert.deepEqual(applied, ["old-inflight", "new-after-reload"]);
  await old.retry(); await old.request("old-after-stop");
  await replacement.request("new-final"); replacement.stop();
  assert.deepEqual(applied, ["old-inflight", "new-after-reload", "new-final"]);
});
