import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
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
  const geometryWindow = (await exec(tmux, ["-S", socket, "display-message", "-p", "-t", "caller", "#{window_id}"])).stdout.trim();
  const sibling = (await exec(tmux, ["-S", socket, "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "caller", "-h", "sleep", "90"])).stdout.trim();
  await exec(tmux, ["-S", socket, "resize-pane", "-t", "caller", "-y", "1"]);
  const geometryBackend = new TmuxBackend(store, tmux, process.execPath, pinned[0]());
  const geometryManager = new BackgroundJobManager(store, geometryBackend);
  const geometryMarker = path.join(root, "geometry-ran");
  const geometryJob = await geometryManager.start({ command: `printf x >> '${geometryMarker}'`, cwd: root });
  const geometryDone = await geometryManager.wait(geometryJob.metadata.id, 5000);
  assert.equal(geometryDone.record.status, "completed", `geometry job did not complete: ${JSON.stringify(geometryDone.record.result)} ${(await geometryManager.output(geometryJob.metadata.id)).text}`);
  assert.equal(fs.readFileSync(geometryMarker, "utf8"), "x", "geometry recovery duplicated or skipped command");
  assert.equal((await exec(tmux, ["-S", socket, "display-message", "-p", "-t", geometryJob.launch.paneId, "#{window_id}"])).stdout.trim(), geometryWindow, "geometry recovery escaped caller window");
  const geometryPanes = (await exec(tmux, ["-S", socket, "list-panes", "-t", geometryWindow, "-F", "#{pane_id}"])).stdout.trim().split("\n");
  assert(geometryPanes.includes(sibling), "geometry recovery closed unrelated pane");
  assert.equal(geometryPanes.length, 3, "geometry recovery created duplicate panes");
  await geometryManager.reap(geometryJob.metadata.id);
  await exec(tmux, ["-S", socket, "kill-pane", "-t", sibling]);
  // Exercise the runner's fail-closed launch gate independently of tmux: a
  // dead controller or cancellation must settle without executing command.
  for (const mode of ["controller-death", "cancelled", "timeout"]) {
    const gateDir = path.join(root, `gate-${mode}`);
    fs.mkdirSync(gateDir, { recursive: true, mode: 0o700 });
    const marker = path.join(gateDir, "command-ran");
    const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8"), selfFields = selfStat.slice(selfStat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const owner = mode === "timeout" ? { ownerPid: process.pid, ownerToken: `linux-proc:${selfFields[19]}` } : { ownerPid: 99999999, ownerToken: "linux-proc:1" };
    fs.writeFileSync(path.join(gateDir, "metadata.json"), JSON.stringify(owner));
    fs.writeFileSync(path.join(gateDir, "command"), `touch '${marker}'`);
    fs.writeFileSync(path.join(gateDir, "environment"), Buffer.alloc(0));
    if (mode === "cancelled") fs.writeFileSync(path.join(gateDir, "cancel-requested"), "cancel\n");
    const runnerPath = mode === "timeout" ? path.join(gateDir, "runner.mjs") : runner;
    if (mode === "timeout") fs.writeFileSync(runnerPath, fs.readFileSync(runner, "utf8").replace("Date.now() + 120_000", "Date.now() + 100"));
    await exec(process.execPath, [runnerPath, gateDir, "bash"]).catch(error => { if (error.code !== 125) throw error; });
    const terminal = JSON.parse(fs.readFileSync(path.join(gateDir, "result.json"), "utf8"));
    assert.equal(terminal.status, mode === "cancelled" ? "cancelled" : "failed");
    if (mode === "timeout") assert.match(terminal.reason, /timed out/);
    assert(!fs.existsSync(marker), `runner executed command after ${mode}`);
  }
  // Closing the runner-owned gate pipe without a nonce must fail closed.
  {
    const marker = path.join(root, "pipe-eof-must-not-run");
    const gateShell = spawn("bash", ["-c", `IFS= read -r gate <&3 || exit 125; [ \\"$gate\\" = valid-nonce ] || exit 125; exec bash -c 'touch ${marker}'`], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    gateShell.stdio[3].end();
    const exitCode = await new Promise(resolve => gateShell.once("close", code => resolve(code)));
    assert.equal(exitCode, 125, "EOF released the shell gate");
    assert(!fs.existsSync(marker), "command ran after gate EOF");
  }
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
    if (!infrastructure) {
      const launch = backend.launch.bind(backend);
      backend.launch = async (...args) => { await new Promise(resolve => setTimeout(resolve, 10_500)); return await launch(...args); };
      const delayed = await manager.start({ command: "printf delayed-ready", cwd: root });
      backend.launch = launch;
      const delayedResult = (await manager.wait(delayed.metadata.id, 5000)).record.result;
      assert.equal(delayedResult?.status, "completed", `delayed startup handshake failed: ${JSON.stringify(delayedResult)} ${(await manager.output(delayed.metadata.id)).text}`);
      await manager.reap(delayed.metadata.id);

      const sentinelPath = path.join(root, "must-not-run");
      const realLaunch = backend.launch.bind(backend);
      let launchedPane;
      let releaseController;
      const controllerPaused = new Promise(resolve => { releaseController = resolve; });
      backend.launch = async (...args) => {
        launchedPane = await realLaunch(...args);
        releaseController();
        await new Promise(resolve => setTimeout(resolve, 150));
        return launchedPane;
      };
      const abort = new AbortController();
      const cancelling = manager.start({ command: `touch '${sentinelPath}'`, cwd: root }, abort.signal);
      await controllerPaused;
      abort.abort();
      await assert.rejects(cancelling, error => error?.name === "AbortError");
      backend.launch = realLaunch;
      const cancelledId = (await store.listIds()).map(id => id).find(id => fs.existsSync(store.path(id, "cancel-requested")));
      assert(cancelledId, "cancelled startup record was not retained");
      assert(!fs.existsSync(sentinelPath), "command ran despite gate cancellation");
      await manager.reap(cancelledId);
    }
    for (const code of [0, 9, 127]) {
      const job = await manager.start({ command: `printf 'fast-output\\n'; printf 'fast-error\\n' >&2; exit ${code}`, cwd: root, infrastructure });
      const ready = JSON.parse(fs.readFileSync(store.path(job.metadata.id, "runner-ready"), "utf8"));
      assert.equal(ready.schemaVersion, 1);
      assert.equal(ready.pid, job.launch.panePid, "startup identity did not match the owned pane process");
      const finished = await manager.wait(job.metadata.id, 5000);
      assert.equal(finished.record.result?.exitCode, code);
      const output = (await manager.output(job.metadata.id)).text;
      assert.match(output, /fast-output/);
      assert.match(output, /fast-error/);
      await manager.reap(job.metadata.id);
    }
  }
  // A genuinely full window must fail rather than switching to a hidden
  // session, creating duplicate work, or closing the caller pane.
  const previousPane = process.env.TMUX_PANE;
  await exec(tmux, ["-S", socket, "set-option", "-g", "status", "off"]);
  await exec(tmux, ["-S", socket, "new-session", "-d", "-s", "full", "-x", "80", "-y", "1", "sleep", "90"]);
  const fullPane = (await exec(tmux, ["-S", socket, "display-message", "-p", "-t", "full", "#{pane_id}"])).stdout.trim();
  process.env.TMUX_PANE = fullPane;
  const fullMarker = path.join(root, "full-window-command-ran");
  await assert.rejects(geometryManager.start({ command: `touch '${fullMarker}'`, cwd: root }), /no space for new pane|pane too small/i);
  assert(!fs.existsSync(fullMarker), "unsplittable-window command executed");
  assert.equal((await exec(tmux, ["-S", socket, "list-panes", "-t", "full", "-F", "#{pane_id}"])).stdout.trim(), fullPane, "failed full-window launch changed pane topology");
  process.env.TMUX_PANE = previousPane;
  fs.unlinkSync(path.join(target, "runner.mjs"));
  assert.throws(pinned[0], /unavailable.*store-source.*reload Pi/);
  console.log("background-job startup regression tests passed");
} finally {
  if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
  if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
  for (const target of [socket, store.socketPath]) await exec(tmux, ["-S", target, "kill-server"], { timeout: 3000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
