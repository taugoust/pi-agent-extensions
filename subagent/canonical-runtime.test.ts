import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiWorkerTmux } from "./tui-worker-tmux.ts";
import { TaskNameStore } from "./task-name-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

const exec = promisify(execFile);
const launcher = process.env.PI_TUI_TEST_PI;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("tmux rename uses fresh owned placement and never renames a promoted caller session", async () => {
  const backend: any = new TuiWorkerTmux();
  const calls: string[][] = [];
  const original = { socketPath: "/owned/socket", sessionId: "$1", windowId: "@1", paneId: "%1" };
  let placement = { ...original, sessionId: "$2", windowId: "@2" };
  backend.inspect = async () => ({ dead: false, placement });
  backend.run = async (_socket: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "list-panes") return "%1";
    if (args[0] === "show-option") return args[1] === "-wqv" ? "owned-group" : "1";
    if (args[0] === "list-sessions") return "$1|old-name\n$2|human-name\n$3|human-name-2";
    return "";
  };
  const manifest: any = { execution: "tmux", groupId: "owned-group", presentation: "foreground-staged", placement: original };
  await backend.rename(manifest, "human-name");
  assert.ok(calls.some(args => args[0] === "rename-window" && args.includes("@2")));
  assert.equal(calls.some(args => args[0] === "rename-session"), false);
  calls.length = 0;
  await backend.rename(manifest, "other-child", false);
  assert.equal(calls.some(args => args[0] === "rename-window" || args[0] === "rename-session"), false);
  calls.length = 0;
  placement = original;
  await backend.rename(manifest, "human-name");
  assert.deepEqual(calls.find(args => args[0] === "rename-session"), ["rename-session", "-t", "$1", "human-name-3"]);
});

test("real native Pi keyboard rename updates canonical metadata and owned tmux alias without identity or visibility changes", { skip: !launcher, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-canonical-runtime-"));
  const socket = join(root, "tmux.sock"), config = join(root, "agent");
  const prior = process.env.PI_CODING_AGENT_DIR;
  const tmux = async (...args: string[]) => (await exec("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout.trim();
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "settings.json"), JSON.stringify({ extensions: [
    fileURLToPath(new URL("./tui-worker-test-provider.ts", import.meta.url)),
    fileURLToPath(new URL("./tui-worker-test-empty-jobs.ts", import.meta.url)),
  ], defaultProvider: "harness-test", defaultModel: "mock", quietStartup: true, enableSkillCommands: false, defaultProjectTrust: "no" }));
  process.env.PI_CODING_AGENT_DIR = config;
  try {
    await tmux("new-session", "-d", "-s", "parent", "-x", "120", "-y", "35", "sleep 90");
    await tmux("set-environment", "-g", "PI_CODING_AGENT_DIR", config);
    const pane = await tmux("display-message", "-p", "-t", "parent:", "#{pane_id}");
    const backend = new TuiWorkerTmux();
    const caller = await backend.resolveCaller({ TMUX: `${socket},1,0`, TMUX_PANE: pane });
    const directory = join(root, "workers", "one");
    const manifest = await backend.launch({ directory, ownerSessionId: "parent-session", taskId: "canonical-task", groupId: `subagent-job-${"1".repeat(24)}`,
      childId: `subagent-child-${"2".repeat(24)}`, attempt: 1, cwd: root, caller, foreground: false, parentDisposition: "native", launcher: launcher!,
      launchMode: "none", model: "harness-test/mock", windowName: "parser-review", paneTitle: "parser-review", displayName: "Parser Review" });
    await backend.waitReady(manifest);
    const before = await callTuiWorker(manifest, { operation: "status" });
    const names = new TaskNameStore(directory, manifest);
    assert.equal(names.read()?.displayName, "Parser Review");
    await tmux("send-keys", "-t", manifest.placement!.paneId, "-l", "/name Human Parser Name");
    await tmux("send-keys", "-t", manifest.placement!.paneId, "Enter");
    const deadline = Date.now() + 10000;
    while (names.read()?.displayName !== "Human Parser Name" && Date.now() < deadline) await pause(50);
    assert.equal(names.read()?.displayName, "Human Parser Name");
    while (await tmux("display-message", "-p", "-t", manifest.placement!.paneId, "#{pane_title}") !== "human-parser" && Date.now() < deadline) await pause(50);
    assert.equal(await tmux("display-message", "-p", "-t", manifest.placement!.paneId, "#{pane_title}"), "human-parser");
    const session = await readFile(manifest.sessionFile, "utf8");
    assert.match(session, /Human Parser Name/);
    const after = await callTuiWorker(manifest, { operation: "status" });
    assert.equal((after.data as any).pid, (before.data as any).pid);
    assert.equal(manifest.presentation, "background");
    assert.equal(names.read()?.taskId, manifest.taskId);
    assert.equal(names.read()?.workerEpoch, manifest.workerEpoch);
    await writeFile(join(root, "runtime-evidence.json"), JSON.stringify({ name: names.read(), beforePid: (before.data as any).pid, afterPid: (after.data as any).pid, presentation: manifest.presentation }, null, 2));
    console.log(`Canonical native runtime evidence: ${root}/runtime-evidence.json`);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await tmux("kill-server").catch(() => {});
    // Evidence directory intentionally retained; contains only isolated fixture state.
  }
});
