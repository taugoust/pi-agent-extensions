import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackgroundJobManager, boundedTail } from "./manager.js";
import { JobStore } from "./store.js";
import { TmuxBackend, resolveLocalPlacement } from "./tmux.js";

const execFileAsync = promisify(execFile);
const tmux = process.env.TEST_TMUX;
const runner = process.env.TEST_RUNNER;
if (!tmux || !runner) throw new Error("TEST_TMUX and TEST_RUNNER are required");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function assertReject(promise, pattern) {
  try { await promise; } catch(error) { assert(pattern.test(String(error)), `wrong rejection: ${error}`); return; }
  throw new Error(`Expected rejection ${pattern}`);
}

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
  await execFileAsync(tmux, ["-S", sentinelSocket, "-f", "/dev/null", "new-session", "-d", "-x", "240", "-y", "1000", "-s", "sentinel", "sleep", "60"]);
  const caller = (await execFileAsync(tmux, ['-S', sentinelSocket, 'display-message', '-p', '-t', 'sentinel', '#{pane_id}'])).stdout.trim();
  process.env.TMUX = `${sentinelSocket},0,0`;
  process.env.TMUX_PANE = caller;
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
  assert(first.launch.socketPath === sentinelSocket, 'user job launched on a private server');
  assert((await backend.paneState(first.metadata.id, first.launch)).dead, 'completed pane was not retained');

  if (process.platform === "linux") {
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const log = path.join(root, "external.log"); fs.writeFileSync(log, "stage: ready\n");
      const adopted = await manager.adopt({ pid: process.pid, logPath: log, cwd: root, sessionId: "test-session", childId: "child-a" });
      assert(adopted.metadata.observed?.pid === process.pid, "adoption lost process identity");
      assert((await manager.output(adopted.metadata.id)).text.includes("stage: ready"), "adopted log could not be read");
      assert((await manager.get(adopted.metadata.id)).metadata.childId === "child-a", "delegated job ownership was not persisted");
      let denied = false; try { await manager.cancel(adopted.metadata.id); } catch (error) { denied = String(error).includes("observation-only"); }
      assert(denied, "adoption acquired destructive authority");
      fs.renameSync(log, log + ".old"); fs.writeFileSync(log, "replaced");
      denied = false; try { await manager.output(adopted.metadata.id); } catch (error) { denied = String(error).includes("identity changed"); }
      assert(denied, "adoption silently followed a replaced log");
    } finally { process.chdir(previousCwd); }
  }

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
  assert((await backend.paneState(cancellable.metadata.id, cancellable.launch)).exists, 'cancel destroyed retained pane');
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
  assert(ids.length === (process.platform === "linux" ? 6 : 5) && ids.every((id) => /^job-[0-9a-f]{24}$/.test(id)), "opaque persisted job IDs are malformed");

  // A crash-looping infrastructure service must not evict a recently completed
  // user handle, even when the user already read its result.
  for (let index = 1; index <= 110; index++) {
    const id = 'job-' + index.toString(16).padStart(24, '0');
    await store.create({ ...first.metadata, id, command: ':', infrastructure: true, createdAt: new Date().toISOString() }, ':', Buffer.alloc(0));
    await store.publishResult(id, { ...finished.record.result, finishedAt: new Date().toISOString() });
  }
  // Even acknowledged old user jobs must survive automatic pruning.
  await store.publishResult(first.metadata.id, finished.record.result);
  const oldResult = {...finished.record.result, finishedAt:'2000-01-01T00:00:00.000Z'};
  fs.writeFileSync(store.path(first.metadata.id,'result.json'), JSON.stringify(oldResult));
  const afterChurn = await manager.start({ command: 'printf retention-trigger', cwd: root, sessionId: 'test-session' });
  await manager.wait(afterChurn.metadata.id, 5000);
  assert((await manager.wait(first.metadata.id, 0)).record.status === 'completed', 'infrastructure churn evicted user metadata');
  assert((await manager.output(first.metadata.id)).text.includes('done'), 'infrastructure churn removed user output');

  const tmuxCall = async (...args) => (await execFileAsync(tmux, ['-S',sentinelSocket,...args])).stdout.trim();
  const window = await tmuxCall('display-message','-p','-t',caller,'#{window_id}');
  const session = await tmuxCall('display-message','-p','-t',caller,'#{session_id}');
  assert((await tmuxCall('list-windows','-t',session,'-F','#{window_id}')) === window, 'launch created private windows instead of caller-window panes');
  for (const job of [first, failing, noisy, cancellable, orphaned, afterChurn]) {
    assert(job.launch.windowId === window && job.launch.sessionId === session, 'job escaped caller tmux window');
    assert((await backend.paneState(job.metadata.id, job.launch)).exists, 'terminal/read/cancel automatically removed a user pane');
  }
  for (const job of [failing, noisy, cancellable, orphaned, afterChurn]) await manager.reap(job.metadata.id);
  assert((await tmuxCall('list-panes','-t',window,'-F','#{pane_id}')).split('\n').length === 2, 'reap removed siblings or retained owned panes');
  assert((await backend.paneState(first.metadata.id, first.launch)).exists, 'reaping siblings removed a retained completed pane');

  const placement = await resolveLocalPlacement(tmux);
  await assertReject(manager.start({command:':',cwd:root,placement:{...placement,paneStartToken:'stale'}}), /placement is stale/);
  const savedTmux = process.env.TMUX, savedPane = process.env.TMUX_PANE;
  delete process.env.TMUX; delete process.env.TMUX_PANE;
  await assertReject(manager.start({command:':',cwd:root}), /requires Pi to run inside tmux/);
  process.env.TMUX = savedTmux; process.env.TMUX_PANE = savedPane;

  // This controller really crashes (SIGKILL), not just reconstructs a manager.
  const controllerCode = `
    import {BackgroundJobManager} from ${JSON.stringify(new URL('./manager.js',import.meta.url).href)};
    import {JobStore} from ${JSON.stringify(new URL('./store.js',import.meta.url).href)};
    import {TmuxBackend} from ${JSON.stringify(new URL('./tmux.js',import.meta.url).href)};
    const store=new JobStore(${JSON.stringify(stateRoot)},${JSON.stringify(runtimeRoot)});
    const manager=new BackgroundJobManager(store,new TmuxBackend(store,${JSON.stringify(tmux)},process.execPath,${JSON.stringify(runner)}));
    const job=await manager.start({command:'sleep 0.3; printf parent-crash-survived',cwd:${JSON.stringify(root)}});
    process.stdout.write(job.metadata.id+'\\n',()=>process.kill(process.pid,'SIGKILL'));
  `;
  let crashId;
  try { await execFileAsync(process.execPath,['--input-type=module','-e',controllerCode]); }
  catch(error) { assert(error.signal==='SIGKILL', 'controller did not crash as intended'); crashId=error.stdout.trim(); }
  assert(/^job-[0-9a-f]{24}$/.test(crashId), 'crashed controller did not persist launch');
  assert((await manager.wait(crashId,5000)).record.status==='completed', 'job did not survive controller SIGKILL');
  assert((await manager.output(crashId)).text.includes('parent-crash-survived'), 'crash survivor lost output');
  const crashJob=await manager.get(crashId);
  assert((await backend.paneState(crashId,crashJob.launch)).exists,'crash survivor pane disappeared after completion');

  // Fail closed on stale server, pane start token, and pane-local claim. Keep
  // runtime on refusal, then restore the fixture and explicitly reap it.
  await store.writeLaunch(crashId,{...crashJob.launch,serverStartToken:'stale'});
  await assertReject(manager.reap(crashId), /identity changed/);
  await store.writeLaunch(crashId,{...crashJob.launch,paneStartToken:'stale'});
  await assertReject(manager.reap(crashId), /ownership\/placement changed/);
  await store.writeLaunch(crashId,{...crashJob.launch,panePid:crashJob.launch.panePid+1});
  await assertReject(manager.reap(crashId), /identity changed/);
  await store.writeLaunch(crashId,crashJob.launch);
  await tmuxCall('set-option','-p','-t',crashJob.launch.paneId,'@pi_background_job_token','00000000000000000000000000000000');
  await assertReject(manager.reap(crashId), /ownership\/placement changed/);
  assert(fs.existsSync(store.jobDir(crashId)), 'failed reap deleted inspectable runtime');
  await tmuxCall('set-option','-p','-t',crashJob.launch.paneId,'@pi_background_job_token',crashJob.launch.ownershipToken);
  await manager.reap(crashId);
  assert(!fs.existsSync(store.jobDir(crashId)), 'explicit reap did not release runtime');
  assert((await tmuxCall('list-panes','-t',window,'-F','#{pane_id}')).split('\n').length===2, 'reap killed sibling panes');

  // Promotion moves an intact foreground WINDOW out of the staging session.
  // Session changes are not pane replacement; all ownership checks still apply.
  const stagedCaller = await tmuxCall('new-session','-d','-P','-F','#{pane_id}','-x','240','-y','200','-s','staging','-c',root,'sleep','120');
  await tmuxCall('set-option','-t','staging','@pi_infrastructure','1');
  process.env.TMUX_PANE = stagedCaller;
  const stagedRunning = await manager.start({command:'printf staged-running; sleep 60',cwd:root});
  const stagedDone = await manager.start({command:'printf staged-completed',cwd:root});
  await manager.wait(stagedDone.metadata.id,5000);
  process.env.TMUX_PANE = caller;
  const stagingWindow = stagedRunning.launch.windowId;
  const callerPid = await tmuxCall('display-message','-p','-t',stagedCaller,'#{pane_pid}');
  await tmuxCall('move-window','-s',stagingWindow,'-t',`${session}:`);
  assert(await tmuxCall('display-message','-p','-t',stagedCaller,'#{session_id}') === session, 'promotion did not move the window into the user session');
  assert(stagedRunning.launch.sessionId !== session, 'promotion fixture did not change sessions');
  assert((await manager.get(stagedRunning.metadata.id)).status === 'running', 'session promotion lost a running job');
  assert((await backend.paneState(stagedDone.metadata.id,stagedDone.launch)).exists, 'session promotion invalidated a completed job');
  assert((await manager.cancel(stagedRunning.metadata.id)).status === 'cancelled', 'promoted job could not be cancelled');
  assert((await manager.output(stagedDone.metadata.id)).text.includes('staged-completed'), 'promotion lost completed output');
  await store.writeLaunch(stagedDone.metadata.id,{...stagedDone.launch,windowId:window});
  await assertReject(manager.reap(stagedDone.metadata.id), /ownership\/placement changed/);
  await store.writeLaunch(stagedDone.metadata.id,stagedDone.launch);
  await manager.reap(stagedRunning.metadata.id);
  await manager.reap(stagedDone.metadata.id);
  assert(await tmuxCall('list-panes','-t',stagingWindow,'-F','#{pane_id}') === stagedCaller, 'promoted reap touched a sibling pane');
  assert(await tmuxCall('display-message','-p','-t',stagedCaller,'#{pane_pid}') === callerPid, 'promotion/reap restarted the group controller');
  assert((await backend.paneState(first.metadata.id,first.launch)).exists, 'promoted reap touched an unrelated user window');

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
