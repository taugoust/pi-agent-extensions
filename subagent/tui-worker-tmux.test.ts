import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiWorkerTmux, tuiWorkerLaunchContract, processIdentity } from "./tui-worker-tmux.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";

const exec = promisify(execFile);
const rawPi = process.env.PI_TUI_TEST_PI;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("launcher authority contract fails closed on missing/mismatched/full mode", () => {
  assert.throws(() => tuiWorkerLaunchContract("native", {}));
  const env = { PI_TUI_WORKER_LAUNCHER: "/nix/store/example/bin/pi", PI_TUI_WORKER_LAUNCH_MODE: "none" };
  assert.equal(tuiWorkerLaunchContract("native", env).launchMode, "none");
  assert.throws(() => tuiWorkerLaunchContract("guard-only", env));
  assert.throws(() => tuiWorkerLaunchContract("full", { ...env, PI_TUI_WORKER_LAUNCH_MODE: "guard-only" }));
  assert.throws(() => tuiWorkerLaunchContract("unavailable", env));
});

test("inspection retries vanished /proc only with fresh owned tmux death evidence", { skip: process.platform !== "linux" }, async (t) => {
  // Outside Linux's PID range; this deterministically models exit between the
  // tmux live snapshot and /proc read without racing a real process scheduler.
  const vanishedPid = 2147483647;
  await assert.rejects(processIdentity(vanishedPid), { code: "ENOENT" });
  const epoch = await processIdentity(process.pid);
  const root = await mkdtemp(join(tmpdir(), "pi-tui-inspect-"));
  const manifest = {
    groupId: "owned-group", workerEpoch: "worker-epoch", sessionFile: join(root, "session.jsonl"),
    panePid: vanishedPid, paneProcessToken: `${vanishedPid}:123`,
    placement: { socketPath: "/fixture/tmux.sock", serverEpoch: epoch, sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "owned-nonce" },
  } as TuiWorkerManifest;
  const live = `owned-nonce|owned-group|0|${vanishedPid}`;
  const dead = `owned-nonce|owned-group|1|${vanishedPid}`;
  const fixture = (snapshots: string[], changeEpoch = false) => {
    const backend = new TuiWorkerTmux();
    let reads = 0, kills = 0, epochs = 0;
    // Stub only the tmux transport; production /proc reads and reap logic run.
    (backend as any).run = async (socket: string, args: string[]) => {
      assert.equal(socket, manifest.placement.socketPath);
      if (args.at(-1) === "#{pid}") { epochs++; return String(changeEpoch && epochs > 1 ? process.ppid : process.pid); }
      if (args.at(-1) === "#{session_id}|#{window_id}|#{pane_id}") return "$1|@1|%1";
      if (args.at(-1)?.includes("#{pane_dead}")) return snapshots[Math.min(reads++, snapshots.length - 1)];
      if (args[0] === "if-shell") { kills++; assert(args[4].includes("#{pane_dead}")); return ""; }
      throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
    };
    return { backend, reads: () => reads, kills: () => kills };
  };
  try {
    await t.test("reap succeeds after revalidated dead snapshot and remains idempotent", async () => {
      const f = fixture([live, dead]);
      const store = new TuiWorkerStore(root);
      const state = store.readState();
      state.sealed = true; state.reapReservation = "verified-reservation";
      state.jobCleanup = { workerEpoch: manifest.workerEpoch,
        artifact: store.artifact("job-cleanup", 1, { workerEpoch: manifest.workerEpoch, report: { jobs: [] } }) };
      store.writeState(state);
      await f.backend.reap(manifest);
      assert.equal(f.reads(), 3, "reap must reverify immediately before deletion");
      assert.equal(f.kills(), 1);
      await f.backend.reap(manifest);
      assert.equal(f.kills(), 1);
    });
    await t.test("dead worker without cleanup proof refuses reap rather than orphaning unknown jobs", async () => {
      await rm(join(root, "reaped.json"), { force: true });
      await rm(join(root, "state.json"), { force: true });
      const f = fixture([dead]);
      await assert.rejects(f.backend.reap(manifest), /inventory is unknown.*explicitly inspect\/adopt/);
      assert.equal(f.kills(), 0);
    });
    for (const [name, snapshot] of [
      ["nonce", dead.replace("owned-nonce", "foreign-nonce")],
      ["group", dead.replace("owned-group", "foreign-group")],
      ["PID", dead.replace(String(vanishedPid), String(process.pid))],
    ]) await t.test(`rejects changed ${name} on retry`, async () => {
      const f = fixture([live, snapshot]);
      await assert.rejects(f.backend.inspect(manifest), /ownership changed/);
      assert.equal(f.kills(), 0);
    });
    await t.test("rejects changed server epoch on retry", async () => {
      const f = fixture([live, dead], true);
      await assert.rejects(f.backend.inspect(manifest), /server identity changed/);
      assert.equal(f.reads(), 1);
    });
    await t.test("missing /proc never implies death and retry count is bounded", async () => {
      const f = fixture([live]);
      await assert.rejects(f.backend.inspect(manifest), { code: "ENOENT" });
      assert.equal(f.reads(), 3);
      assert.equal(f.kills(), 0);
    });
    await t.test("live process token mismatch is not retried or treated as death", async () => {
      const f = fixture([`owned-nonce|owned-group|0|${process.pid}`]);
      await assert.rejects(f.backend.inspect({ ...manifest, panePid: process.pid, paneProcessToken: `${process.pid}:0` }), /process identity changed/);
      assert.equal(f.reads(), 1);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real Pi TUI: local keyboard, observer crash, same-process promotion, retained completion and idle-only reap", { skip: !rawPi, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tui-"));
  const socket = join(root, "tmux.sock"), config = join(root, "agent");
  const tmux = async (...args: string[]) => (await exec("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout.trim();
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "settings.json"), JSON.stringify({
    extensions: [fileURLToPath(new URL("./tui-worker-test-provider.ts", import.meta.url)),
      fileURLToPath(new URL("./tui-worker-test-empty-jobs.ts", import.meta.url))],
    defaultProvider: "harness-test", defaultModel: "mock", quietStartup: true,
    enableSkillCommands: false, defaultProjectTrust: "no",
  }));
  try {
    await tmux("new-session", "-d", "-s", "parent", "-x", "120", "-y", "35", "sleep 120");
    await tmux("set-environment", "-g", "PI_CODING_AGENT_DIR", config);
    await tmux("set-environment", "-g", "PI_CODING_AGENT_SESSION_DIR", join(config, "sessions"));
    const callerPane = await tmux("display-message", "-p", "-t", "parent:", "#{pane_id}");
    const backend = new TuiWorkerTmux();
    const caller = await backend.resolveCaller({ TMUX: `${socket},1,0`, TMUX_PANE: callerPane });
    const callerRename = await tmux("show-option", "-wqv", "-t", caller.windowId, "automatic-rename");
    const workerDir = join(root, "worker");
    // Launcher process is distinct and actually SIGKILLed after it reports the
    // committed manifest. Nothing in it owns Pi's terminal/control socket.
    const launcherModule = fileURLToPath(new URL("./tui-worker-tmux.ts", import.meta.url));
    const input = { directory: workerDir, ownerSessionId: "parent-session", taskId: "task-1",
      groupId: `subagent-job-${"1".repeat(24)}`, childId: `subagent-child-${"2".repeat(24)}`,
      attempt: 1, cwd: root, caller, foreground: true, parentDisposition: "native", launcher: rawPi,
      launchMode: "none", model: "harness-test/mock", windowName: "agt-parser-review", paneTitle: "agt-review-tests" };
    const code = `const {TuiWorkerTmux}=await import(${JSON.stringify(launcherModule)}); const t=new TuiWorkerTmux(); const m=await t.launch(${JSON.stringify(input)}); await t.waitReady(m); console.log('READY'); setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    parent.stdout.on("data", b => { output += b; }); parent.stderr.on("data", b => { error += b; });
    const deadline = Date.now() + 35_000;
    while (!output.includes("READY") && parent.exitCode === null && Date.now() < deadline) await sleep(50);
    if (!output.includes("READY")) {
      parent.kill("SIGKILL");
      const panes = await tmux("list-panes", "-a", "-F", "#{pane_id}").catch(() => "");
      let captures = "";
      for (const pane of panes.split("\n").filter(Boolean)) captures += await tmux("capture-pane", "-p", "-S", "-100", "-t", pane).catch(() => "");
      throw new Error(`Launcher did not become ready: ${error}\n${captures}`);
    }
    const store = new TuiWorkerStore(workerDir);
    let manifest = store.readManifest();
    const display = (pane: string, format: string) => tmux("display-message", "-p", "-t", pane, format);
    assert.equal(await display(manifest.placement.paneId, "#{window_name}|#{pane_title}"), "agt-parser-review|agt-review-tests");
    assert.equal(await tmux("show-option", "-wqv", "-t", manifest.placement.windowId, "automatic-rename"), "off");
    assert.equal(await tmux("show-option", "-wqv", "-t", caller.windowId, "automatic-rename"), callerRename);
    const initial = await callTuiWorker(manifest, { operation: "status" });
    assert.ok(initial.ok);
    const piPid = (initial.data as any).pid;
    assert.equal((await backend.inspect(manifest)).panePid, piPid); // raw launch is the one Pi process
    assert.equal((await backend.inspect(manifest)).dead, false);
    // Genuine keyboard slash command proves this is Pi's editor/command parser.
    await tmux("send-keys", "-t", manifest.placement.paneId, "-l", "/name keyboard-worker");
    await tmux("send-keys", "-t", manifest.placement.paneId, "Enter");
    await sleep(300);
    const terminal = await tmux("capture-pane", "-p", "-S", "-100", "-t", manifest.placement.paneId);
    assert.match(terminal, /keyboard-worker|Session named/);
    // A pre-existing local job/sibling stays in the same group window on promotion.
    const sibling = await tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", manifest.placement.windowId, "sleep 120");
    const siblingPid = await tmux("display-message", "-p", "-t", sibling, "#{pane_pid}");
    const second = await backend.launch({ ...input, launcher: rawPi!, parentDisposition: "native", launchMode: "none",
      directory: join(root, "second"), childId: `subagent-child-${"3".repeat(24)}`, groupWindowId: manifest.placement.windowId,
      windowName: "agt-must-not-rename", paneTitle: "agt-second-task" });
    await backend.waitReady(second);
    assert.equal(second.placement.windowId, manifest.placement.windowId);
    assert.equal(await display(second.placement.paneId, "#{window_name}|#{pane_title}"), "agt-parser-review|agt-second-task");
    assert.notEqual(second.placement.paneId, manifest.placement.paneId);
    const secondPid = (await callTuiWorker(second, { operation: "status" }) as any).data.pid;
    const sessionFile = manifest.sessionFile;
    const promoted = await backend.promote([manifest, second], caller);
    manifest = promoted[0];
    assert.equal(await display(manifest.placement.paneId, "#{window_name}|#{pane_title}"), "agt-parser-review|agt-review-tests");
    parent.kill("SIGKILL");
    await new Promise<void>(resolve => parent.once("close", () => resolve()));
    assert.equal((await callTuiWorker(manifest, { operation: "status" }) as any).data.pid, piPid);
    assert.equal((await callTuiWorker(promoted[1], { operation: "status" }) as any).data.pid, secondPid);
    assert.equal(manifest.placement.sessionId, caller.sessionId);
    assert.equal(manifest.sessionFile, sessionFile);
    assert.equal((await callTuiWorker(manifest, { operation: "status" }) as any).data.pid, piPid);
    assert.equal(await tmux("display-message", "-p", "-t", sibling, "#{window_id}"), manifest.placement.windowId);
    assert.equal(await tmux("display-message", "-p", "-t", sibling, "#{pane_pid}"), siblingPid);
    assert.equal(await tmux("show-option", "-wqv", "-t", manifest.placement.windowId, "@pi_infrastructure"), "0");
    // Model control uses a custom message: slash-looking content cannot rename.
    const receipt = await callTuiWorker(manifest, { operation: "prompt", mode: "steer", message: "/name MODEL-MUST-NOT-RENAME" });
    assert.ok(receipt.ok);
    const settleDeadline = Date.now() + 10_000;
    while (store.readState().phase !== "settled" && Date.now() < settleDeadline) await sleep(50);
    assert.equal(store.readState().phase, "settled");
    const report = store.readState().lastReport!;
    assert.match(await readFile(report, "utf8"), /Deterministic completed task/);
    assert.equal((await backend.inspect(manifest)).dead, false);
    assert.match(await readFile(sessionFile, "utf8"), /keyboard-worker/);
    assert.doesNotMatch(await readFile(sessionFile, "utf8"), /"type":"session_info"[^\n]*MODEL-MUST-NOT-RENAME/);
    // A direct human conversation starts after terminal result: stale terminal
    // observations must not let reap cancel that new live turn.
    await tmux("send-keys", "-t", manifest.placement.paneId, "-l", "Human follow-up");
    await tmux("send-keys", "-t", manifest.placement.paneId, "Enter");
    const activeDeadline = Date.now() + 3000;
    while (!store.readState().active && Date.now() < activeDeadline) await sleep(10);
    assert.equal(store.readState().active, true);
    await assert.rejects(backend.reap(manifest), /busy/);
    assert.ok((await callTuiWorker(manifest, { operation: "cancel" })).ok);
    assert.equal((await backend.inspect(manifest)).dead, false);
    while (store.readState().active && Date.now() < activeDeadline + 5000) await sleep(25);
    await backend.reap(manifest);
    await backend.reap(manifest);
    assert.equal(await tmux("display-message", "-p", "-t", sibling, "#{pane_pid}"), siblingPid);
    assert.equal(await tmux("display-message", "-p", "-t", callerPane, "#{pane_id}"), callerPane);
    assert.match(await readFile(report, "utf8"), /Deterministic completed task/);
    await backend.reap(promoted[1]);
    // A background single creates a fresh visible window in the caller session.
    const single = await backend.launch({ ...input, launcher: rawPi!, parentDisposition: "native", launchMode: "none",
      directory: join(root, "single"), childId: `subagent-child-${"4".repeat(24)}`,
      groupId: `subagent-job-${"5".repeat(24)}`, foreground: false });
    await backend.waitReady(single);
    assert.equal(single.placement.sessionId, caller.sessionId);
    assert.equal(await display(single.placement.paneId, "#{window_name}|#{pane_title}"), "agt-parser-review|agt-review-tests");
    assert.notEqual(single.placement.windowId, caller.windowId);
    assert.notEqual(single.placement.windowId, manifest.placement.windowId);
    await backend.reap(single);
  } finally { await tmux("kill-server").catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
