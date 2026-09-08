import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, realpath, writeFile, copyFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { TUI_WORKER_DISCOVERY_ENV, TUI_WORKER_MANIFEST_ENV } from "../shared/tui-worker-protocol.ts";
import type { TuiWorkerManifest, TuiWorkerPlacement } from "../shared/tui-worker-protocol.ts";
import { TuiWorkerStore, atomicPrivateJson, readPrivateJson } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

const exec = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NONCE = "@pi_tui_worker_nonce";
const GROUP = "@pi_subagent_group_id";

export async function processIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^\d+$/.test(token ?? "")) throw new Error("Cannot identify tmux server process");
    return `${pid}:${token}`;
  }
  throw new Error("Native TUI worker process identities are Linux-only");
}

export type TuiWorkerLaunch = {
  directory: string;
  ownerSessionId: string; taskId: string; groupId: string; childId: string; attempt: number;
  cwd: string;
  caller: TuiWorkerPlacement;
  foreground: boolean;
  /** Join a verified same-group window, including a staged foreground window. */
  groupWindowId?: string;
  /** Trusted actual parent runtime disposition, NOT a tool parameter. */
  parentDisposition: "native" | "guard-only" | "full" | "unavailable";
  launcher: string;
  launchMode: "guard-only" | "none";
  model?: string;
  systemPrompt?: string;
  acceptance?: string[];
  resumeSessionFile?: string;
  tools?: string[];
  operatorCapabilityHash?: string;
  workerExtension?: string;
};

/** Capture from trusted extension runtime, not from model-supplied tool args. */
export function tuiWorkerLaunchContract(parentDisposition: TuiWorkerLaunch["parentDisposition"], env: NodeJS.ProcessEnv = process.env) {
  const launcher = env.PI_TUI_WORKER_LAUNCHER;
  const launchMode = env.PI_TUI_WORKER_LAUNCH_MODE;
  if (!launcher || !isAbsolute(launcher) || (launchMode !== "guard-only" && launchMode !== "none")
    || parentDisposition === "full" || parentDisposition === "unavailable"
    || launchMode !== (parentDisposition === "guard-only" ? "guard-only" : "none")) {
    throw new Error("Missing or mismatched trusted TUI worker launcher; native fallback disabled");
  }
  return { launcher, launchMode };
}

export class TuiWorkerTmux {
  readonly executable: string;
  constructor(executable = "tmux") {
    if (process.platform !== "linux") throw new Error("Durable native TUI workers are Linux-only");
    this.executable = executable;
  }
  private async run(socket: string, args: string[]): Promise<string> {
    return (await exec(this.executable, ["-S", socket, ...args], { timeout: 5000, maxBuffer: 256 * 1024,
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } })).stdout.trim();
  }
  async resolveCaller(env: NodeJS.ProcessEnv = process.env): Promise<TuiWorkerPlacement> {
    if (!env.TMUX || !/^%[0-9]+$/.test(env.TMUX_PANE ?? "")) throw new Error("TUI workers require a calling tmux pane");
    const comma = env.TMUX.lastIndexOf(",");
    const second = env.TMUX.lastIndexOf(",", comma - 1);
    const socket = await realpath(env.TMUX.slice(0, second));
    return await this.locate(socket, env.TMUX_PANE!, randomBytes(32).toString("hex"));
  }
  private async epoch(socket: string): Promise<string> {
    const pid = Number(await this.run(socket, ["display-message", "-p", "#{pid}"]));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid tmux server PID");
    return await processIdentity(pid);
  }
  private async locate(socketPath: string, paneId: string, ownershipNonce: string): Promise<TuiWorkerPlacement> {
    const line = await this.run(socketPath, ["display-message", "-p", "-t", paneId, "#{session_id}|#{window_id}|#{pane_id}"]);
    const [sessionId, windowId, actualPane] = line.split("|");
    if (!/^\$[0-9]+$/.test(sessionId) || !/^@[0-9]+$/.test(windowId) || actualPane !== paneId) throw new Error("Invalid tmux placement");
    return { socketPath, serverEpoch: await this.epoch(socketPath), sessionId, windowId, paneId, ownershipNonce };
  }
  async inspect(m: TuiWorkerManifest): Promise<{ dead: boolean; panePid: number; placement: TuiWorkerPlacement }> {
    const p = m.placement;
    if (await this.epoch(p.socketPath) !== p.serverEpoch) throw new Error("Tmux server identity changed");
    const line = await this.run(p.socketPath, ["display-message", "-p", "-t", p.paneId,
      `#{${NONCE}}|#{${GROUP}}|#{pane_dead}|#{pane_pid}`]);
    const [nonce, group, dead, pid] = line.split("|");
    if (nonce !== p.ownershipNonce || group !== m.groupId || !["0", "1"].includes(dead) || !/^[1-9][0-9]*$/.test(pid)
      || (m.panePid !== undefined && Number(pid) !== m.panePid)) throw new Error("Worker pane ownership changed");
    if (dead === "0" && m.paneProcessToken && await processIdentity(Number(pid)) !== m.paneProcessToken) throw new Error("Worker pane process identity changed");
    return { dead: dead === "1", panePid: Number(pid), placement: await this.locate(p.socketPath, p.paneId, p.ownershipNonce) };
  }
  async launch(input: TuiWorkerLaunch): Promise<TuiWorkerManifest> {
    if (input.parentDisposition === "full" || input.parentDisposition === "unavailable"
      || input.launchMode !== (input.parentDisposition === "guard-only" ? "guard-only" : "none")) throw new Error("Worker launcher mode does not match parent authority; native fallback disabled");
    if (!isAbsolute(input.launcher)) throw new Error("Worker launcher must be an absolute trusted executable");
    const launcher = await realpath(input.launcher);
    if (!launcher.startsWith("/nix/store/")) throw new Error("Worker launcher must resolve to immutable Nix store executable");
    await access(launcher, constants.X_OK);
    const cwd = await realpath(input.cwd);
    const store = new TuiWorkerStore(input.directory, true);
    // Never reuse a committed launch gate or spawn a second Pi for an attempt.
    // Reconnect through the existing manifest instead of retrying launch.
    await writeFile(store.path("launch.lock"), "allocated\n", { flag: "wx", mode: 0o600 });
    const caller = input.caller;
    if (await this.epoch(caller.socketPath) !== caller.serverEpoch) throw new Error("Calling tmux server changed");
    const currentCaller = await this.locate(caller.socketPath, caller.paneId, caller.ownershipNonce);
    if (currentCaller.sessionId !== caller.sessionId) throw new Error("Calling pane moved before launch");
    const nonce = randomBytes(32).toString("hex");
    const runtimeId = `tui-${randomBytes(12).toString("hex")}`;
    const workerEpoch = randomBytes(16).toString("hex");
    const controlSocket = join(store.directory, "control.sock");
    const sessionFile = join(store.directory, "session.jsonl");
    if (input.resumeSessionFile) {
      await copyFile(input.resumeSessionFile, sessionFile, constants.COPYFILE_EXCL);
      await chmod(sessionFile, 0o600);
    }
    const manifestPath = store.path("manifest.json");
    const extension = input.workerExtension ?? fileURLToPath(new URL("./tui-worker-extension.ts", import.meta.url));
    const argv = [launcher, "--session", sessionFile, "--extension", extension];
    argv.push("--model", input.model ?? "openai-codex/gpt-6-astra:low");
    if (input.systemPrompt) {
      const promptPath = store.path("system-prompt.txt");
      await writeFile(promptPath, input.systemPrompt, { flag: "wx", mode: 0o600 });
      argv.push("--append-system-prompt", promptPath);
    }
    if (input.tools) argv.push("--tools", [...new Set([...input.tools, "notify_parent", "task_outcome"])].join(","));
    // Fresh child-local authority is supplied by immutable launcher. Never reuse
    // parent's relay capability or accidentally inherit full supervisor markers.
    const remove = ["AGENTSH_PERMISSION_GATE_SOCKET", "PI_SUBAGENT_PERMISSION_SOCKET", "PI_SUBAGENT_PERMISSION_TOKEN", "PI_SUBAGENT_OUTCOME_PATH",
      "AGENTSH_SESSION_SUPERVISOR", "AGENTSH_CHILD_CAPABILITY", "AGENTSH_APPROVAL_UI_SOCKET",
      "PI_AGENTSH_ENABLE", "PI_AGENTSH_MOCK_SUPERVISOR", "PI_SUPERVISED", "PI_AUTO", "PI_AGENTSH_REMOTE", "PI_AGENTSH_READ_MODE"];
    const identityEnv: Record<string, string> = {
      [TUI_WORKER_MANIFEST_ENV]: manifestPath,
      PI_TUI_WORKER_LAUNCH_MODE: input.launchMode,
      PI_TUI_WORKER_LAUNCHER: launcher,
      PI_SUBAGENT_ID: input.childId,
    };
    const identity = { ...input, runtimeId, controlSocket };
    for (const [key, name] of Object.entries(TUI_WORKER_DISCOVERY_ENV)) identityEnv[name] = String(identity[key as keyof typeof identity]);
    const command = ["env", ...remove.flatMap(name => ["-u", name]), ...Object.entries(identityEnv).map(([k, v]) => `${k}=${v}`), ...argv].map(quote).join(" ");
    const gate = store.path("launch-ready");
    // No Pi executes until its manifest and pane ownership are committed. Parent
    // death before commit leaves a bounded, non-executing launch shell.
    const shell = `i=0; while [ ! -f ${quote(gate)} ]; do i=$((i+1)); [ "$i" -lt 400 ] || exit 125; sleep 0.05; done; exec ${command}`;
    atomicPrivateJson(store.path("launch-intent.json"), { groupId: input.groupId, childId: input.childId, nonce, runtimeId });
    let paneId: string;
    const format = "#{pane_id}";
    if (input.groupWindowId) {
      if (!/^@[0-9]+$/.test(input.groupWindowId)) throw new Error("Invalid group window");
      const group = await this.run(caller.socketPath, ["show-option", "-wqv", "-t", input.groupWindowId, GROUP]);
      if (group !== input.groupId) throw new Error("Refusing foreign group window");
      paneId = await this.run(caller.socketPath, ["split-window", "-d", "-P", "-F", format, "-t", input.groupWindowId, "-c", cwd, shell]);
    } else if (input.foreground) {
      // One staging session per group avoids cross-parent naming/creation races.
      const sessionName = `pi-stage-${input.groupId}`;
      paneId = await this.run(caller.socketPath, ["new-session", "-d", "-P", "-F", format, "-s", sessionName,
        "-n", input.groupId, "-c", cwd, "-x", "120", "-y", "35", shell]);
    } else {
      paneId = await this.run(caller.socketPath, ["new-window", "-d", "-P", "-F", format, "-t", `${caller.sessionId}:`, "-n", input.groupId, "-c", cwd, shell]);
    }
    if (!/^%[0-9]+$/.test(paneId)) throw new Error("Invalid launched pane identity");
    const placement = await this.locate(caller.socketPath, paneId, nonce);
    if (placement.serverEpoch !== caller.serverEpoch) throw new Error("Tmux server changed during worker launch");
    const panePid = Number(await this.run(caller.socketPath, ["display-message", "-p", "-t", paneId, "#{pane_pid}"]));
    const paneProcessToken = await processIdentity(panePid);
    atomicPrivateJson(store.path("launch-pane.json"), placement);
    // Ownership is pane-local; remain-on-exit is local, never a server option.
    await this.run(caller.socketPath, ["set-option", "-p", "-t", paneId, NONCE, nonce]);
    await this.run(caller.socketPath, ["set-option", "-p", "-t", paneId, GROUP, input.groupId]);
    await this.run(caller.socketPath, ["set-option", "-w", "-t", placement.windowId, GROUP, input.groupId]);
    await this.run(caller.socketPath, ["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
    await this.run(caller.socketPath, ["select-layout", "-t", placement.windowId, "tiled"]);
    await this.run(caller.socketPath, ["set-option", "-w", "-t", placement.windowId, "@pi_infrastructure", input.foreground ? "1" : "0"]);
    if (input.foreground) await this.run(caller.socketPath, ["set-option", "-t", placement.sessionId, "@pi_infrastructure", "1"]);
    const m: TuiWorkerManifest = { protocol: 1, ownerSessionId: input.ownerSessionId, taskId: input.taskId,
      groupId: input.groupId, childId: input.childId, attempt: input.attempt, runtimeId, workerEpoch,
      controlSocket, controlToken: randomBytes(32).toString("hex"), sessionFile, placement, panePid, paneProcessToken,
      presentation: input.foreground ? "foreground-staged" : "background", launchMode: input.launchMode,
      acceptance: input.acceptance ?? [], tools: input.tools,
      ...(input.foreground ? { foregroundOwner: { pid: process.pid, token: await processIdentity(process.pid) } } : {}),
      ...(input.operatorCapabilityHash ? { operatorCapabilityHash: input.operatorCapabilityHash } : {}) };
    store.writeManifest(m);
    await writeFile(gate, "ready\n", { flag: "wx", mode: 0o600 });
    return m;
  }
  async waitReady(manifest: TuiWorkerManifest, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.inspect(manifest)).dead) throw new Error("Worker exited before control became ready");
      try {
        const status = await callTuiWorker(manifest, { operation: "status" }, { timeoutMs: 500 });
        if (status.ok && (status.data as { readyForPrompts?: boolean })?.readyForPrompts === true) return;
      } catch {}
      await pause(50);
    }
    throw new Error("Worker startup timed out; owned pane and launch artifacts retained");
  }
  /** Move the entire staged group window, including its local background jobs. */
  async promote(manifests: TuiWorkerManifest[], target: TuiWorkerPlacement): Promise<TuiWorkerManifest[]> {
    if (!manifests.length) throw new Error("No workers to promote");
    const first = await this.inspect(manifests[0]);
    if (target.socketPath !== first.placement.socketPath || target.serverEpoch !== first.placement.serverEpoch) throw new Error("Promotion must use the same tmux server");
    for (const manifest of manifests) {
      const info = await this.inspect(manifest);
      if (info.placement.windowId !== first.placement.windowId || manifest.groupId !== manifests[0].groupId) throw new Error("Promotion requires one group window");
    }
    const childPanes = (await this.run(target.socketPath, ["list-panes", "-t", first.placement.windowId,
      "-F", `#{pane_id}|#{${NONCE}}`])).split("\n").filter(line => line.split("|")[1]).map(line => line.split("|")[0]);
    if (childPanes.some(pane => !manifests.some(manifest => manifest.placement.paneId === pane))) throw new Error("Promotion requires every worker manifest in the staged group window");
    if (!/^\$[0-9]+$/.test(target.sessionId)) throw new Error("Invalid target session");
    // Durable lifetime transfer precedes the UI move: parent death in the gap
    // leaves a recoverable staged durable worker, never a killed promoted task.
    for (const manifest of manifests) {
      new TuiWorkerStore(dirname(manifest.sessionFile)).writeManifest({ ...manifest, presentation: "background", foregroundOwner: undefined });
    }
    if (first.placement.sessionId !== target.sessionId) await this.run(target.socketPath,
      ["move-window", "-d", "-s", first.placement.windowId, "-t", `${target.sessionId}:`]);
    await this.run(target.socketPath, ["set-option", "-w", "-t", first.placement.windowId, "@pi_infrastructure", "0"]);
    const promoted: TuiWorkerManifest[] = [];
    for (const manifest of manifests) {
      const actual = await this.inspect(manifest);
      const placement = actual.placement;
      // Launcher updates discovery even if an observer disconnects mid-promotion.
      // Worker independently validates that the live pane identity is preserved.
      const next = { ...manifest, placement, presentation: "background" as const, foregroundOwner: undefined };
      const store = new TuiWorkerStore(dirname(manifest.sessionFile));
      store.writeManifest(next);
      if (!actual.dead) {
        const response = await callTuiWorker(manifest, { operation: "promote", placement }, { requestId: `promote:${target.sessionId.slice(1)}` });
        if (!response.ok) throw new Error(`Worker promotion control failed: ${response.code}`);
      }
      promoted.push(next);
    }
    return promoted;
  }
  async reap(manifest: TuiWorkerManifest, timeoutMs = 10_000): Promise<void> {
    const store = new TuiWorkerStore(dirname(manifest.sessionFile));
    // A prior verified deletion is idempotent. No other pane is sought by name.
    try {
      const tombstone = readPrivateJson(store.path("reaped.json")) as { workerEpoch?: string; paneId?: string };
      if (tombstone.workerEpoch !== manifest.workerEpoch || tombstone.paneId !== manifest.placement.paneId) throw new Error("Reap tombstone identity mismatch");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let info;
    try { info = await this.inspect(manifest); }
    catch (error) {
      // Crash after verified kill-pane but before tombstone publication: only
      // reconcile an exact durable intent on the same still-live server.
      const intent = readPrivateJson(store.path("reap-intent.json")) as { workerEpoch?: string; paneId?: string };
      if (intent.workerEpoch !== manifest.workerEpoch || intent.paneId !== manifest.placement.paneId
        || await this.epoch(manifest.placement.socketPath) !== manifest.placement.serverEpoch) throw error;
      const panes = (await this.run(manifest.placement.socketPath, ["list-panes", "-a", "-F", "#{pane_id}"])).split("\n");
      if (panes.includes(manifest.placement.paneId)) throw error;
      atomicPrivateJson(store.path("reaped.json"), { ...intent, reapedAt: new Date().toISOString() });
      return;
    }
    if (!info.dead) {
      const response = await callTuiWorker(manifest, { operation: "prepare_reap" }, { requestId: `reap:${manifest.workerEpoch}` });
      if (!response.ok) throw new Error(`Worker reap rejected: ${response.code}`);
      const deadline = Date.now() + timeoutMs;
      while (!info.dead && Date.now() < deadline) { await pause(50); info = await this.inspect(manifest); }
      if (!info.dead) throw new Error("Worker has not exited after idle cleanup reservation; refusing to kill a live Pi");
    }
    // Reverify immediately before the sole destructive tmux operation.
    info = await this.inspect(manifest);
    if (!info.dead) throw new Error("Worker is active; refusing reap");
    atomicPrivateJson(store.path("reap-intent.json"), { workerEpoch: manifest.workerEpoch, paneId: manifest.placement.paneId });
    const p = manifest.placement;
    const condition = `#{&&:#{&&:#{==:#{${NONCE}},${p.ownershipNonce}},#{==:#{pane_pid},${info.panePid}}},#{pane_dead}}`;
    const removed = await this.run(p.socketPath, ["if-shell", "-F", "-t", p.paneId, condition,
      `kill-pane -t ${p.paneId}`, "display-message -p PI_REAP_REFUSED"]);
    if (removed.includes("PI_REAP_REFUSED")) throw new Error("Worker pane changed at reap boundary");
    atomicPrivateJson(store.path("reaped.json"), { workerEpoch: manifest.workerEpoch, paneId: manifest.placement.paneId, reapedAt: new Date().toISOString() });
  }
}
