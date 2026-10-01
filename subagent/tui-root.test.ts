import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processIsAlive } from "./tui-worker-tmux.ts";

const execute = promisify(execFile);
const launcher = process.env.PI_TUI_ROOT_LAUNCHER;
const mode = process.env.PI_TUI_ROOT_MODE ?? "none";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

test("actual root subagent tool: guarded/native launch, crash hydration, group control, explicit resume and reap", { skip: !launcher, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-root-"));
  const socket = join(root, "tmux.sock"), config = join(root, "agent"), result = join(root, "result.json"), permissionFile = join(root, "permission-target");
  await writeFile(permissionFile, "guarded fixture\n", { mode: 0o600 });
  const tmux = async (...args: string[]) => (await execute("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout.trim();
  await mkdir(config, { mode: 0o700 });
  const extensions = [fileURLToPath(new URL("../background-job/index.ts", import.meta.url)), fileURLToPath(new URL("../questionnaire/index.ts", import.meta.url)), fileURLToPath(new URL("./tui-worker-test-provider.ts", import.meta.url)), fileURLToPath(new URL("./tui-root-test-extension.ts", import.meta.url))];
  if (mode === "guard-only") extensions.unshift(fileURLToPath(new URL("../permission-gate/index.ts", import.meta.url)));
  await writeFile(join(config, "settings.json"), JSON.stringify({ extensions, defaultProvider: "harness-test", defaultModel: "mock", defaultProjectTrust: "no", quietStartup: true }));
  const environment = { PI_CODING_AGENT_DIR: config, PI_TUI_WORKER_STATE_ROOT: join(root, "state"), PI_TUI_ROOT_RESULT: result,
    PI_TUI_WORKER_LAUNCHER: launcher!, PI_TUI_WORKER_LAUNCH_MODE: mode, PI_TUI_ROOT_PERMISSION_FILE: permissionFile,
    PI_PASEO_EXISTING_AGENT_ID: "malicious-parent-agent", PI_PASEO_BRIDGE_FORCE: "1",
    PI_PASEO_TMUX_TARGET: "malicious-session:9", PI_PASEO_CONTROL_SOCKET: "/tmp/malicious-paseo.sock" };
  const command = ["env", "-u", "AGENTSH_PERMISSION_GATE_SOCKET", "-u", "PI_SUBAGENT_ID", "-u", "PI_SUBAGENT_PERMISSION_SOCKET", "-u", "PI_SUBAGENT_PERMISSION_TOKEN",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), launcher!, "--session", join(root, "parent-session.jsonl")].map(quote).join(" ");
  let parentPane: string;
  const send = async (text: string) => { await tmux("send-keys", "-t", parentPane, "-l", text); await tmux("send-keys", "-t", parentPane, "Enter"); };
  const capture = () => tmux("capture-pane", "-p", "-S", "-200", "-t", parentPane).catch(() => "");
  const waitForPaneText = async (marker: string, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = await capture();
      if (text.includes(marker)) return text;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for rendered marker ${JSON.stringify(marker)}\\n${await capture()}`);
  };
  const waitForReady = () => waitForPaneText("ROOT_FIXTURE_READY", 30_000);
  const waitFile = async (path: string, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { return JSON.parse(await readFile(path, "utf8")); } catch {}
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${path}\\n${await capture()}`);
  };
  try {
    parentPane = await tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "root", "-x", "150", "-y", "45", command);
    await tmux("set-option", "-p", "-t", parentPane, "remain-on-exit", "on");
    for (const [key, value] of Object.entries(environment)) await tmux("set-environment", "-g", key, value);
    await waitForReady();
    await send("Root persistence fixture");
    await waitForPaneText("Deterministic completed task.", 30_000);
    await send("/tui-root-background");
    const first = await waitFile(result, 60_000);
    assert.equal(first.ok, true, JSON.stringify(first));
    const saved = first.result;
    process.kill(saved.rootPid, "SIGKILL");
    const headlessExitDeadline = Date.now() + 30_000;
    while (Date.now() < headlessExitDeadline && await processIsAlive(saved.headlessPid, saved.headlessToken)) await sleep(100);
    assert.equal(await processIsAlive(saved.headlessPid, saved.headlessToken), false, "headless foreground child survived owner death");
    await sleep(500);
    await rm(result);
    parentPane = await tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "root:", command);
    await tmux("set-option", "-p", "-t", parentPane, "remain-on-exit", "on");
    await waitForReady();
    await send("/tui-root-check");
    const final = await waitFile(result, 170_000);
    assert.equal(final.ok, true, JSON.stringify(final));
    assert.equal(final.result.rootTool, true);
    assert.equal(final.result.guard, mode === "guard-only");
  } catch (error) { console.error("ROOT_TEST_FAILURE", error); throw error; }
  finally {
    // Only this test's isolated tmux server is ever destroyed.
    await tmux("kill-server").catch(() => undefined);
    await sleep(1000);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
