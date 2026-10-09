import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import assert from "node:assert/strict";
import { writeFile, readFile, lstat, readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { sharedBackgroundSubagentManager } from "./background.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import subagent from "./index.ts";
import { TuiWorkerStore, discoverTuiWorkers, atomicPrivateJson } from "./tui-worker-store.ts";
import { FOREGROUND_TASKS_KEY } from "../shared/foreground-tasks.ts";
import { HARNESS_READONLY_KEY } from "../shared/harness-readonly.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";
import { processIdentity } from "./tui-worker-tmux.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

/** Explicit real-root integration fixture. Never enabled outside tests. */
export default function rootTest(pi: ExtensionAPI) {
  let tool: any;
  const commands = new Map<string, any>();
  const proxy = new Proxy(pi, { get(target, property) {
    if (property === "registerTool") return (value: any) => { if (value.name === "subagent") tool = value; return target.registerTool(value); };
    if (property === "registerCommand") return (name: string, value: any) => { commands.set(name, value); return target.registerCommand(name, value); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  subagent(proxy);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("root-test-ready", "ROOT_FIXTURE_READY");
  });
  const output = process.env.PI_TUI_ROOT_RESULT!;
  const backgroundFile = `${output}.background`;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const register = (name: string, work: (ctx: any) => Promise<unknown>) => pi.registerCommand(name, {
    description: "Deterministic root tool integration test",
    handler: async (_args, ctx) => {
      try { await writeFile(output, JSON.stringify({ ok: true, result: await work(ctx) })); }
      catch (error) { await writeFile(output, JSON.stringify({ ok: false, error: String(error), stack: (error as Error).stack })); }
    },
  });
  let sequence = 0;
  const execute = (ctx: any, params: any) => tool.execute(`root-test-${++sequence}`, params, undefined, undefined, ctx);
  const manifestFor = (group: any, index = 0) => new TuiWorkerStore(dirname(group.children[index].runtime.sessionFile)).readManifest();
  const wait = async (ctx: any, job: string) => {
    const value = await execute(ctx, { operation: "wait", job_id: job, wait_ms: 60_000 });
    assert.equal(value.details.group.status, "completed", JSON.stringify(value));
    return value.details.group;
  };
  const answerHeadlessInteraction = async (ctx: any, marker: string, answer: any, kind: string) => {
    const pendingRun = tool.execute(`root-test-interaction-${marker}-${Date.now()}`, { task: marker, model: "harness-test/mock:off" }, undefined, undefined, ctx);
    void pendingRun.catch(() => undefined);
    const service = (globalThis as any)[FOREGROUND_TASKS_KEY];
    const deadline = Date.now() + 30_000;
    let target: any, interaction: any;
    while (Date.now() < deadline) {
      const listed = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" });
      const task = listed.tasks?.find((item: any) => item.title.includes(marker));
      if (task) {
        target = { taskId: task.taskId, childId: task.childId, workerEpoch: task.workerEpoch };
        const view = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "view", target });
        interaction = view.view?.interactions?.find((item: any) => item.request.kind === kind);
        if (interaction) break;
      }
      await sleep(100);
    }
    if (!interaction) {
      const finalList = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" });
      const finalTask = finalList.tasks?.find((item: any) => item.childId === target?.childId);
      const finalView = target ? await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "view", target }) : undefined;
      const worker = target ? discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId())
        .find(item => item.childId === target.childId) : undefined;
      const diagnostic: any = { finalTask, interactions: finalView?.view?.interactions,
        messages: finalView?.view?.messages?.slice(-8), worker: worker && { workerEpoch: worker.workerEpoch, runtimePid: worker.runtimePid, execution: worker.execution } };
      if (worker) {
        const store = new TuiWorkerStore(dirname(worker.sessionFile));
        try { diagnostic.status = await callTuiWorker(worker, { operation: "status" }); } catch (error) { diagnostic.statusError = String(error); }
        try { diagnostic.workerState = store.readState(false); } catch (error) { diagnostic.workerStateError = String(error); }
        try { diagnostic.stderr = store.readRpcLogTail("stderr", 12 * 1024); } catch (error) { diagnostic.stderrError = String(error); }
        try { diagnostic.stdout = store.readRpcLogTail("stdout", 12 * 1024).split("\\n").slice(-20).join("\\n"); } catch (error) { diagnostic.stdoutError = String(error); }
      }
      throw new Error(`Headless ${kind} adapter did not publish its typed pending request: ${JSON.stringify(diagnostic).slice(0, 20_000)}`);
    }
    const receipt = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "respond",
      target, requestId: `root-answer-${marker}`, interactionId: interaction.id, answer });
    assert.equal(receipt.accepted, true, JSON.stringify(receipt));
    const result = await pendingRun;
    assert.equal(result.details.group.status, "completed", JSON.stringify(result));
    return result;
  };
  register("tui-root-background", async ctx => {
    pi.setSessionName("tui-root-test");
    const gate = (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__;
    gate?.applyMode(ctx.sessionManager.getSessionId(), false);
    const paneSnapshot = async () => (await promisify(execFile)("tmux", ["list-panes", "-a", "-F", "#{pane_id}"])).stdout.trim().split("\n").filter(Boolean).sort();
    const panesBeforeHeadless = await paneSnapshot();
    const foreground = await execute(ctx, { task: "REPORT_OUTCOME", model: "harness-test/mock:off", acceptance: ["fixture"] });
    assert.equal(foreground.details.group.status, "completed", JSON.stringify(foreground));
    const foregroundId = foreground.details.group.children[0].task_id;
    const headless = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId())
      .find(worker => worker.taskId === foregroundId)!;
    assert.ok(headless, "default foreground launch did not commit a discoverable worker");
    assert.equal(headless.execution, "rpc-headless");
    assert.equal(headless.presentation, "headless-foreground");
    assert.equal(Object.hasOwn(headless, "placement"), false, "headless manifest fabricated tmux placement");
    assert.equal((await lstat(headless.fifoPath!)).isFIFO(), true);
    assert.ok(headless.runtimePid && headless.runtimeProcessToken, "worker-ready handshake must authenticate the actual Pi PID");
    assert.equal(await readlink(`/proc/${headless.runtimePid}/fd/0`), headless.fifoPath, "child Pi did not retain its own FIFO stdin descriptor");
    assert.equal(await processIdentity(headless.runtimePid!), headless.runtimeProcessToken);
    const workerDirectory = dirname(headless.sessionFile);
    const runtimePolicy = await readFile(join(workerDirectory, "system-prompt.txt"), "utf8");
    assert.match(runtimePolicy, /flat helper and MUST NOT call the subagent tool/);
    assert.match(runtimePolicy, /harness-user-control/);
    for (const name of ["rpc.stdout.log", "rpc.stderr.log"]) {
      const log = await lstat(join(workerDirectory, name));
      assert.equal((log.mode & 0o077), 0, "RPC diagnostics must remain private");
      assert.ok(log.size <= 512 * 1024, "RPC diagnostics must be byte-bounded");
    }
    const childEnvironment = (await readFile(`/proc/${headless.runtimePid}/environ`)).toString("utf8").split("\0");
    assert.ok(!childEnvironment.some(entry => entry.startsWith("TMUX=") || entry.startsWith("TMUX_PANE=")), "headless worker inherited tmux targeting");
    assert.equal(childEnvironment.find(entry => entry.startsWith("PI_PASEO_BRIDGE_NO_IMPORT=")), "PI_PASEO_BRIDGE_NO_IMPORT=1");
    assert.ok(!childEnvironment.some(entry => /^PI_PASEO_(?!BRIDGE_NO_IMPORT=)/.test(entry)), "parent Paseo identity/force/control variables leaked into worker");
    assert.equal(process.env.PI_PASEO_EXISTING_AGENT_ID, "malicious-parent-agent", "headless launch mutated parent Paseo binding");
    const paused = await execute(ctx, { task: "PAUSE_BEFORE_TASK_OUTCOME", model: "harness-test/mock:off", background: true });
    const pauseDeadline = Date.now() + 30_000;
    let pausedWorker: any, pausedState: any, pausedMarker: any;
    while (Date.now() < pauseDeadline) {
      const group = (await execute(ctx, { operation: "status", job_id: paused.details.job_id })).details.group;
      const child = group.children?.[0];
      if (child?.task_id) {
        pausedWorker = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId())
          .find(item => item.taskId === child.task_id);
        if (pausedWorker) {
          pausedState = await callTuiWorker(pausedWorker, { operation: "status" });
          try { pausedMarker = JSON.parse(await readFile(`${dirname(pausedWorker.sessionFile)}/manifest.json.paused-stream.json`, "utf8")); } catch {}
          if (pausedState.data?.active && pausedMarker?.emitted === true) break;
        }
      }
      await sleep(100);
    }
    assert.ok(pausedWorker && pausedState?.data?.active && pausedMarker?.emitted === true,
      `paused provider never emitted its partial tool call while active: ${JSON.stringify({ launched: paused.details, pausedWorker, pausedState, pausedMarker }).slice(0, 4000)}`);
    assert.equal(pausedMarker.toolName, "task_outcome", "fixture marker must attest to the exact partial task_outcome call");
    assert.equal(pausedMarker.toolCallId, "fixture-paused-outcome");
    assert.equal(pausedState.data.lastOutcome, undefined, "partial tool call was falsely recorded as an outcome");
    assert.equal(pausedState.data.phase, "running");
    const abortStarted = Date.now();
    const cancelled = await execute(ctx, { operation: "cancel", job_id: paused.details.job_id });
    assert.equal(cancelled.details.group.status, "cancelled", JSON.stringify(cancelled));
    assert.ok(Date.now() - abortStarted < 10_000, "abort/control did not respond promptly to paused stream");
    const pausedFinal = await callTuiWorker(pausedWorker, { operation: "status" });
    assert.equal(pausedFinal.data?.lastOutcome, undefined, "abort fabricated a successful outcome");
    assert.ok(!new TuiWorkerStore(dirname(pausedWorker.sessionFile)).readState().events.some((event: any) => event.kind === "outcome"), "task_outcome ran before model stream completed");
    await execute(ctx, { operation: "reap", job_id: paused.details.job_id });

    const foregroundState = await callTuiWorker(headless, { operation: "status" });
    assert.equal((foregroundState.data as any).active, false);
    assert.ok((foregroundState.data as any).lastReport);
    const service = (globalThis as any)[FOREGROUND_TASKS_KEY];
    const page = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" });
    assert.equal(page.state, "available");
    const headlessTask = page.tasks.find((task: any) => task.taskId === foregroundId)!;
    assert.ok(headlessTask);
    const view = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "view",
      target: { taskId: headlessTask.taskId, childId: headlessTask.childId, workerEpoch: headlessTask.workerEpoch } });
    assert.equal(view.state, "available", JSON.stringify(view));
    assert.ok(view.view.messages.some((message: any) => message.role === "assistant"), JSON.stringify(view));
    const readonlyService = (globalThis as any)[HARNESS_READONLY_KEY]?.subagents;
    assert.ok(readonlyService, "root read-only dashboard service was not installed");
    const groupRecordPath = join(process.env.PI_TUI_WORKER_STATE_ROOT!, "headless-groups", `${foreground.details.job_id}.json`);
    const groupRecordBefore = await readFile(groupRecordPath, "utf8");
    const readonlyPage = await readonlyService.list({ sessionId: ctx.sessionManager.getSessionId(), limit: 50 });
    assert.ok(readonlyPage.items.some((item: any) => item.taskId === foregroundId));
    const readonlyReport = await readonlyService.report({ sessionId: ctx.sessionManager.getSessionId(), taskId: foregroundId });
    assert.equal(readonlyReport.state, "available");
    assert.equal(readonlyReport.item.stale, true);
    assert.doesNotMatch(readonlyReport.item.text, /session\.jsonl|control\.sock/);
    assert.equal(await readFile(groupRecordPath, "utf8"), groupRecordBefore, "read-only Paseo snapshot reconciled/wrote headless state");
    const resultPage1 = await execute(ctx, { operation: "result", job_id: foreground.details.job_id, child: 1, offset: 0, limit: 8 });
    assert.equal(resultPage1.details.offset, 0);
    assert.equal(resultPage1.details.next_offset, 8);
    assert.equal(resultPage1.details.complete, false);
    const resultPage2 = await execute(ctx, { operation: "result", job_id: foreground.details.job_id, child: 1, offset: 8, limit: 8 });
    assert.equal(resultPage2.details.offset, 8);
    assert.ok(resultPage2.content[0].text.length > 0);
    const childOnlyResult = await execute(ctx, { operation: "result", child_id: headlessTask.childId, offset: 0, limit: 8 });
    assert.equal(childOnlyResult.details.child_id, headlessTask.childId);
    await assert.rejects(execute(ctx, { operation: "result", job_id: foreground.details.job_id, child_id: `subagent-child-${"f".repeat(24)}` }), /child_id does not belong/i);
    const promptRequest = { sessionId: service.sessionId, epoch: service.epoch, operation: "prompt",
      target: { taskId: headlessTask.taskId, childId: headlessTask.childId, workerEpoch: headlessTask.workerEpoch },
      requestId: "root-panel-followup", message: "User panel follow-up" };
    const promptReceipt = await service.execute(promptRequest);
    assert.equal(promptReceipt.accepted, true, JSON.stringify(promptReceipt));
    assert.deepEqual(await service.execute(promptRequest), promptReceipt, "replayed parent prompt must be idempotent");
    const followupDeadline = Date.now() + 20_000;
    let followupStatus: any;
    while (Date.now() < followupDeadline) {
      followupStatus = await callTuiWorker(headless, { operation: "status" });
      if (followupStatus.ok && !(followupStatus.data as any).active && (followupStatus.data as any).lastReport !== (foregroundState.data as any).lastReport) break;
      await sleep(100);
    }
    assert.notEqual((followupStatus.data as any).lastReport, (foregroundState.data as any).lastReport, "parent follow-up did not run in retained Pi session");
    const refreshedView = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "view",
      target: { taskId: headlessTask.taskId, childId: headlessTask.childId, workerEpoch: headlessTask.workerEpoch } });
    assert.equal(refreshedView.state, "available");
    assert.ok(refreshedView.view.messages.some((message: any) => message.role === "user" && message.text.includes("Direct user instruction from Paseo")),
      "trusted panel input must be retained with user origin");
    // Model-facing control accepts the same group+child identity pair returned
    // by the harness; bad assertions/launch overrides must not deliver or restart.
    await assert.rejects(execute(ctx, { operation: "prompt", child_id: headlessTask.childId,
      job_id: `subagent-job-${"f".repeat(24)}`, message: "MUST_NOT_DELIVER" }), /does not belong/i);
    await assert.rejects(execute(ctx, { operation: "resume", task_id: foregroundId,
      model: "harness-test/mock:off", background: true, task: "MUST_NOT_RELAUNCH" }), /unsupported fields: model, background, task/);
    const groupedPrompt = await execute(ctx, { operation: "prompt", child_id: headlessTask.childId,
      job_id: foreground.details.job_id, message: "Group-asserted parent follow-up", wait_for_response: true });
    assert.equal(groupedPrompt.details.job_id, foreground.details.job_id);
    assert.equal(groupedPrompt.details.child_id, headlessTask.childId);
    assert.equal((await callTuiWorker(headless, { operation: "status" }) as any).data.pid, (foregroundState.data as any).pid);
    await execute(ctx, { operation: "reap", job_id: foreground.details.job_id });
    const questionnaire = await answerHeadlessInteraction(ctx, "ASK_QUESTIONNAIRE", { kind: "questionnaire", cancelled: false,
      answers: [{ id: "continue", value: "yes", wasCustom: false }] }, "questionnaire");
    assert.equal(questionnaire.details.group.status, "completed");
    await execute(ctx, { operation: "reap", job_id: questionnaire.details.group.job_id });
    if (gate) {
      gate.applyMode(ctx.sessionManager.getSessionId(), true);
      const permission = await answerHeadlessInteraction(ctx, "ASK_GUARDED_PERMISSION", { kind: "permission", cancelled: false, value: "Allow" }, "permission");
      assert.equal(permission.details.group.status, "completed", JSON.stringify(permission));
      const permissionManifest = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId())
        .find(worker => worker.taskId === permission.details.group.children[0].task_id)!;
      assert.match(await readFile(permissionManifest.sessionFile, "utf8"), /guarded-panel-approval/);
      assert.equal((await lstat(process.env.PI_TUI_ROOT_PERMISSION_FILE!)).mode & 0o777, 0o777,
        "the dangerous command must execute only after the structured permission interaction is approved");
      await execute(ctx, { operation: "reap", job_id: permission.details.group.job_id });
      gate.applyMode(ctx.sessionManager.getSessionId(), false);
    }
    assert.deepEqual(await paneSnapshot(), panesBeforeHeadless, "headless foreground launch changed tmux topology");
    const headlessResume = await execute(ctx, { operation: "resume", task_id: foregroundId, message: "Continue the retained headless session." });
    assert.equal(headlessResume.details.group.children[0].task_id, foregroundId);
    assert.equal(headlessResume.details.group.children[0].attempt, 2);
    await execute(ctx, { operation: "reap", job_id: headlessResume.details.job_id });
    const concurrentResume = execute(ctx, { operation: "resume", task_id: foregroundId, message: "One successor attempt only." });
    await sleep(25);
    await assert.rejects(execute(ctx, { operation: "resume", task_id: foregroundId, message: "Duplicate successor attempt." }), /resume is already in progress/i);
    const headlessAttempt3 = await concurrentResume;
    assert.equal(headlessAttempt3.details.group.children[0].attempt, 3);
    await execute(ctx, { operation: "reap", job_id: headlessAttempt3.details.job_id });
    process.env.PI_TUI_TEST_HEADLESS_START_DELAY_MS = "2000";
    const startupStop = tool.execute(`root-test-startup-stop-${Date.now()}`, { task: "STARTUP_STOP_SENTINEL", model: "harness-test/mock:off" }, undefined, undefined, ctx);
    void startupStop.catch(() => undefined);
    let delayedTask: any;
    const delayedDeadline = Date.now() + 10_000;
    while (Date.now() < delayedDeadline) {
      const page = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" });
      delayedTask = page.tasks?.find((task: any) => task.title.includes("STARTUP_STOP_SENTINEL"));
      if (delayedTask?.canStop) break;
      await sleep(50);
    }
    assert.ok(delayedTask?.canStop, "delayed launcher did not expose a safe startup Stop");
    assert.equal(delayedTask.canPrompt, false, "user prompt must remain disabled before initial prompt acceptance");
    const startupStopped = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "stop",
      target: { taskId: delayedTask.taskId, childId: delayedTask.childId, workerEpoch: delayedTask.workerEpoch }, requestId: "stop-before-first-prompt" });
    assert.equal(startupStopped.accepted, true, JSON.stringify(startupStopped));
    delete process.env.PI_TUI_TEST_HEADLESS_START_DELAY_MS;
    const startupResult = await startupStop;
    assert.equal(startupResult.details.group.children[0].status, "cancelled");
    const startupManifest = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId())
      .find(worker => worker.childId === delayedTask.childId)!;
    assert.ok(startupManifest);
    const startupTranscript = await readFile(startupManifest.sessionFile, "utf8");
    assert.doesNotMatch(startupTranscript, /STARTUP_STOP_SENTINEL/, "accepted startup Stop must prevent initial task dispatch");
    const startupState = new TuiWorkerStore(dirname(startupManifest.sessionFile)).readState(false);
    assert.equal(startupState.sealed, true);
    assert.ok(startupState.jobCleanup);
    let orphanFailure: string | undefined;
    const orphanTask = tool.execute(`root-test-owner-loss-${Date.now()}`, { task: "WAIT_FOR_PARENT OWNER_LOSS_HEADLESS", model: "harness-test/mock:off" }, undefined, undefined, ctx);
    void orphanTask.catch(error => { orphanFailure = String(error); });
    let orphanManifest: TuiWorkerManifest | undefined;
    let orphanStatusError: string | undefined;
    const orphanDeadline = Date.now() + 30_000;
    while (Date.now() < orphanDeadline) {
      const tasks = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" });
      const child = tasks.tasks?.find((task: any) => task.title.includes("OWNER_LOSS_HEADLESS"));
      if (child) orphanManifest = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), ctx.sessionManager.getSessionId()).find(worker => worker.childId === child.childId);
      if (orphanManifest) {
        try {
          const status = await callTuiWorker(orphanManifest, { operation: "status" });
          if (status.ok && (status.data as any).active) break;
        } catch (error) { orphanStatusError = String(error); }
      }
      await sleep(100);
    }
    assert.ok(orphanManifest, `could not discover owner-bound headless helper: ${orphanFailure ?? "pending"}`);
    const activeOrphan = await callTuiWorker(orphanManifest, { operation: "status" });
    assert.equal(activeOrphan.ok && (activeOrphan.data as any).active, true, `owner-loss helper was not active before parent termination: ${orphanStatusError ?? JSON.stringify(activeOrphan)}`);
    const orphanTaskDto = (await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "list" })).tasks
      .find((task: any) => task.childId === orphanManifest!.childId)!;
    const orphanTarget = { taskId: orphanTaskDto.taskId, childId: orphanTaskDto.childId, workerEpoch: orphanTaskDto.workerEpoch };
    const queuedBeforeStop = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "prompt",
      target: orphanTarget, requestId: "queued-before-stop", message: "STOP_QUEUE_SENTINEL must not run after Stop" });
    assert.equal(queuedBeforeStop.accepted, true, JSON.stringify(queuedBeforeStop));
    const stopped = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "stop",
      target: orphanTarget, requestId: "stop-without-reap" });
    assert.equal(stopped.accepted, true, JSON.stringify(stopped));
    const orphanStore = new TuiWorkerStore(dirname(orphanManifest.sessionFile));
    assert.equal(orphanStore.readState(false).sealed, false, "human Stop must not implicitly seal/reap");
    assert.equal(await processIdentity(orphanManifest.runtimePid!), orphanManifest.runtimeProcessToken, "human Stop must keep Pi alive");
    const stoppedStatus = await callTuiWorker(orphanManifest, { operation: "status" });
    assert.equal((stoppedStatus.data as any).active, false, "Stop must not return while the Pi run is still active");
    await sleep(8500);
    const afterStopSettled = await callTuiWorker(orphanManifest, { operation: "status" });
    assert.equal((afterStopSettled.data as any).active, false, "cleared queued work restarted after Stop");
    assert.equal((afterStopSettled.data as any).lastReport, (stoppedStatus.data as any).lastReport, "queued pre-Stop instruction ran after cancellation");
    const afterStopView = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "view", target: orphanTarget });
    assert.equal(afterStopView.state, "available", JSON.stringify(afterStopView));
    const resumedUserInput = await service.execute({ sessionId: service.sessionId, epoch: service.epoch, operation: "prompt",
      target: orphanTarget, requestId: "panel-after-stop", message: "WAIT_FOR_PARENT OWNER_LOSS_HEADLESS after Stop" });
    assert.equal(resumedUserInput.accepted, true, JSON.stringify(resumedUserInput));
    const activeAgainDeadline = Date.now() + 10_000;
    while (Date.now() < activeAgainDeadline) {
      const current = await callTuiWorker(orphanManifest, { operation: "status" }).catch(() => undefined);
      if (current?.ok && (current.data as any).active) break;
      await sleep(100);
    }
    assert.ok((await callTuiWorker(orphanManifest, { operation: "status" })).data?.active, "trusted user prompt after Stop must run");
    const started = await execute(ctx, { task: "WAIT_FOR_PARENT", model: "harness-test/mock:off", background: true });
    const deadline = Date.now() + 30_000;
    let group: any;
    while (Date.now() < deadline) {
      group = (await execute(ctx, { operation: "status", job_id: started.details.job_id })).details.group;
      if (group.children[0].runtime && group.children[0].status === "running") break;
      await sleep(100);
    }
    const manifest = manifestFor(group);
    const status = await callTuiWorker(manifest, { operation: "status" });
    assert.ok(status.ok);
    const saved = { rootPid: process.pid, job: started.details.job_id, childPid: (status.data as any).pid, sessionId: ctx.sessionManager.getSessionId(),
      headlessPid: orphanManifest.runtimePid, headlessToken: orphanManifest.runtimeProcessToken, headlessEpoch: orphanManifest.workerEpoch };
    await writeFile(backgroundFile, JSON.stringify(saved));
    return saved;
  });
  register("tui-root-check", async ctx => {
    const saved = JSON.parse(await readFile(backgroundFile, "utf8"));
    assert.equal(saved.sessionId, ctx.sessionManager.getSessionId());
    const ownerLost = discoverTuiWorkers(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers"), saved.sessionId)
      .find(worker => worker.workerEpoch === saved.headlessEpoch);
    assert.ok(ownerLost, "owner-loss headless worker manifest was not retained");
    const ownerLostState = new TuiWorkerStore(dirname(ownerLost.sessionFile)).readState();
    assert.equal(ownerLostState.sealed, true, "owner-loss helper exited without a durable cleanup seal");
    assert.equal(ownerLostState.jobCleanup?.workerEpoch, saved.headlessEpoch);
    let group = (await execute(ctx, { operation: "status", job_id: saved.job })).details.group;
    assert.notEqual(group.children[0].status, "lost");
    const survivor = manifestFor(group);
    assert.equal((await callTuiWorker(survivor, { operation: "status" }) as any).data.pid, saved.childPid);
    await wait(ctx, saved.job);
    // Exercise the actual root tasks merge, not only the native manager DTO.
    // This is an unlaunched terminal inventory row; no nested worker is spawned.
    const nestedId = `subagent-job-${"d".repeat(24)}`;
    const nestedPath = join(process.env.PI_TUI_WORKER_STATE_ROOT!, "groups", `${nestedId}.json`);
    const retained = JSON.parse(await readFile(join(process.env.PI_TUI_WORKER_STATE_ROOT!, "groups", `${saved.job}.json`), "utf8"));
    const childSession = JSON.parse((await readFile(survivor.sessionFile, "utf8")).split("\n")[0]).id;
    atomicPrivateJson(nestedPath, { ...retained, id: nestedId, owner: childSession,
      children: [{ ...retained.children[0], childId: `subagent-child-${"d".repeat(24)}`, taskId: `subagent-task-${"d".repeat(24)}`,
        directory: join(process.env.PI_TUI_WORKER_STATE_ROOT!, "workers", "d".repeat(24)),
        spec: { task: "NESTED_TASK_RENDER_FIXTURE", cwd: ctx.cwd }, state: "cancelled", started: false, reaped: false, report: undefined }] });
    try {
      const tasks = await execute(ctx, { operation: "tasks" });
      assert.ok(tasks.details.descendants.some((nested: any) => nested.job_id === nestedId));
      assert.match(tasks.content[0].text, /Descendant · cancelled · NESTED_TASK_RENDER_FIXTURE/);
      assert.match(tasks.content[0].text, new RegExp(nestedId));
    } finally { await rm(nestedPath); }
    // Resume a still-live idle task preserves the exact Pi process.
    await execute(ctx, { operation: "resume", task_id: group.children[0].task_id, message: "Continue briefly", compact: false });
    assert.equal((await callTuiWorker(survivor, { operation: "status" }) as any).data.pid, saved.childPid);
    await wait(ctx, saved.job);
    await execute(ctx, { operation: "reap", job_id: saved.job });
    // Explicit resume after verified reap opens a new owned attempt from session.
    const resumed = await execute(ctx, { operation: "resume", task_id: group.children[0].task_id, message: "Continue after retained attempt", compact: false });
    const resumedGroup = await wait(ctx, resumed.details.job_id);
    assert.equal(resumedGroup.children[0].task_id, group.children[0].task_id);
    assert.equal(resumedGroup.children[0].attempt, 2);
    assert.notEqual((await callTuiWorker(manifestFor(resumedGroup), { operation: "status" }) as any).data.pid, saved.childPid);
    await execute(ctx, { operation: "reap", job_id: resumed.details.job_id });
    // An explicit compact of this tiny session is a safe no-op. Its subsequent
    // low-context checkpoint resume must continue normally, retaining history
    // without leaving the worker's activity reservation latched.
    const small = await execute(ctx, { task: "CHECKPOINT_SMALL", model: "harness-test/mock:off", background: true });
    const smallGroup = await wait(ctx, small.details.job_id);
    assert.equal(smallGroup.children[0].task_outcome?.state, "checkpointed");
    const smallWorker = manifestFor(smallGroup);
    const smallBefore = (await callTuiWorker(smallWorker, { operation: "status" }) as any).data;
    const smallTranscript = await readFile(smallWorker.sessionFile, "utf8");
    const smallNoOp = await callTuiWorker(smallWorker, { operation: "compact" });
    assert.ok(smallNoOp.ok, JSON.stringify(smallNoOp));
    assert.deepEqual(smallNoOp.data, { compaction: "not-needed", reason: "nothing-to-compact" });
    await execute(ctx, { operation: "resume", task_id: smallGroup.children[0].task_id, message: "Continue after the small checkpoint" });
    const smallResumed = await wait(ctx, small.details.job_id);
    const smallAfter = (await callTuiWorker(smallWorker, { operation: "status" }) as any).data;
    assert.equal(smallAfter.pid, smallBefore.pid);
    assert.equal(smallAfter.active, false);
    assert.notEqual(smallAfter.lastReport, smallBefore.lastReport);
    assert.equal(smallResumed.children[0].task_outcome, undefined);
    const retainedTranscript = await readFile(smallWorker.sessionFile, "utf8");
    assert.ok(retainedTranscript.startsWith(smallTranscript), "small compaction rewrote retained session history");
    assert.match(retainedTranscript, /Continue after the small checkpoint/);
    assert.equal(retainedTranscript.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.type === "compaction"), false, "small-session no-op unexpectedly compacted context");
    await execute(ctx, { operation: "reap", job_id: small.details.job_id });
    // Real root API inventory/waits must cover the legacy manager as well.
    const nativeWait = await execute(ctx, { task: "WAIT_FOR_PARENT mixed waits", model: "harness-test/mock:off", background: true });
    const legacyManager = sharedBackgroundSubagentManager(join(getAgentDir(), "state", "background-subagents-v1"));
    let finishLegacy!: (value: any) => void;
    const legacy = await legacyManager.start({ sessionId: ctx.sessionManager.getSessionId(), backend: "agentsh", mode: "single", summary: "Deterministic legacy wait fixture", children: [{ label: "legacy fixture" }] }, () => new Promise(resolve => { finishLegacy = resolve; }));
    const inventory = await execute(ctx, { operation: "list", limit: 50 });
    assert.ok(inventory.details.legacy_groups?.some((g: any) => g.job_id === legacy.id), JSON.stringify({ inventory, agentDir: getAgentDir(), roots: [...((globalThis as any).__paeBackgroundSubagentManagersV4?.keys() ?? [])] }));
    const anyWait = execute(ctx, { operation: "wait_any", wait_ms: 60_000 });
    await sleep(300); finishLegacy({ text: "legacy completed", failed: false });
    const anyResult = await anyWait;
    assert.equal(anyResult.details.job_id, legacy.id, JSON.stringify({ anyResult, legacy: await legacyManager.get(legacy.id) }));
    assert.equal(anyResult.details.timed_out, false);
    let finishSecond!: (value: any) => void;
    const second = await legacyManager.start({ sessionId: ctx.sessionManager.getSessionId(), backend: "agentsh", mode: "single", summary: "Second legacy fixture", children: [{ label: "second" }] }, () => new Promise(resolve => { finishSecond = resolve; }));
    const allWait = execute(ctx, { operation: "wait_all", wait_ms: 1000 });
    await sleep(300); finishSecond({ text: "second completed", failed: false });
    const mixed = await allWait;
    assert.equal(mixed.details.timed_out, true);
    assert.deepEqual(mixed.details.groups.map((g: any) => g.job_id).sort(), [nativeWait.details.job_id, second.id].sort());
    const complete = await execute(ctx, { operation: "wait_all", wait_ms: 60_000 });
    assert.equal(complete.details.timed_out, false);
    await execute(ctx, { operation: "reap", job_id: nativeWait.details.job_id });
    const gate = (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__;
    gate?.applyMode(ctx.sessionManager.getSessionId(), false);
    const localJobs = await execute(ctx, { task: "RUN_LOCAL_JOB", model: "harness-test/mock:off", background: true });
    const jobsGroup = await wait(ctx, localJobs.details.job_id);
    const jobsWorker = manifestFor(jobsGroup);
    const beforeJobs = (await callTuiWorker(jobsWorker, { operation: "status" }) as any).data;
    const localPid = beforeJobs.pid;
    const listJobs = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "list" } });
    assert.ok(listJobs.ok, JSON.stringify(listJobs));
    const ownedJobs = (listJobs as any).data.details.jobs;
    assert.equal(ownedJobs.length, 1, JSON.stringify(listJobs));
    const job = ownedJobs[0].job_id;
    const output = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "output", job_id: job } });
    assert.match((output as any).data.content[0].text, /child-job-marker/);
    // Parent-local controller must not access a child's job, even by known ID.
    const rootController = (globalThis as any).__paeLocalJobControllerV1;
    await assert.rejects(rootController.execute("foreign-job", { action: "output", job_id: job }), /different|own|session/i);
    await assert.rejects(rootController.execute("no-start", { action: "start", command: "false" }), /existing jobs/);
    assert.equal((await callTuiWorker({ ...jobsWorker, ownerSessionId: "foreign-parent" }, { operation: "jobs", params: { action: "list" } })).ok, false);
    await assert.rejects(execute(ctx, { operation: "reap", job_id: localJobs.details.job_id }), error => {
      assert.match(String(error), new RegExp(job));
      return true;
    });
    assert.equal((await callTuiWorker(jobsWorker, { operation: "status" }) as any).data.pid, localPid,
      "active-job refusal must retain the authenticated child controller");
    assert.ok((await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "cancel", job_id: job } })).ok);
    const jobDone = await callTuiWorker(jobsWorker, { operation: "jobs", params: { action: "wait", job_id: job, timeout_ms: 5000 } }, { timeoutMs: 10_000 });
    assert.equal((jobDone as any).data.details.status, "cancelled");
    const afterJobs = (await callTuiWorker(jobsWorker, { operation: "status" }) as any).data;
    assert.equal(afterJobs.pid, localPid);
    assert.equal(afterJobs.sequence, beforeJobs.sequence, "Job controls must not start a model turn");
    await execute(ctx, { operation: "reap", job_id: localJobs.details.job_id });
    const cleanup = new TuiWorkerStore(dirname(jobsWorker.sessionFile)).readState().jobCleanup;
    assert.ok(cleanup, "parent reap must retain the child-local job cleanup receipt");
    assert.match(await readFile(cleanup.artifact, "utf8"), /child-job-marker/);
    const panes = (await promisify(execFile)("tmux", ["-S", jobsWorker.placement.socketPath, "list-panes", "-a", "-F", "#{pane_id}"])).stdout.split("\n");
    assert.ok(!panes.includes(ownedJobs[0].pane_id), "parent reap left the child-owned job pane orphaned");
    const parallel = await execute(ctx, { tasks: [
      { task: "ASSERT_READ_ONLY", model: "harness-test/mock:off", tools: ["read"] },
      { task: `${gate ? "RUN GUARDED CHECK " : ""}REPORT_OUTCOME`, model: "harness-test/mock:off", acceptance: ["fixture"] },
    ], background: true });
    const parallelGroup = await wait(ctx, parallel.details.job_id);
    assert.equal(parallelGroup.children[0].runtime.placement.windowId, parallelGroup.children[1].runtime.placement.windowId);
    const readOnly = await execute(ctx, { operation: "result", job_id: parallel.details.job_id, child: 1 });
    assert.equal(readOnly.content[0].text, "TOOLS:notify_parent,read,task_outcome");
    assert.equal(parallelGroup.children[1].task_outcome?.state, "delivered");
    if (gate) {
      const guarded = manifestFor(parallelGroup, 1);
      const transcript = await readFile(guarded.sessionFile, "utf8");
      assert.match(transcript, /guard-ok/);
      assert.equal((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled, false);
      gate.applyMode(ctx.sessionManager.getSessionId(), true);
      const deadline = Date.now() + 5000;
      while ((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled !== true && Date.now() < deadline) await sleep(100);
      assert.equal((await callTuiWorker(guarded, { operation: "status" }) as any).data.permissionPromptsEnabled, true);
    }
    // A real direct human turn invalidates the previous model-reported outcome.
    const human = manifestFor(parallelGroup, 1);
    const keys = async (m: any, ...args: string[]) => promisify(execFile)("tmux", ["-S", m.placement.socketPath, "send-keys", "-t", m.placement.paneId, ...args]);
    await keys(human, "-l", "WAIT_FOR_PARENT direct human scope change"); await keys(human, "Enter");
    await sleep(400);
    const direct = (await execute(ctx, { operation: "status", job_id: parallel.details.job_id })).details.group;
    assert.equal(direct.children[1].status, "running");
    assert.equal(direct.children[1].task_outcome, undefined);
    await keys(human, "Escape");
    const stopped = (await execute(ctx, { operation: "wait", job_id: parallel.details.job_id, wait_ms: 60_000 })).details.group;
    assert.equal(stopped.children[1].status, "cancelled");
    await execute(ctx, { operation: "reap", job_id: parallel.details.job_id });
    // Esc on the first chain step must not advance to the next assignment.
    const cancelledChain = await execute(ctx, { chain: [
      { task: "WAIT_FOR_PARENT human Esc", model: "harness-test/mock:off" },
      { task: "Must never start", model: "harness-test/mock:off" },
    ], background: true });
    const waiting = (await execute(ctx, { operation: "status", job_id: cancelledChain.details.job_id })).details.group;
    await sleep(400); await keys(manifestFor(waiting), "Escape");
    const cancelled = (await execute(ctx, { operation: "wait", job_id: cancelledChain.details.job_id, wait_ms: 60_000 })).details.group;
    assert.equal(cancelled.children[0].status, "cancelled");
    assert.equal(cancelled.children[1].status, "skipped");
    assert.equal(cancelled.children[1].runtime, undefined);
    await execute(ctx, { operation: "reap", job_id: cancelledChain.details.job_id });
    const chain = await execute(ctx, { chain: [
      { task: "First chain step", model: "harness-test/mock:off" },
      { task: "Second chain step uses {previous}", model: "harness-test/mock:off" },
    ], background: true });
    const chainGroup = await wait(ctx, chain.details.job_id);
    assert.equal(chainGroup.children[0].runtime.placement.windowId, chainGroup.children[1].runtime.placement.windowId);
    assert.match(await readFile(chainGroup.children[1].runtime.sessionFile, "utf8"), /Second chain step uses Deterministic/);
    await execute(ctx, { operation: "reap", job_id: chain.details.job_id });
    // Default foreground is headless and cannot be promoted into a background TUI group.
    let foregroundJobId: string | undefined;
    const foreground = tool.execute(`root-test-headless-promote-${Date.now()}`, { task: "WAIT_FOR_PARENT foreground", model: "harness-test/mock:off" }, undefined,
      (partial: any) => { foregroundJobId = partial.details?.job_id ?? foregroundJobId; }, ctx);
    const foregroundDeadline = Date.now() + 10_000;
    while (!foregroundJobId && Date.now() < foregroundDeadline) await sleep(50);
    assert.ok(foregroundJobId, "headless foreground did not expose its committed group ID");
    const foregroundTasks = await (globalThis as any)[FOREGROUND_TASKS_KEY].execute({ sessionId: (globalThis as any)[FOREGROUND_TASKS_KEY].sessionId,
      epoch: (globalThis as any)[FOREGROUND_TASKS_KEY].epoch, operation: "list" });
    assert.ok(foregroundTasks.tasks.some((task: any) => task.groupId === foregroundJobId), JSON.stringify({ foregroundJobId, foregroundTasks }));
    await assert.rejects(execute(ctx, { operation: "promote", job_id: foregroundJobId }), /headless foreground workers cannot be promoted/i);
    const stillForeground = await foreground;
    assert.equal(stillForeground.details.group.background, false);
    await execute(ctx, { operation: "reap", job_id: stillForeground.details.job_id });
    const parentSession = await readFile(ctx.sessionManager.getSessionFile()!, "utf8");
    assert.doesNotMatch(parentSession, /tui-subagent-update/);
    const entries = parentSession.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const notifications = entries.filter(entry => entry.type === "custom_message" && entry.customType === "harness-state");
    assert.ok(notifications.length > 0, "background completion must notify the parent");
    assert.ok(notifications.every(entry => Array.isArray(entry.details?.updates)
      && entry.details.updates.length > 0
      && entry.details.updates.every((update: any) => update.kind === "subagent" && update.completion === true)),
      "routine child updates must remain quiet");
    assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "harness-state-receipt"));
    return { rootTool: true, guard: Boolean(gate), survivorPid: saved.childPid, parallel: parallel.details.job_id, chain: chain.details.job_id, resume: resumed.details.job_id };
  });
}
