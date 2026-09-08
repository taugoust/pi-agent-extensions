import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { JobPlacement } from "../shared/background-job.js";
import { promisify } from "node:util";
import type { JobLaunch } from "./types.js";
import type { JobStore } from "./store.js";

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;
const MAX_CLIENT_OUTPUT = 256 * 1024;
const SESSION = "pi-jobs";

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function stripTmuxExitFooter(output: string): string {
  // Legacy panes may already contain tmux's default footer. Job metadata owns
  // the exit status; this terminal decoration is not command output.
  return output.replace(/(?:\r?\n)*Pane is dead \(status -?\d+, [^\r\n]*\)\r?\n*$/, "");
}

export type PaneState = {
  exists: boolean;
  dead?: boolean;
  panePid?: number;
};

export interface JobProcessBackend {
  launch(id: string, cwd: string, jobDir: string, shell: string, options?: { placement?: JobPlacement; infrastructure?: boolean }): Promise<JobLaunch>;
  paneState(id: string, launch: JobLaunch): Promise<PaneState>;
  capture(id: string, launch: JobLaunch): Promise<string>;
  signal(id: string, launch: JobLaunch, signal: NodeJS.Signals): Promise<void>;
  kill(id: string, launch: JobLaunch): Promise<void>;
  reap?(id: string, launch: JobLaunch): Promise<void>;
  attachCommand(launch?: JobLaunch): string;
}

export async function processStartToken(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) throw new Error(`Cannot parse process identity for PID ${pid}`);
    const fields = text.slice(close + 2).trim().split(/\s+/);
    const start = fields[19];
    if (!start || !/^[0-9]+$/.test(start)) throw new Error(`Cannot parse process start time for PID ${pid}`);
    return `linux-proc:${start}`;
  }
  const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: TMUX_TIMEOUT_MS, maxBuffer: 4096 });
  const token = result.stdout.trim().replace(/\s+/g, " ");
  if (!token) throw new Error(`Cannot read process start time for PID ${pid}`);
  return `ps-lstart:${token}`;
}

async function placementAt(tmux: string, socketPath: string, paneId: string): Promise<JobPlacement> {
  if (!socketPath.startsWith('/') || socketPath.includes('\0') || !/^%[0-9]+$/.test(paneId)) throw new Error('Invalid trusted tmux placement');
  socketPath = await realpath(socketPath);
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('Tmux placement requires a same-user socket');
  const { stdout } = await execFileAsync(tmux, ['-S', socketPath, 'display-message', '-p', '-t', paneId, '#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}'], { timeout: TMUX_TIMEOUT_MS, maxBuffer: 4096 });
  const [sessionId, windowId, actualPane, pid, dead] = stdout.trim().split('|');
  if (!/^\$[0-9]+$/.test(sessionId ?? '') || !/^@[0-9]+$/.test(windowId ?? '') || actualPane !== paneId || dead !== '0' || !Number.isSafeInteger(Number(pid)) || Number(pid) < 1) throw new Error('Caller tmux pane is missing or no longer running');
  return { socketPath, sessionId, windowId, paneId, panePid: Number(pid), paneStartToken: await processStartToken(Number(pid)) };
}

export async function resolveLocalPlacement(tmux: string): Promise<JobPlacement> {
  const socket = process.env.TMUX?.replace(/,[0-9]+,[0-9]+$/, '');
  const pane = process.env.TMUX_PANE;
  if (!socket || !pane) throw new Error('background_job start requires Pi to run inside tmux (TMUX and TMUX_PANE); no private visible-job fallback is permitted');
  return await placementAt(tmux, socket, pane);
}

export async function validatePlacement(tmux: string, expected: JobPlacement): Promise<void> {
  const actual = await placementAt(tmux, expected.socketPath, expected.paneId);
  if (Object.keys(actual).some(key => actual[key as keyof JobPlacement] !== expected[key as keyof JobPlacement])) throw new Error('Trusted caller tmux placement is stale; refusing to launch in replacement work');
}

export class TmuxBackend implements JobProcessBackend {
  constructor(
    private readonly store: JobStore,
    private readonly tmuxPath: string,
    private readonly nodePath: string,
    private readonly runnerPath: string,
  ) {}

  private async run(args: string[], allowFailure = false, socket = this.store.socketPath): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const result = await execFileAsync(this.tmuxPath, ["-S", socket, ...(socket === this.store.socketPath ? ["-f", this.store.tmuxConfigPath] : []), ...args], {
        timeout: TMUX_TIMEOUT_MS,
        maxBuffer: MAX_CLIENT_OUTPUT,
        env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined } as NodeJS.ProcessEnv,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      if (allowFailure && typeof failure.code === "number") {
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
      }
      const detail = (failure.stderr || failure.message || String(error)).trim().slice(0, 1000);
      throw new Error(`tmux command failed: ${detail}`);
    }
  }

  private async sessionExists(): Promise<boolean> {
    const result = await this.run(["display-message", "-p", "-t", SESSION, "#{@pi_background_server}"], true);
    if (result.code === 0) {
      if (result.stdout.trim() !== "v1") throw new Error("Refusing a tmux server not owned by background-job");
      return true;
    }
    const anyServer = await this.run(["list-sessions", "-F", "#{session_name}"], true);
    if (anyServer.code === 0) throw new Error("Refusing an unexpected live tmux server at the background-job socket");
    return false;
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const info = await lstat(this.store.socketPath);
      if (!info.isSocket()) throw new Error("background-job tmux socket path is not a Unix socket");
      if (info.uid !== process.getuid?.()) throw new Error("background-job tmux socket has the wrong owner");
      await rm(this.store.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async launch(id: string, cwd: string, jobDir: string, shell: string, options?: { placement?: JobPlacement; infrastructure?: boolean }): Promise<JobLaunch> {
    if (process.platform !== "linux") throw new Error("Background job launch is supported only on Linux");
    if (!options?.infrastructure) {
      const placement = options?.placement ?? await resolveLocalPlacement(this.tmuxPath);
      await validatePlacement(this.tmuxPath, placement);
      const command = `${quote(this.nodePath)} ${quote(this.runnerPath)} ${quote(jobDir)} ${quote(shell)} 1048576`;
      const split = ['split-window', '-d', '-P', '-F', '#{window_id}|#{pane_id}|#{pane_pid}', '-t', placement.paneId, '-c', cwd, command].map(quote).join(' ');
      const guard = [
        `#{==:#{pane_pid},${placement.panePid}}`, `#{==:#{pane_dead},0}`,
        `#{==:#{window_id},${placement.windowId}}`, `#{==:#{session_id},${placement.sessionId}}`,
      ].reduce((left,right) => `#{&&:${left},${right}}`);
      const result = await this.run(['if-shell', '-F', '-t', placement.paneId, guard, split, 'display-message -p pi-job-placement-mismatch'], false, placement.socketPath);
      if (result.stdout.includes('pi-job-placement-mismatch')) throw new Error('Caller tmux placement changed before launch');
      return await this.finishLaunch(id, result.stdout, placement.socketPath, placement);
    }
    let exists = await this.sessionExists();
    if (!exists) await this.removeStaleSocket();
    const format = "#{window_id}|#{pane_id}|#{pane_pid}";
    const command = `${quote(this.nodePath)} ${quote(this.runnerPath)} ${quote(jobDir)} ${quote(shell)} 1048576`;
    const args = exists
      ? ["new-window", "-d", "-P", "-F", format, "-t", `${SESSION}:`, "-n", id, "-c", cwd, command]
      : ["new-session", "-d", "-P", "-F", format, "-s", SESSION, "-n", id, "-c", cwd, command];
    let result;
    try {
      result = await this.run(args);
    } catch (error) {
      if (!exists && await this.sessionExists()) {
        exists = true;
        result = await this.run(["new-window", "-d", "-P", "-F", format, "-t", `${SESSION}:`, "-n", id, "-c", cwd, command]);
      } else throw error;
    }
    return await this.finishLaunch(id, result.stdout, this.store.socketPath);
  }

  private async finishLaunch(id: string, output: string, socketPath: string, placement?: JobPlacement): Promise<JobLaunch> {
    const [windowId, paneId, pidRaw] = output.trim().split("|");
    const panePid = Number(pidRaw);
    if (!windowId || !paneId || !Number.isSafeInteger(panePid) || panePid < 1) {
      throw new Error(`tmux returned malformed launch identity: ${JSON.stringify(output.slice(0, 500))}`);
    }
    // The runner waits for launch-ready: set pane-local retention and ownership
    // before opening that gate. Never alter the caller's window options.
    const ownershipToken = randomBytes(16).toString('hex');
    await this.run(['set-option', '-p', '-t', paneId, 'remain-on-exit', 'on'], false, socketPath);
    await this.run(['set-option', '-p', '-t', paneId, 'remain-on-exit-format', ''], false, socketPath);
    await this.run(['set-option', '-p', '-t', paneId, '@pi_background_job_id', id], false, socketPath);
    await this.run(['set-option', '-p', '-t', paneId, '@pi_background_job_token', ownershipToken], false, socketPath);
    const identity = await this.run(['display-message', '-p', '-t', paneId, '#{pid}|#{session_id}|#{window_id}'], false, socketPath);
    const [serverRaw, sessionId, actualWindow] = identity.stdout.trim().split('|');
    if (!/^\$[0-9]+$/.test(sessionId ?? '') || actualWindow !== windowId || placement && (windowId !== placement.windowId || sessionId !== placement.sessionId)) throw new Error('Tmux launch placement changed');
    const serverPid = Number(serverRaw);
    const serverStartToken = await processStartToken(serverPid);
    const paneStartToken = await processStartToken(panePid);
    await this.run(['set-option', '-p', '-t', paneId, '@pi_background_job_start_token', paneStartToken], false, socketPath);
    // Repeated splits must not shrink the caller to an unsplittable sliver.
    // Layout failure does not invalidate an otherwise successfully owned job.
    if (placement) await this.run(['select-layout', '-t', windowId, 'tiled'], true, socketPath).catch(() => undefined);
    return {
      schemaVersion: 1,
      socketPath, sessionId, serverPid, serverStartToken, ownershipToken,
      windowId,
      paneId,
      panePid,
      paneStartToken,
      launchedAt: new Date().toISOString(),
    };
  }

  private async inspect(id: string, launch: JobLaunch): Promise<PaneState> {
    const socket = launch.socketPath ?? this.store.socketPath;
    if (launch.serverPid && await processStartToken(launch.serverPid).catch(() => '') !== launch.serverStartToken) throw new Error('Saved tmux server identity changed; refusing replacement work');
    const result = await this.run(["display-message", "-p", "-t", launch.paneId, "#{@pi_background_job_id}|#{pane_dead}|#{pane_pid}|#{@pi_background_job_token}|#{session_id}|#{window_id}|#{pid}|#{@pi_background_job_start_token}"], true, socket);
    if (result.code !== 0) return { exists: false };
    const [tag, deadRaw, pidRaw, token, session, window, server, startToken] = result.stdout.trim().split("|");
    // A foreground group is promoted with move-window. Its server-global window
    // and pane identities remain unchanged; sessionId is launch history only.
    if (launch.ownershipToken && (token !== launch.ownershipToken || startToken !== launch.paneStartToken || !/^\$[0-9]+$/.test(session ?? '') || window !== launch.windowId || Number(server) !== launch.serverPid)) throw new Error('Saved tmux pane ownership/placement changed; refusing replacement work');
    if (!tag && !deadRaw && !pidRaw) return { exists: false };
    if (tag !== id) throw new Error(`Refusing unowned tmux pane for ${id}: ${JSON.stringify(result.stdout.slice(0, 500))}`);
    const panePid = Number(pidRaw);
    if ((deadRaw !== "0" && deadRaw !== "1") || !Number.isSafeInteger(panePid)) {
      throw new Error("tmux returned malformed pane state");
    }
    if (panePid !== launch.panePid || deadRaw === '0' && await processStartToken(panePid).catch(() => '') !== launch.paneStartToken) throw new Error('Saved tmux pane start identity changed; refusing replacement work');
    return { exists: true, dead: deadRaw === "1", panePid };
  }

  async paneState(id: string, launch: JobLaunch): Promise<PaneState> {
    const state = await this.inspect(id, launch);
    if (!state.exists || state.dead) return state;
    if (state.panePid !== launch.panePid) return { exists: false };
    try {
      if (await processStartToken(launch.panePid) !== launch.paneStartToken) return { exists: false };
    } catch { return { exists: false }; }
    return state;
  }

  async capture(id: string, launch: JobLaunch): Promise<string> {
    const state = await this.inspect(id, launch);
    if (!state.exists) return "";
    const result = await this.run(["capture-pane", "-p", "-J", "-S", "-2000", "-t", launch.paneId], false, launch.socketPath ?? this.store.socketPath);
    return state.dead ? stripTmuxExitFooter(result.stdout) : result.stdout;
  }

  async signal(id: string, launch: JobLaunch, signal: NodeJS.Signals): Promise<void> {
    const state = await this.paneState(id, launch);
    if (!state.exists || state.dead) throw new Error(`Background job ${id} is not running`);
    process.kill(launch.panePid, signal);
  }

  async kill(id: string, launch: JobLaunch): Promise<void> {
    const state = await this.inspect(id, launch);
    if (!state.exists) return;
    if (!state.dead && state.panePid === launch.panePid) {
      try { process.kill(launch.panePid, "SIGUSR2"); } catch {}
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const current = await this.inspect(id, launch);
        if (!current.exists || current.dead) break;
      }
      const current = await this.inspect(id, launch);
      if (current.exists && !current.dead) {
        if (await processStartToken(launch.panePid) !== launch.paneStartToken) throw new Error('Pane process changed during cancellation');
        try { process.kill(launch.panePid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    // Cancellation terminates execution but deliberately retains the dead pane.
  }

  async reap(id: string, launch: JobLaunch): Promise<void> {
    let state = await this.inspect(id, launch);
    // result.json is published immediately before runner exit. Allow that short
    // handoff to settle without turning reap into implicit cancellation.
    for (let attempt = 0; state.exists && !state.dead && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      state = await this.inspect(id, launch);
    }
    if (!state.exists) return;
    if (!state.dead) throw new Error(`Background job ${id} pane is still running; cancel it first`);
    if (!launch.ownershipToken) throw new Error('Legacy pane lacks a reap ownership token; refusing automatic cleanup');
    // Check pane-local ownership inside tmux immediately before mutation.
    const checks = [
      `#{==:#{@pi_background_job_token},${launch.ownershipToken}}`,
      `#{==:#{@pi_background_job_id},${id}}`,
      `#{==:#{@pi_background_job_start_token},${launch.paneStartToken}}`,
      `#{==:#{pid},${launch.serverPid}}`,
      `#{==:#{window_id},${launch.windowId}}`,
      `#{==:#{pane_pid},${launch.panePid}}`, '#{pane_dead}',
    ];
    const guard = checks.reduce((left, right) => `#{&&:${left},${right}}`);
    const result = await this.run(['if-shell', '-F', '-t', launch.paneId, guard, `kill-pane -t ${launch.paneId}`, 'display-message -p pi-job-identity-mismatch'], false, launch.socketPath ?? this.store.socketPath);
    if (result.stdout.includes('pi-job-identity-mismatch')) throw new Error('Pane ownership changed; reap refused');
  }

  attachCommand(launch?: JobLaunch): string {
    return `tmux -S ${quote(launch?.socketPath ?? this.store.socketPath)} attach-session -t ${quote(launch?.sessionId ?? SESSION)}`;
  }
}
