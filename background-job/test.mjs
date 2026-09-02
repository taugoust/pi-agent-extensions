import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackgroundJobManager, boundedTail } from "./manager.js";
import { JobStore } from "./store.js";
import { TmuxBackend } from "./tmux.js";

const execFileAsync = promisify(execFile);
const tmux = process.env.TEST_TMUX;
const runner = process.env.TEST_RUNNER;
if (!tmux || !runner) throw new Error("TEST_TMUX and TEST_RUNNER are required");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "background-job-test-"));
const stateRoot = path.join(root, "state");
const runtimeRoot = `/tmp/pi-bg-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const sentinelSocket = `/tmp/pi-bg-sentinel-${process.pid}-${Math.random().toString(16).slice(2, 8)}.sock`;
const store = new JobStore(stateRoot, runtimeRoot);
const backend = new TmuxBackend(store, tmux, process.execPath, runner);
const manager = new BackgroundJobManager(store, backend);

async function cleanup() {
  await execFileAsync(tmux, ["-S", store.socketPath, "kill-server"], { timeout: 3000 }).catch(() => undefined);
  await execFileAsync(tmux, ["-S", sentinelSocket, "kill-server"], { timeout: 3000 }).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.rmSync(sentinelSocket, { force: true });
}

try {
  await execFileAsync(tmux, ["-S", sentinelSocket, "-f", "/dev/null", "new-session", "-d", "-s", "sentinel", "sleep", "60"]);
  process.env.BG_TEST_VALUE = "exact value with spaces";

  const first = await manager.start({
    command: "printf 'cwd=%s\\nenv=%s\\n' \"$PWD\" \"$BG_TEST_VALUE\"; sleep 1; printf 'done\\n'",
    cwd: root,
    name: "survival",
    sessionId: "test-session",
  });
  assert(first.status === "running" && first.launch?.paneStartToken, "job did not launch with process identity");
  assert((fs.statSync(store.jobDir(first.metadata.id)).mode & 0o077) === 0, "job directory is not private");
  assert(!fs.existsSync(store.path(first.metadata.id, "environment")) || (fs.statSync(store.path(first.metadata.id, "environment")).mode & 0o077) === 0, "environment snapshot is not private");

  const shortWait = await manager.wait(first.metadata.id, 10);
  assert(shortWait.timedOut && shortWait.record.status === "running", "bounded wait did not time out while leaving the job running");
  const controller = new AbortController();
  controller.abort();
  let aborted = false;
  try { await manager.wait(first.metadata.id, 1000, controller.signal); }
  catch (error) { aborted = error?.name === "AbortError" && String(error.message).includes("still running"); }
  assert(aborted, "aborted wait did not report that the job remains running");

  const reloadedStore = new JobStore(stateRoot, runtimeRoot);
  const reloaded = new BackgroundJobManager(reloadedStore, new TmuxBackend(reloadedStore, tmux, process.execPath, runner));
  const finished = await reloaded.wait(first.metadata.id, 5000);
  assert(!finished.timedOut && finished.record.status === "completed" && finished.record.result?.exitCode === 0, "reloaded manager did not recover completed job");
  const output = await reloaded.output(first.metadata.id);
  assert(output.text.includes(`cwd=${root}`) && output.text.includes("env=exact value with spaces") && output.text.includes("done"), "job output/cwd/environment was not preserved");
  assert(!(await store.markNotified(first.metadata.id)), "reading completed output did not suppress the pending completion notification");

  const failing = await manager.start({ command: "printf 'failure output\\n'; exit 7", cwd: root });
  const failed = await manager.wait(failing.metadata.id, 5000);
  assert(failed.record.status === "failed" && failed.record.result?.exitCode === 7, "nonzero exit was not preserved");

  const noisy = await manager.start({ command: "head -c 2000000 /dev/zero | tr '\\0' x; printf '\\nend\\n'", cwd: root });
  await manager.wait(noisy.metadata.id, 5000);
  const noisyOutput = await manager.output(noisy.metadata.id);
  assert(Buffer.byteLength(noisyOutput.text, "utf8") <= 50 * 1024 && noisyOutput.truncated && noisyOutput.text.endsWith("end\n"), "model-facing output was not tail-bounded");
  assert(fs.statSync(store.path(noisy.metadata.id, "output.log")).size <= 1024 * 1024, "persistent output exceeded its bound");

  const childPidPath = path.join(root, "cancel-child.pid");
  const cancellable = await manager.start({ command: `printf 'started\\n'; sleep 60 & echo $! > '${childPidPath}'; wait`, cwd: root });
  for (let attempt = 0; attempt < 50 && !fs.existsSync(childPidPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const childPid = Number(fs.readFileSync(childPidPath, "utf8").trim());
  const cancelled = await manager.cancel(cancellable.metadata.id);
  assert(cancelled.status === "cancelled", "cancel did not publish a cancelled terminal state");
  await new Promise((resolve) => setTimeout(resolve, 100));
  let childAlive = true;
  try { process.kill(childPid, 0); } catch { childAlive = false; }
  assert(!childAlive, "cancel left a command descendant alive");

  const orphaned = await manager.start({ command: "trap '' HUP; sleep 60", cwd: root });
  const processPath = path.join(store.jobDir(orphaned.metadata.id), "process.json");
  for (let attempt = 0; attempt < 100 && !fs.existsSync(processPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(fs.existsSync(processPath), "runner did not publish command process identity");
  process.kill(orphaned.launch.panePid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const recoveredOrphan = await manager.get(orphaned.metadata.id);
  assert(recoveredOrphan.status === "running", "runner loss hid a still-running command process");
  const cancelledOrphan = await manager.cancel(orphaned.metadata.id);
  assert(cancelledOrphan.status === "cancelled", "cancel could not terminate a command after runner loss");

  const sentinel = await execFileAsync(tmux, ["-S", sentinelSocket, "has-session", "-t", "sentinel"]);
  assert(sentinel.stdout === "", "unexpected sentinel output");

  const escaped = boundedTail("before\u001b[31mred\u001b[0m\u0000after");
  assert(escaped.text === "beforeredafter", "terminal controls were not removed from output");

  const ids = await store.listIds();
  assert(ids.length === 5 && ids.every((id) => /^job-[0-9a-f]{24}$/.test(id)), "opaque persisted job IDs are malformed");

  const raceStore = new JobStore(path.join(root, "race-state"), path.join(root, "race-runtime"));
  let releaseLaunch;
  let killed = false;
  const raceBackend = {
    async launch() {
      await new Promise((resolve) => { releaseLaunch = resolve; });
      return { schemaVersion: 1, windowId: "@99", paneId: "%99", panePid: process.pid, paneStartToken: "test", launchedAt: new Date().toISOString() };
    },
    async paneState() { return { exists: true, dead: false, panePid: process.pid }; },
    async capture() { return ""; },
    async signal() {},
    async kill() { killed = true; },
    attachCommand() { return "test"; },
  };
  const raceManager = new BackgroundJobManager(raceStore, raceBackend);
  const starting = raceManager.start({ command: "printf must-not-run", cwd: root, sessionId: "race" });
  let raceIds = [];
  for (let attempt = 0; attempt < 100 && raceIds.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    raceIds = await raceStore.listIds();
  }
  assert(raceIds.length === 1, "starting job was not durably discoverable");
  await raceManager.cancel(raceIds[0]);
  releaseLaunch();
  const raced = await starting;
  assert(raced.status === "cancelled" && killed, "cancel-during-launch allowed the job to become live");
  assert(!fs.existsSync(path.join(raceStore.jobDir(raceIds[0]), "launch-ready")), "cancelled launch opened its runner gate");

  console.log("background-job checks passed");
} finally {
  await cleanup();
}
