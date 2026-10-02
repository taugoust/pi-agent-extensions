#!/usr/bin/env node
import { linkSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const [, , jobDir, shell, maximumRaw = "1048576"] = process.argv;
const maximum = Number(maximumRaw);
if (!jobDir || !shell || !Number.isSafeInteger(maximum) || maximum < 65536 || maximum > 16 * 1024 * 1024) {
  process.stderr.write("invalid background-job runner arguments\n");
  process.exit(125);
}

const commandPath = join(jobDir, "command");
const environmentPath = join(jobDir, "environment");
const outputPath = join(jobDir, "output.log");
const processPath = join(jobDir, "process.json");
const resultPath = join(jobDir, "result.json");
const cancelPath = join(jobDir, "cancel-requested");
const launchReadyPath = join(jobDir, "launch-ready");
const runnerReadyPath = join(jobDir, "runner-ready");
const metadataPath = join(jobDir, "metadata.json");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLaunchReady() {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const deadline = Date.now() + 120_000;
  for (;;) {
    try { readFileSync(launchReadyPath); return; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { readFileSync(cancelPath); throw new Error("launch was cancelled"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { readFileSync(resultPath); throw new Error("launch controller published a terminal result"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("launch controller handshake timed out");
    if (!controllerIsAlive(metadata.ownerPid, metadata.ownerToken)) throw new Error("launch controller exited before opening launch gate");
    await sleep(25);
  }
}

function controllerIsAlive(pid, expectedToken) {
  if (process.platform === "linux") {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8"), close = text.lastIndexOf(")");
      const fields = text.slice(close + 2).trim().split(/\s+/);
      return fields[19] && `linux-proc:${fields[19]}` === expectedToken;
    } catch { return false; }
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return !!result.stdout?.trim() && `ps-lstart:${result.stdout.trim().replace(/\s+/g, " ")}` === expectedToken;
}

function parseEnvironment(bytes) {
  const env = {};
  for (const entry of bytes.toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("malformed environment entry");
    const name = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("invalid environment name");
    env[name] = entry.slice(separator + 1);
  }
  return env;
}

let tail = Buffer.alloc(0);
let dirty = false;
let flushTimer;
let sequence = 0;
let loggerFailed = false;

function flush() {
  if (!dirty) return;
  dirty = false;
  const temporary = `${outputPath}.tmp-${process.pid}-${++sequence}`;
  writeFileSync(temporary, tail, { mode: 0o600 });
  renameSync(temporary, outputPath);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    try { flush(); } catch (error) {
      loggerFailed = true;
      process.stderr.write(`background-job log flush failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, 250);
  flushTimer.unref();
}

function capture(chunk, descriptor) {
  const data = Buffer.from(chunk);
  try { writeSync(descriptor, data); } catch {}
  tail = tail.length === 0 ? data : Buffer.concat([tail, data]);
  if (tail.length > maximum) tail = tail.subarray(tail.length - maximum);
  dirty = true;
  scheduleFlush();
}

function processStartToken(pid) {
  if (process.platform === "linux") {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    const fields = close < 0 ? [] : text.slice(close + 2).trim().split(/\s+/);
    if (!fields[19] || !/^[0-9]+$/.test(fields[19])) throw new Error("cannot read command process identity");
    return `linux-proc:${fields[19]}`;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const token = result.stdout?.trim().replace(/\s+/g, " ");
  if (!token) throw new Error("cannot read command process identity");
  return `ps-lstart:${token}`;
}

function publishProcess(pid) {
  const temporary = `${processPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, pid, startToken: processStartToken(pid), startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, processPath);
}

function publishResult(result) {
  const temporary = `${resultPath}.candidate-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
  try { linkSync(temporary, resultPath); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  finally { try { unlinkSync(temporary); } catch {} }
}

let child;
let childClosed;
let requestedSignal;
try {
  const runnerIdentity = { schemaVersion: 1, pid: process.pid, startToken: processStartToken(process.pid), startedAt: new Date().toISOString() };
  const readyTemporary = `${runnerReadyPath}.tmp-${process.pid}`;
  writeFileSync(readyTemporary, `${JSON.stringify(runnerIdentity)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(readyTemporary, runnerReadyPath);
  await waitForLaunchReady();
  try { readFileSync(cancelPath); throw new Error("launch was cancelled"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const environment = parseEnvironment(readFileSync(environmentPath));
  // The actual tmux-created runner pane wins over the controller snapshot.
  if (process.env.TMUX) environment.TMUX = process.env.TMUX;
  if (process.env.TMUX_PANE) environment.TMUX_PANE = process.env.TMUX_PANE;
  const command = readFileSync(commandPath, "utf8");
  rmSync(environmentPath, { force: true });
  rmSync(commandPath, { force: true });
  // Hold the command behind stdin until its process identity is durably saved.
  // The gate avoids SIGCONT-before-SIGSTOP scheduling races entirely.
  const gateToken = randomBytes(24).toString("hex");
  const quotedShell = `'${shell.replaceAll("'", `'\\''`)}'`;
  const quotedCommand = `'${command.replaceAll("'", `'\\''`)}'`;
  const quotedToken = `'${gateToken}'`;
  child = spawn(shell, ["-c", `IFS= read -r gate <&3 || exit 125; exec 3<&-; [ \"$gate\" = ${quotedToken} ] || exit 125; exec ${quotedShell} -c ${quotedCommand} background-job`], {
    cwd: process.cwd(),
    env: environment,
    detached: true,
    stdio: ["inherit", "pipe", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("command process has no PID");
  childClosed = new Promise(resolve => child.once("close", resolve));
  child.on("error", error => capture(Buffer.from(`background-job spawn failed: ${error.message}\\n`), 2));
  child.stdout.on("data", (chunk) => capture(chunk, 1));
  child.stderr.on("data", (chunk) => capture(chunk, 2));
  publishProcess(child.pid);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      requestedSignal = signal;
      try { process.kill(-child.pid, signal); } catch {}
    });
  }
  process.on("SIGUSR2", () => {
    requestedSignal = "SIGKILL";
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  child.on("close", (code, signal) => {
    if (flushTimer) clearTimeout(flushTimer);
    try { flush(); } catch { loggerFailed = true; }
    const cancelled = (() => { try { readFileSync(cancelPath); return true; } catch { return false; } })();
    const effectiveCode = loggerFailed && code === 0 ? 125 : code;
    const status = cancelled ? "cancelled" : effectiveCode === 0 && signal === null ? "completed" : "failed";
    publishResult({
      schemaVersion: 1,
      status,
      exitCode: effectiveCode,
      ...(signal || requestedSignal ? { signal: signal || requestedSignal } : {}),
      finishedAt: new Date().toISOString(),
      ...(loggerFailed ? { reason: "bounded output logger failed" } : {}),
    });
    process.exit(status === "completed" ? 0 : effectiveCode ?? 128);
  });
  await new Promise((resolve, reject) => {
    child.stdio[3].once("error", reject);
    child.stdio[3].end(`${gateToken}\n`, resolve);
  });
} catch (error) {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    if (childClosed) await childClosed;
  }
  rmSync(environmentPath, { force: true });
  rmSync(commandPath, { force: true });
  capture(Buffer.from(`background-job runner failed: ${error instanceof Error ? error.message : String(error)}\n`), 2);
  try { flush(); } catch {}
  const cancelled = (() => { try { readFileSync(cancelPath); return true; } catch { return false; } })();
  publishResult({
    schemaVersion: 1,
    status: cancelled ? "cancelled" : "failed",
    exitCode: cancelled ? null : 125,
    ...(cancelled ? { signal: "SIGTERM" } : {}),
    finishedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
  });
  process.exit(125);
}
