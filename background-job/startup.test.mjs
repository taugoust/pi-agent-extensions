import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackgroundJobManager } from "./manager.js";
import { JobStore } from "./store.js";
import { TmuxBackend } from "./tmux.js";
import { pinRuntimePath } from "./runtime-path.js";

const exec = promisify(execFile);
const tmux = process.env.TEST_TMUX;
const runner = process.env.TEST_RUNNER;
assert(tmux && runner, "TEST_TMUX and TEST_RUNNER are required");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "background-startup-test-"));
const socket = path.join(root, "caller.sock");
const store = new JobStore(path.join(root, "state"), path.join(root, "runtime"));
const oldTmux = process.env.TMUX, oldPane = process.env.TMUX_PANE;
try {
  // Model a discovery path removed/retargeted by Home Manager after module
  // load but before lazy manager creation. Both runner paths must stay pinned.
  const target = path.join(root, "store-source");
  const discovery = path.join(root, "extensions");
  fs.mkdirSync(target);
  for (const name of ["runner.mjs", "watch-runner.mjs"]) fs.copyFileSync(name === "runner.mjs" ? runner : new URL("./watch-runner.mjs", import.meta.url), path.join(target, name));
  fs.symlinkSync(target, discovery);
  const pinned = ["runner.mjs", "watch-runner.mjs"].map(name => pinRuntimePath(pathToFileURL(path.join(discovery, name)), name));
  fs.unlinkSync(discovery);
  for (const [index, name] of ["runner.mjs", "watch-runner.mjs"].entries()) assert.equal(pinned[index](), path.join(target, name));
  const replacement = path.join(root, "replacement");
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, "runner.mjs"), "throw new Error('wrong version');");
  fs.symlinkSync(replacement, discovery);
  assert.equal(pinned[0](), path.join(target, "runner.mjs"));
  const missingAtLoad = pinRuntimePath(pathToFileURL(path.join(root, "later.mjs")), "test runner");
  fs.writeFileSync(path.join(root, "later.mjs"), "");
  assert.throws(missingAtLoad, /could not be resolved at extension load.*reload Pi/);

  await exec(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "160", "-y", "80", "-s", "caller", "sleep", "90"]);
  process.env.TMUX = `${socket},0,0`;
  process.env.TMUX_PANE = (await exec(tmux, ["-S", socket, "display-message", "-p", "-t", "caller", "#{pane_id}"])).stdout.trim();
  const panes = async () => (await exec(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"])).stdout;
  const originalPanes = await panes();
  for (const infrastructure of [false, true]) {
    for (const [node, script, diagnostic] of [
      [path.join(root, "missing-node"), pinned[0](), /Node executable is unavailable.*missing-node.*reload Pi/],
      [process.execPath, path.join(root, "missing-runner.mjs"), /background-job runner is unavailable.*missing-runner.*reload Pi/],
    ]) {
      const backend = new TmuxBackend(store, tmux, node, script);
      const manager = new BackgroundJobManager(store, backend);
      await assert.rejects(manager.start({ command: "printf should-not-run", cwd: root, infrastructure }), diagnostic);
      assert.equal(await panes(), originalPanes, "preflight failure created a user pane");
      assert(!fs.existsSync(store.socketPath), "preflight failure created an infrastructure server");
      const records = await manager.list();
      assert(records.some(record => record.result?.reason?.includes("reload Pi")));
    }
    const backend = new TmuxBackend(store, tmux, process.execPath, pinned[0]());
    const manager = new BackgroundJobManager(store, backend);
    for (const code of [0, 9, 127]) {
      const job = await manager.start({ command: `printf 'fast-output\\n'; printf 'fast-error\\n' >&2; exit ${code}`, cwd: root, infrastructure });
      const finished = await manager.wait(job.metadata.id, 5000);
      assert.equal(finished.record.result?.exitCode, code);
      const output = (await manager.output(job.metadata.id)).text;
      assert.match(output, /fast-output/);
      assert.match(output, /fast-error/);
      await manager.reap(job.metadata.id);
    }
  }
  fs.unlinkSync(path.join(target, "runner.mjs"));
  assert.throws(pinned[0], /unavailable.*store-source.*reload Pi/);
  console.log("background-job startup regression tests passed");
} finally {
  if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
  for (const target of [socket, store.socketPath]) await exec(tmux, ["-S", target, "kill-server"], { timeout: 3000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
