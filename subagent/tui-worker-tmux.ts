import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, realpath, writeFile, copyFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { TUI_WORKER_DISCOVERY_ENV, TUI_WORKER_MANIFEST_ENV } from "../shared/tui-worker-protocol.ts";
import type { TuiPlacedWorkerManifest, TuiWorkerManifest, TuiWorkerPlacement } from "../shared/tui-worker-protocol.ts";
import { TuiWorkerStore, atomicPrivateJson, readPrivateJson } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import { TaskNameStore } from "./task-name-store.ts";
import { guidanceLaunchEnvironment } from "./guidance.ts";
import { subagentTmuxName, subagentTmuxAlias } from "./tui-names.ts";

const exec = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const NONCE = "@pi_tui_worker_nonce";
const GROUP = "@pi_subagent_group_id";
// Reloaded extension factories and separate backend instances must share ordering.
const aliasQueueKey = Symbol.for("pi-agent-extensions.worker-tmux-alias-queue.v1");
const aliasGlobals = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const aliasQueues = aliasGlobals[aliasQueueKey] ??= new Map<string, Promise<void>>();

/** Best-effort presentation: coalesce edits, retry unchanged desired aliases, stop on reload. */
export class WorkerAliasProjection {
  private desired?: string;
  private applied?: string;
  private pending?: Promise<void>;
  private stopped = false;
  private warned?: string;
  private readonly apply: (alias: string) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  constructor(apply: (alias: string) => Promise<void>, onError: (error: unknown) => void = () => {}) { this.apply = apply; this.onError = onError; }
  request(alias: string): Promise<void> { if (!this.stopped) this.desired = alias; return this.retry(); }
  retry(): Promise<void> {
    if (this.stopped || this.pending || !this.desired || this.desired === this.applied) return this.pending ?? Promise.resolve();
    let failedAlias: string | undefined;
    const operation = (async () => {
      while (!this.stopped && this.desired && this.desired !== this.applied) {
        const alias = this.desired;
        try { await this.apply(alias); }
        catch (error) {
          if (this.stopped) return;
          if (alias !== this.desired) continue;
          failedAlias = alias;
          if (this.warned !== alias) { this.warned = alias; try { this.onError(error); } catch {} }
          return; // The next metadata observation retries, even without a name revision.
        }
        this.applied = alias;
        this.warned = undefined;
      }
    })();
    this.pending = operation;
    const clear = () => {
      if (this.pending !== operation) return;
      this.pending = undefined;
      // A newer request can arrive between the drain finishing and this callback.
      // Resume it, but never spin on a failed unchanged alias without observation.
      if (!this.stopped && this.desired !== this.applied && this.desired !== failedAlias) void this.retry();
    };
    void operation.then(clear, clear);
    return operation;
  }
  stop(): void { this.stopped = true; this.desired = undefined; }
}
function requiredPlacement(manifest: TuiWorkerManifest): TuiWorkerPlacement {
  if (manifest.execution === "rpc-headless" || !manifest.placement) throw new Error("Headless worker has no tmux placement");
  return manifest.placement;
}

export async function processIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^\d+$/.test(token ?? "")) throw new Error("Cannot identify tmux server process");
    return `${pid}:${token}`;
  }
  throw new Error("Native TUI worker process identities are Linux-only");
}
/** Unlike identity reads used to verify tmux snapshots, a zombie is not live work. */
export async function processIsAlive(pid: number, expectedToken: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X" && `${pid}:${fields[19]}` === expectedToken;
  } catch { return false; }
}

export type TuiWorkerLaunch = {
  directory: string;
  ownerSessionId: string; taskId: string; groupId: string; childId: string; attempt: number;
  cwd: string;
  caller: TuiWorkerPlacement;
  foreground: boolean;
  /** Join a verified same-group window, including a staged foreground window. */
  groupWindowId?: string;
  /** Presentation only; supplied at creation, never used to locate workers. */
  windowName?: string;
  paneTitle?: string;
  displayName?: string;
  nameWindow?: boolean;
  /** Trusted actual parent runtime disposition, NOT a tool parameter. */
  parentDisposition: "native" | "guard-only" | "full" | "unavailable";
  launcher: string;
  launchMode: "guard-only" | "none";
  model?: string;
  /** Captured from the owning runtime, never accepted from model tool arguments. */
  routingEnvironment?: Record<string, string>;
  systemPrompt?: string;
  acceptance?: string[];
  verification?: import("./acceptance.ts").VerificationGate[];
  resumeSessionFile?: string;
  tools?: string[];
  operatorCapabilityHash?: string;
  workerExtension?: string;
};

/** Capture from trusted extension runtime, not from model-supplied tool args. */
export function tuiWorkerLaunchContract(parentDisposition: TuiWorkerLaunch["parentDisposition"], env: NodeJS.ProcessEnv = process.env): { launcher: string; launchMode: "guard-only" | "none" } {
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
    const p = requiredPlacement(m);
    for (let attempt = 0; ; attempt++) {
      if (await this.epoch(p.socketPath) !== p.serverEpoch) throw new Error("Tmux server identity changed");
      const line = await this.run(p.socketPath, ["display-message", "-p", "-t", p.paneId,
        `#{${NONCE}}|#{${GROUP}}|#{pane_dead}|#{pane_pid}`]);
      const [nonce, group, dead, pid] = line.split("|");
      if (nonce !== p.ownershipNonce || group !== m.groupId || !["0", "1"].includes(dead) || !/^[1-9][0-9]*$/.test(pid)
        || (m.panePid !== undefined && Number(pid) !== m.panePid)) throw new Error("Worker pane ownership changed");
      if (dead === "0" && m.paneProcessToken) {
        let token: string;
        try { token = await processIdentity(Number(pid)); }
        catch (error) {
          // The process may exit after tmux's live snapshot but before /proc is
          // read. Missing /proc is NOT proof of an owned dead pane: obtain a
          // fresh snapshot and revalidate every identity, with bounded retries.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 2) throw error;
          await pause(25);
          continue;
        }
        if (token !== m.paneProcessToken) throw new Error("Worker pane process identity changed");
      }
      const placement = await this.locate(p.socketPath, p.paneId, p.ownershipNonce);
      if (placement.serverEpoch !== p.serverEpoch) throw new Error("Tmux server identity changed");
      return { dead: dead === "1", panePid: Number(pid), placement };
    }
  }
  async launch(input: TuiWorkerLaunch): Promise<TuiWorkerManifest> {
    const windowName = input.windowName ?? subagentTmuxName("");
    const paneTitle = input.paneTitle ?? windowName;
    if (![windowName, paneTitle].every(name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.trim() === name && name.length <= 32)) throw new Error("Invalid native TUI display name");
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
    } else {
      // Pi preserves permissions when opening an existing --session path; if
      // left absent, its default create mode may be group/world-readable.
      await writeFile(sessionFile, "", { flag: "wx", mode: 0o600 });
    }
    const manifestPath = store.path("manifest.json");
    const extension = input.workerExtension ?? fileURLToPath(new URL("./tui-worker-extension.ts", import.meta.url));
    const argv = [launcher, "--session", sessionFile, "--extension", extension];
    // New tasks arrive with their configured model resolved by the router.
    // Legacy resumes without a recorded model must retain Pi's session choice.
    if (input.model) argv.push("--model", input.model);
    if (input.systemPrompt) {
      const promptPath = store.path("system-prompt.txt");
      await writeFile(promptPath, input.systemPrompt, { flag: "wx", mode: 0o600 });
      argv.push("--append-system-prompt", promptPath);
    }
    if (input.tools) argv.push("--tools", [...new Set([...input.tools, "notify_parent", "task_outcome", "request_guidance", "guidance"])].join(","));
    // Fresh child-local authority is supplied by immutable launcher. Never reuse
    // parent's relay capability or accidentally inherit full supervisor markers.
    const remove = ["AGENTSH_PERMISSION_GATE_SOCKET", "PI_SUBAGENT_PERMISSION_SOCKET", "PI_SUBAGENT_PERMISSION_TOKEN", "PI_SUBAGENT_OUTCOME_PATH",
      "AGENTSH_SESSION_SUPERVISOR", "AGENTSH_CHILD_CAPABILITY", "AGENTSH_APPROVAL_UI_SOCKET",
      "PI_AGENTSH_ENABLE", "PI_AGENTSH_MOCK_SUPERVISOR", "PI_SUPERVISED", "PI_AUTO", "PI_AGENTSH_REMOTE", "PI_AGENTSH_READ_MODE", "PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"];
    const routing = input.routingEnvironment ?? {};
    if (Object.keys(routing).some(key => !["PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"].includes(key))) throw new Error("Invalid private routing environment");
    const identityEnv: Record<string, string> = {
      ...guidanceLaunchEnvironment({ ownerSessionId: input.ownerSessionId, taskId: input.taskId, childId: input.childId, attempt: input.attempt, workerEpoch }),
      // Use the caller's config/defaults, not the tmux server's stale environment.
      PI_CODING_AGENT_DIR: getAgentDir(),
      ...routing,
      [TUI_WORKER_MANIFEST_ENV]: manifestPath,
      PI_TUI_WORKER_LAUNCH_MODE: input.launchMode,
      PI_TUI_WORKER_LAUNCHER: launcher,
      PI_SUBAGENT_ID: input.childId,
      PI_SUBAGENT_CANONICAL_NAMES: input.displayName ? "1" : "",
      PI_SUBAGENT_NAME_WINDOW: input.nameWindow === false ? "0" : "1",
      PI_SUBAGENT_NAME: input.displayName ?? paneTitle.replace(/^agt-/, "").replace(/-/g, " ").split(/\s+/).slice(0, 4).join(" "),
    };
    const identity = { ...input, runtimeId, controlSocket };
    for (const [key, name] of Object.entries(TUI_WORKER_DISCOVERY_ENV)) identityEnv[name] = String(identity[key as keyof typeof identity]);
    const command = ["env", ...remove.flatMap(name => ["-u", name]), ...Object.entries(identityEnv).map(([k, v]) => `${k}=${v}`), ...argv].map(quote).join(" ");
    const gate = store.path("launch-ready");
    // No Pi executes until its manifest and pane ownership are committed. Parent
    // death before commit leaves a bounded, non-executing launch shell.
    // The marker is part of tmux's initial pane_start_command, unlike options
    // written after new-window. Paseo can classify the gate shell before Pi imports.
    const intentPath = store.path("launch-intent.json");
    const marker = `${Buffer.from(intentPath).toString("base64url")}.${nonce}`;
    const shell = `PASEO_MANAGED_LAUNCH=${marker}; i=0; while [ ! -f ${quote(gate)} ]; do i=$((i+1)); [ "$i" -lt 400 ] || exit 125; sleep 0.05; done; exec ${command}`;
    atomicPrivateJson(intentPath, { schemaVersion: 1, command: shell, groupId: input.groupId, childId: input.childId, nonce, runtimeId,
      socketPath: caller.socketPath, serverEpoch: caller.serverEpoch,
      ownerPid: process.pid, ownerToken: await processIdentity(process.pid),
      presentation: input.foreground ? "foreground-staged" : "background" });
    let paneId: string;
    const format = "#{pane_id}";
    if (input.groupWindowId) {
      if (!/^@[0-9]+$/.test(input.groupWindowId)) throw new Error("Invalid group window");
      const group = await this.run(caller.socketPath, ["show-option", "-wqv", "-t", input.groupWindowId, GROUP]);
      if (group !== input.groupId) throw new Error("Refusing foreign group window");
      paneId = await this.run(caller.socketPath, ["split-window", "-d", "-P", "-F", format, "-t", input.groupWindowId, "-c", cwd, shell]);
    } else if (input.foreground) {
      const occupied = new Set((await this.run(caller.socketPath, ["list-sessions", "-F", "#{session_name}"])).split("\n"));
      paneId = "";
      for (let tries = 0; tries < 1000; tries++) {
        const sessionName = subagentTmuxAlias(input.displayName ?? paneTitle.replace(/^agt-/, "").replace(/-/g, " "), occupied);
        try {
          paneId = await this.run(caller.socketPath, ["new-session", "-d", "-P", "-F", format, "-s", sessionName,
            "-n", windowName, "-c", cwd, "-x", "120", "-y", "35", shell]);
          break;
        } catch (error) {
          if (!/duplicate session/i.test(String(error))) throw error;
          occupied.add(sessionName); // Atomic tmux creation resolves cross-parent races.
        }
      }
      if (!paneId) throw new Error("Tmux readable session alias collisions exhausted");
    } else {
      paneId = await this.run(caller.socketPath, ["new-window", "-d", "-P", "-F", format, "-t", `${caller.sessionId}:`, "-n", windowName, "-c", cwd, shell]);
    }
    if (!/^%[0-9]+$/.test(paneId)) throw new Error("Invalid launched pane identity");
    const placement = await this.locate(caller.socketPath, paneId, nonce);
    if (placement.serverEpoch !== caller.serverEpoch) throw new Error("Tmux server changed during worker launch");
    const panePid = Number(await this.run(caller.socketPath, ["display-message", "-p", "-t", paneId, "#{pane_pid}"]));
    const paneProcessToken = await processIdentity(panePid);
    atomicPrivateJson(store.path("launch-pane.json"), placement);
    // Freeze only newly allocated presentation; never rename joined/live windows.
    if (!input.groupWindowId) {
      await this.run(caller.socketPath, ["set-option", "-w", "-t", placement.windowId, "automatic-rename", "off"]);
      await this.run(caller.socketPath, ["set-option", "-w", "-t", placement.windowId, "allow-rename", "off"]);
    }
    await this.run(caller.socketPath, ["set-option", "-p", "-t", paneId, "allow-set-title", "off"]);
    await this.run(caller.socketPath, ["select-pane", "-t", paneId, "-T", paneTitle]);
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
      presentation: input.foreground ? "foreground-staged" : "background", execution: "tmux", launchMode: input.launchMode,
      acceptance: input.acceptance ?? [], verification: input.verification, tools: input.tools,
      ...(input.foreground ? { foregroundOwner: { pid: process.pid, token: await processIdentity(process.pid) } } : {}),
      ...(input.operatorCapabilityHash ? { operatorCapabilityHash: input.operatorCapabilityHash } : {}) };
    store.writeManifest(m);
    if (input.displayName) await new TaskNameStore(input.directory, m).claim(input.displayName);
    await writeFile(gate, "ready\n", { flag: "wx", mode: 0o600 });
    return m;
  }
  async rename(manifest: TuiWorkerManifest, alias: string, nameWindow = true): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias) || alias.length > 40) throw new Error("Invalid canonical tmux alias");
    if (manifest.execution === "rpc-headless" || !manifest.placement) return;
    const target = structuredClone(manifest);
    const key = JSON.stringify([target.ownerSessionId, target.taskId, target.groupId, target.childId, target.attempt, target.runtimeId, target.workerEpoch]);
    const previous = aliasQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.applyAlias(target, alias, nameWindow));
    aliasQueues.set(key, operation);
    const clear = () => { if (aliasQueues.get(key) === operation) aliasQueues.delete(key); };
    void operation.then(clear, clear);
    return operation;
  }
  private async applyAlias(manifest: TuiWorkerManifest, alias: string, nameWindow: boolean): Promise<void> {
    // Inspect after prior work settles: never reuse an earlier placement/authority snapshot.
    const inspected = await this.inspect(manifest);
    if (inspected.dead) throw new Error("Cannot rename stale worker placement");
    const p = inspected.placement;
    await this.run(p.socketPath, ["select-pane", "-t", p.paneId, "-T", alias]);
    const ownedWindow = nameWindow && await this.run(p.socketPath, ["show-option", "-wqv", "-t", p.windowId, GROUP]) === manifest.groupId;
    if (ownedWindow) await this.run(p.socketPath, ["rename-window", "-t", p.windowId, alias]);
    if (ownedWindow && manifest.presentation === "foreground-staged" && p.sessionId === manifest.placement.sessionId
      && await this.run(p.socketPath, ["show-option", "-qv", "-t", p.sessionId, "@pi_infrastructure"]) === "1") {
      const names = (await this.run(p.socketPath, ["list-sessions", "-F", "#{session_id}|#{session_name}"])).split("\n")
        .filter(line => !line.startsWith(`${p.sessionId}|`)).map(line => line.slice(line.indexOf("|") + 1));
      await this.run(p.socketPath, ["rename-session", "-t", p.sessionId, subagentTmuxAlias(alias, names)]);
    }
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
    // Preserve a bounded diagnosis, never terminal contents (which may contain
    // credentials). Revalidate ownership on both sides of the read-only capture.
    let reason = "control-not-ready";
    try {
      const before = await this.inspect(manifest);
      const p = before.placement;
      const pane = await this.run(p.socketPath, ["capture-pane", "-p", "-S", "-80", "-t", p.paneId]);
      const after = await this.inspect(manifest);
      if (after.placement.paneId === p.paneId && /Trust project folder\?/.test(pane)) reason = "project-trust-prompt";
    } catch { /* Missing or changed placement is not authority to capture elsewhere. */ }
    atomicPrivateJson(new TuiWorkerStore(dirname(manifest.sessionFile)).path("startup-failure.json"), {
      workerEpoch: manifest.workerEpoch, reason, at: new Date().toISOString(),
    });
    throw new Error(`Worker startup timed out (${reason}); owned pane and launch artifacts retained`);
  }
  /** Move the entire staged group window, including its local background jobs. */
  async promote(manifests: TuiWorkerManifest[], target: TuiWorkerPlacement): Promise<TuiWorkerManifest[]> {
    if (!manifests.length) throw new Error("No workers to promote");
    const placed = manifests.map(manifest => {
      if (manifest.execution === "rpc-headless" || !manifest.placement) throw new Error("Headless workers cannot be promoted to tmux");
      return manifest as TuiPlacedWorkerManifest;
    });
    const firstManifest = placed[0]!;
    const firstPlacement = requiredPlacement(firstManifest);
    const first = await this.inspect(firstManifest);
    if (target.socketPath !== firstPlacement.socketPath || target.serverEpoch !== firstPlacement.serverEpoch) throw new Error("Promotion must use the same tmux server");
    for (const manifest of placed) {
      const info = await this.inspect(manifest);
      if (info.placement.windowId !== firstPlacement.windowId || manifest.groupId !== firstManifest.groupId) throw new Error("Promotion requires one group window");
    }
    const childPanes = (await this.run(target.socketPath, ["list-panes", "-t", firstPlacement.windowId,
      "-F", `#{pane_id}|#{${NONCE}}`])).split("\n").filter(line => line.split("|")[1]).map(line => line.split("|")[0]);
    if (childPanes.some(pane => !placed.some(manifest => requiredPlacement(manifest).paneId === pane))) throw new Error("Promotion requires every worker manifest in the staged group window");
    if (!/^\$[0-9]+$/.test(target.sessionId)) throw new Error("Invalid target session");
    // Durable lifetime transfer precedes the UI move: parent death in the gap
    // leaves a recoverable staged durable worker, never a killed promoted task.
    for (const manifest of placed) {
      new TuiWorkerStore(dirname(manifest.sessionFile)).writeManifest({ ...manifest, presentation: "background", execution: "tmux", foregroundOwner: undefined });
    }
    if (firstPlacement.sessionId !== target.sessionId) await this.run(target.socketPath,
      ["move-window", "-d", "-s", firstPlacement.windowId, "-t", `${target.sessionId}:`]);
    await this.run(target.socketPath, ["set-option", "-w", "-t", firstPlacement.windowId, "@pi_infrastructure", "0"]);
    const promoted: TuiPlacedWorkerManifest[] = [];
    for (const manifest of placed) {
      const actual = await this.inspect(manifest);
      const placement = actual.placement;
      // Launcher updates discovery even if an observer disconnects mid-promotion.
      // Worker independently validates that the live pane identity is preserved.
      const next: TuiPlacedWorkerManifest = { ...manifest, placement, presentation: "background", execution: "tmux", foregroundOwner: undefined };
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
      if (tombstone.workerEpoch !== manifest.workerEpoch || tombstone.paneId !== requiredPlacement(manifest).paneId) throw new Error("Reap tombstone identity mismatch");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const verifyCleanup = () => {
      const state = store.readState();
      if (!state.sealed || !state.reapReservation || state.jobCleanup?.workerEpoch !== manifest.workerEpoch
        || typeof state.jobCleanup.artifact !== "string") {
        throw new Error("Worker exited without verified child-local job cleanup; job inventory is unknown. Recover the child controller or explicitly inspect/adopt its retained jobs with user authorization before recovery; refusing reap");
      }
      const artifactName = state.jobCleanup.artifact.slice(store.directory.length + 1);
      if (store.path(artifactName) !== state.jobCleanup.artifact) throw new Error("Invalid child job cleanup artifact");
      const cleanup = readPrivateJson(state.jobCleanup.artifact) as { workerEpoch?: string; report?: { subagents?: unknown } };
      if (cleanup.workerEpoch !== manifest.workerEpoch) throw new Error("Child job cleanup receipt identity mismatch; refusing reap");
      if (!cleanup.report?.subagents) throw new Error("Worker lacks verified recursive subagent cleanup; recover its controller before reap");
    };
    let info;
    try { info = await this.inspect(manifest); }
    catch (error) {
      // Crash after verified kill-pane but before tombstone publication: only
      // reconcile an exact durable intent on the same still-live server.
      const intent = readPrivateJson(store.path("reap-intent.json")) as { workerEpoch?: string; paneId?: string };
      if (intent.workerEpoch !== manifest.workerEpoch || intent.paneId !== requiredPlacement(manifest).paneId
        || await this.epoch(requiredPlacement(manifest).socketPath) !== requiredPlacement(manifest).serverEpoch) throw error;
      const panes = (await this.run(requiredPlacement(manifest).socketPath, ["list-panes", "-a", "-F", "#{pane_id}"])).split("\n");
      if (panes.includes(requiredPlacement(manifest).paneId)) throw error;
      verifyCleanup();
      atomicPrivateJson(store.path("reaped.json"), { ...intent, reapedAt: new Date().toISOString() });
      return;
    }
    if (!info.dead) {
      const status = await callTuiWorker(manifest, { operation: "status" }, { timeoutMs: 1000 });
      if (!status.ok) throw new Error(`Worker cleanup capability query failed (${status.code}); recover its controller before retrying reap. No pane was killed`);
      if ((status.data as any)?.recursiveCleanup !== true) throw new Error("Worker lacks recursive subagent cleanup support. A legacy worker may be pinned to an old immutable --extension entrypoint, so ordinary reload/resume may not upgrade it. Preserve the pane and recover a current child-local controller with verified job/subagent cleanup before reaping; no pane was killed");
      const response = await callTuiWorker(manifest, { operation: "prepare_reap" }, { requestId: `reap:${manifest.workerEpoch}`, timeoutMs: 30_000 });
      if (!response.ok) throw new Error(`Worker reap rejected: ${response.code}: ${response.message}`);
      const deadline = Date.now() + timeoutMs;
      while (!info.dead && Date.now() < deadline) { await pause(50); info = await this.inspect(manifest); }
      if (!info.dead) throw new Error("Worker has not exited after idle cleanup reservation; refusing to kill a live Pi");
    }
    // A dead worker cannot delegate cleanup. Never infer an empty job inventory
    // from death (or inspect another session's job store using parent authority).
    // Only a child-written seal + cleanup receipt proves pre-reap verification.
    verifyCleanup();
    // Reverify immediately before the sole destructive tmux operation.
    info = await this.inspect(manifest);
    if (!info.dead) throw new Error("Worker is active; refusing reap");
    const placement = requiredPlacement(manifest);
    atomicPrivateJson(store.path("reap-intent.json"), { workerEpoch: manifest.workerEpoch, paneId: placement.paneId });
    const p = placement;
    const condition = `#{&&:#{&&:#{==:#{${NONCE}},${p.ownershipNonce}},#{==:#{pane_pid},${info.panePid}}},#{pane_dead}}`;
    const removed = await this.run(p.socketPath, ["if-shell", "-F", "-t", p.paneId, condition,
      `kill-pane -t ${p.paneId}`, "display-message -p PI_REAP_REFUSED"]);
    if (removed.includes("PI_REAP_REFUSED")) throw new Error("Worker pane changed at reap boundary");
    atomicPrivateJson(store.path("reaped.json"), { workerEpoch: manifest.workerEpoch, paneId: placement.paneId, reapedAt: new Date().toISOString() });
  }
}
