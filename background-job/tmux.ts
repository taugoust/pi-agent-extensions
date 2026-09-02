import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
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

export type PaneState = {
  exists: boolean;
  dead?: boolean;
  panePid?: number;
};

export interface JobProcessBackend {
  launch(id: string, cwd: string, jobDir: string, shell: string): Promise<JobLaunch>;
  paneState(id: string, launch: JobLaunch): Promise<PaneState>;
  capture(id: string, launch: JobLaunch): Promise<string>;
  signal(id: string, launch: JobLaunch, signal: NodeJS.Signals): Promise<void>;
  kill(id: string, launch: JobLaunch): Promise<void>;
  attachCommand(): string;
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

export class TmuxBackend implements JobProcessBackend {
  constructor(
    private readonly store: JobStore,
    private readonly tmuxPath: string,
    private readonly nodePath: string,
    private readonly runnerPath: string,
  ) {}

  private async run(args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const result = await execFileAsync(this.tmuxPath, ["-S", this.store.socketPath, "-f", this.store.tmuxConfigPath, ...args], {
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

  async launch(id: string, cwd: string, jobDir: string, shell: string): Promise<JobLaunch> {
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
    const [windowId, paneId, pidRaw] = result.stdout.trim().split("|");
    const panePid = Number(pidRaw);
    if (!windowId || !paneId || !Number.isSafeInteger(panePid) || panePid < 1) {
      throw new Error(`tmux returned malformed launch identity: ${JSON.stringify(result.stdout.slice(0, 500))}`);
    }
    try {
      if (!exists) await this.run(["set-option", "-g", "@pi_background_server", "v1"]);
      await this.run(["set-option", "-w", "-t", windowId, "@pi_background_job_id", id]);
      const paneStartToken = await processStartToken(panePid);
      return {
        schemaVersion: 1,
        windowId,
        paneId,
        panePid,
        paneStartToken,
        launchedAt: new Date().toISOString(),
      };
    } catch (error) {
      await this.run(["kill-window", "-t", windowId], true).catch(() => undefined);
      throw error;
    }
  }

  private async inspect(id: string, launch: JobLaunch): Promise<PaneState> {
    const result = await this.run(["display-message", "-p", "-t", launch.paneId, "#{@pi_background_job_id}|#{pane_dead}|#{pane_pid}"], true);
    if (result.code !== 0) return { exists: false };
    const [tag, deadRaw, pidRaw] = result.stdout.trim().split("|");
    if (!tag && !deadRaw && !pidRaw) return { exists: false };
    if (tag !== id) throw new Error(`Refusing unowned tmux pane for ${id}: ${JSON.stringify(result.stdout.slice(0, 500))}`);
    const panePid = Number(pidRaw);
    if ((deadRaw !== "0" && deadRaw !== "1") || !Number.isSafeInteger(panePid)) {
      throw new Error("tmux returned malformed pane state");
    }
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
    const result = await this.run(["capture-pane", "-p", "-J", "-S", "-2000", "-t", launch.paneId]);
    return result.stdout;
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
      try { process.kill(launch.panePid, "SIGKILL"); } catch {}
    }
    await this.run(["kill-window", "-t", launch.windowId], true);
    const after = await this.inspect(id, launch);
    if (after.exists) throw new Error(`Failed to remove owned tmux window for ${id}`);
  }

  attachCommand(): string {
    return `tmux -S ${quote(this.store.socketPath)} attach-session -t ${SESSION}`;
  }
}
