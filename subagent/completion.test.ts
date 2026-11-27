import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { TuiWorkerStore, readPrivateJson } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { installQuietState } from "../shared/quiet-state.ts";

const activityStarts = [
  "prompt",
  "human",
  "result",
  "result-storage-failure",
  "delivered-then-prompt",
  "delivered-then-length",
] as const;

for (const start of activityStarts)
  test(`pending completion is invalidated by ${start} activity across reload, later completion still wakes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-generation-")),
      directory = join(root, "w");
    const store = new TuiWorkerStore(directory, true);
    const m: any = {
      protocol: 1,
      ownerSessionId: "parent",
      taskId: "task",
      runtimeId: "runtime",
      groupId: `subagent-job-${"a".repeat(24)}`,
      childId: `subagent-child-${"b".repeat(24)}`,
      attempt: 1,
      workerEpoch: "c".repeat(32),
      controlToken: "d".repeat(64),
      controlSocket: join(directory, "control.sock"),
      sessionFile: join(directory, "session.jsonl"),
      launchMode: "none",
      presentation: "background",
      placement: {
        socketPath: "/tmp/not-real",
        serverEpoch: "1:2",
        sessionId: "$1",
        windowId: "@1",
        paneId: "%1",
        ownershipNonce: "e".repeat(64),
      },
    };
    store.writeManifest(m);
    const manager: any = new TuiNativeManager(
      root,
      () => "native",
      () => true,
      16,
    );
    let idle = true;
    const worker = new TuiWorkerServer(store, {
      isIdle: () => idle,
      send() {
        idle = false;
      },
      abort() {},
      shutdown() {},
    });
    const child: any = {
      childId: m.childId,
      taskId: m.taskId,
      directory,
      state: "running",
      spec: {
        task: "review",
        ...(start.startsWith("delivered-then-") ? { verification: [{ command: "check" }] } : {}),
      },
      started: true,
      notifiedSequence: 0,
    };
    const group: any = {
      id: m.groupId,
      owner: "parent",
      background: true,
      mode: "single",
      launchMode: "none",
      caller: m.placement,
      children: [child],
    };
    manager.owner = "parent";
    manager.groups.set(group.id, group);
    manager.tmux.inspect = async () => ({ dead: false });
    const entries: any[] = [],
      messages: any[] = [],
      handlers = new Map<string, Function[]>();
    let rejectActivity = false;
    const ctx: any = {
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => `generation-${start}-${process.pid}`,
        getBranch: () => entries,
      },
    };
    const pi: any = {
      on(name: string, fn: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
      appendEntry(customType: string, data: any) {
        if (rejectActivity && data.update?.activity) throw new Error("injected receipt failure");
        entries.push({ type: "custom", customType, data });
      },
      sendMessage(message: any) {
        messages.push(message);
      },
    };
    const quiet = installQuietState(pi, 5);
    manager.notify = (u: any) => quiet.enqueue(ctx, u);
    const emit = async (name: string, event: any = {}) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    };
    try {
      await emit("session_start");
      await emit("ui_prompt_start");
      await worker.start();
      worker.running(true);
      worker.settled({ assistant: { stopReason: "error", content: [] } });
      await manager.refresh("parent");
      const oldSequence = worker.state.sequence;
      assert.ok(entries.some((e) => e.data.state === "queued"));
      const deliveredFirst = start.startsWith("delivered-then-");
      if (deliveredFirst) {
        await emit("ui_prompt_end");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(messages.length, 1);
        const result = await manager.operation(
          { operation: "result", child_id: child.childId },
          "parent",
        );
        const terminalId = result.details.terminal_id;
        assert.equal(
          messages[0].details.updates[0].id,
          `${group.id}:${child.childId}:terminal:${terminalId}`,
        );
      }
      rejectActivity = start === "result-storage-failure";
      if (start === "prompt" || deliveredFirst)
        await manager.operation(
          { operation: "prompt", child_id: child.childId, message: "continue" },
          "parent",
        );
      else {
        idle = false;
        worker.running(true);
        if (start === "human") await manager.refresh("parent");
        else {
          const result = await manager.operation(
            { operation: "result", child_id: child.childId },
            "parent",
          );
          assert.match(result.content[0].text, /not ready/i);
          if (rejectActivity) {
            assert.equal(child.pendingActivitySequence, worker.state.sequence);
            const saved: any = readPrivateJson(join(root, "groups", `${group.id}.json`));
            assert.equal(
              saved.children[0].pendingActivitySequence,
              worker.state.sequence,
              "failed invalidation lacked durable retry obligation",
            );
          }
        }
      }
      if (!start.startsWith("result")) assert.equal(child.state, "running");
      // A delivered first run exercises an idle parent without a reload.
      // Other cases also prove invalidation survives a quiet-state reload.
      if (!deliveredFirst) {
        await emit("session_shutdown", { reason: "reload" });
        await emit("session_start");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const priorMessages = deliveredFirst ? 1 : 0;
      assert.equal(messages.length, priorMessages, "old completion woke after newer activity");
      if (rejectActivity) {
        rejectActivity = false;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.ok(
          entries.some(
            (e) =>
              e.data.update?.activity && e.data.update.through_sequence === worker.state.sequence,
          ),
          "invalidation did not retry after recovery without further worker observations",
        );
        assert.equal(messages.length, 0);
      }
      // Delayed old observations cannot move the high-water mark backwards.
      quiet.enqueue(ctx, {
        kind: "subagent",
        id: "ignored",
        job_id: group.id,
        child_id: child.childId,
        activity: true,
        through_sequence: 0,
      });
      quiet.enqueue(ctx, {
        kind: "subagent",
        id: "late-old",
        job_id: group.id,
        child_id: child.childId,
        completion: true,
        through_sequence: oldSequence,
      });
      idle = true;
      worker.settled({
        assistant: {
          stopReason: start === "delivered-then-length" ? "length" : "stop",
          content: [],
        },
      });
      await manager.refresh("parent");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(messages.length, priorMessages + 1);
      assert.ok(messages.at(-1).details.updates[0].through_sequence > oldSequence);
      if (deliveredFirst) {
        assert.equal(child.state, "waiting");
        assert.equal(child.acceptedDelivery, false);
        await manager.refresh("parent");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(messages.length, 2, "same run notified twice");
      }
    } finally {
      await emit("session_shutdown", { reason: "exit" });
      await worker.close();
      await manager.shutdown(false);
      await rm(root, { recursive: true, force: true });
    }
  });

test("failed activity invalidation survives manager reconstruction and retries for reaped workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-activity-retry-"));
  let manager: any = new TuiNativeManager(
    root,
    () => "native",
    () => true,
    16,
  );
  const child: any = {
    childId: `subagent-child-${"b".repeat(24)}`,
    taskId: `subagent-task-${"c".repeat(24)}`,
    directory: join(root, "workers", "d".repeat(24)),
    operatorCapability: "e".repeat(64),
    attempt: 1,
    state: "completed",
    started: true,
    reaped: true,
    spec: { task: "retained" },
    notifiedSequence: 0,
  };
  const group: any = {
    version: 1,
    id: `subagent-job-${"a".repeat(24)}`,
    owner: "retry-parent",
    background: true,
    children: [child],
  };
  manager.groups.set(group.id, group);
  manager.notify = () => false;
  try {
    manager.notifyActivity(group, child, 7);
    manager.notifyActivity(group, child, 5);
    await manager.shutdown(false);
    manager = new TuiNativeManager(
      root,
      () => "native",
      () => true,
      16,
    );
    manager.refresh = async () => {};
    const retried: number[] = [];
    let accept = false;
    manager.activate("retry-parent", (u: any) => {
      retried.push(u.through_sequence);
      return accept;
    });
    assert.deepEqual(
      retried,
      [7],
      "restart did not synchronously restore highest invalidation before delivery timers",
    );
    const restored = manager.groups.get(group.id),
      restoredChild = restored.children[0];
    assert.equal(restoredChild.pendingActivitySequence, 7);
    accept = true;
    await manager.observe(restored, restoredChild);
    assert.deepEqual(retried, [7, 7], "reaped worker skipped outstanding invalidation");
    const saved: any = readPrivateJson(join(root, "groups", `${group.id}.json`));
    assert.equal(
      saved.children[0].pendingActivitySequence,
      undefined,
      "successful retry did not clear durable obligation",
    );
  } finally {
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});

test("native terminal snapshots: foreground silence, background failures, retry, distinct later turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-completion-"));
  const manager: any = new TuiNativeManager(
    root,
    () => "native",
    () => true,
    16,
  );
  const updates: any[] = [];
  manager.notify = (u: any) => {
    updates.push(u);
    return true;
  };
  const group: any = { id: "group", background: false };
  const child: any = { childId: "child", state: "completed", report: "first-report", attempt: 1 };
  try {
    manager.notifyTerminal(group, child);
    assert.equal(updates.length, 0);
    group.background = true;
    manager.notifyTerminal(group, child);
    assert.equal(updates.length, 0, "promotion replayed already-returned foreground result");
    child.state = "running";
    child.report = undefined;
    manager.notifyTerminal(group, child);
    assert.equal(updates.length, 0);
    child.state = "failed";
    child.report = "second-report";
    manager.notifyTerminal(group, child);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].completion, true);
    manager.notifyTerminal(group, child);
    assert.equal(updates.length, 1);
    const lost: any = { childId: "lost", state: "lost", attempt: 1 };
    manager.notify = () => false;
    manager.notifyTerminal(group, lost);
    assert.equal(lost.terminalNotification, undefined, "failed enqueue advanced durable cursor");
    manager.notify = (u: any) => {
      updates.push(u);
      return true;
    };
    manager.notifyTerminal(group, lost);
    assert.equal(updates.length, 1, "delivery retried before its backoff");
    lost.terminalNotificationRetry.retryAt = 0;
    manager.notifyTerminal(group, lost);
    manager.notifyTerminal(group, lost);
    assert.equal(updates.length, 2);
    assert.equal(updates[1].state, "lost");
    const failed: any = { childId: "launch-failed", state: "failed", attempt: 1 };
    manager.notifyTerminal(group, failed);
    assert.equal(updates.length, 3);
    failed.reaped = true;
    failed.report = "new";
    manager.notifyTerminal(group, failed);
    assert.equal(updates.length, 3);
  } finally {
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["refused", "thrown"])
  test(`terminal delivery ${failure} retries across reload then reports once`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-terminal-retry-"));
    let now = Date.now();
    const startedAt = now;
    t.mock.method(Date, "now", () => now);
    const createManager = (): any =>
      new TuiNativeManager(
        root,
        () => "native",
        () => false,
        16,
      );
    let manager = createManager();
    const child: any = {
      childId: `subagent-child-${"b".repeat(24)}`,
      taskId: `subagent-task-${"c".repeat(24)}`,
      directory: join(root, "workers", "d".repeat(24)),
      operatorCapability: "e".repeat(64),
      attempt: 1,
      state: "completed",
      started: true,
      spec: { task: "review" },
      notifiedSequence: 0,
      terminalNotification: "",
    };
    const group: any = {
      version: 1,
      id: `subagent-job-${"a".repeat(24)}`,
      owner: "retry-parent",
      background: true,
      children: [child],
    };
    let calls = 0;
    const refuse = () => {
      calls++;
      if (failure === "thrown") throw new Error("injected delivery failure");
      return false;
    };
    const reports: string[] = [];
    manager.groups.set(group.id, group);
    manager.notify = refuse;
    try {
      await manager.refresh(group.owner);
      assert.equal(calls, 1);
      await manager.refresh(group.owner);
      assert.equal(calls, 1, "retry ignored backoff");
      await manager.shutdown(false);
      manager = createManager();
      manager.notify = refuse;
      manager.reportTerminalFailure = (message: string) => reports.push(message);
      const restored = manager.groups.get(group.id);
      const restoredChild = restored.children[0];
      assert.equal(restoredChild.terminalNotificationRetry.attempts, 1);
      for (let attempt = 2; attempt <= 5; attempt++) {
        assert.ok(restoredChild.terminalNotificationRetry.retryAt > now);
        now = restoredChild.terminalNotificationRetry.retryAt;
        await manager.refresh(group.owner);
        assert.equal(calls, attempt);
      }
      assert.equal(reports.length, 1);
      assert.ok(now - startedAt <= 120000, "delivery attempts exceeded two minutes");
      assert.equal(restoredChild.terminalNotification, "");
      assert.equal(restoredChild.terminalNotificationFailure.attempts, 5);
      const saved: any = readPrivateJson(join(root, "groups", `${group.id}.json`));
      assert.equal(saved.children[0].terminalNotificationFailure.attempts, 5);
      const status = await manager.operation(
        { operation: "status", job_id: group.id },
        group.owner,
      );
      assert.equal(status.details.group.children[0].terminal_notification_failure.attempts, 5);
      const output = await manager.operation(
        { operation: "output", job_id: group.id },
        group.owner,
      );
      assert.ok(output.content[0].text.includes(restoredChild.terminalNotificationFailure.error));
      await manager.shutdown(false);
      manager = createManager();
      manager.notify = refuse;
      manager.reportTerminalFailure = (message: string) => reports.push(message);
      await manager.refresh(group.owner);
      assert.equal(calls, 5, "exhausted delivery retried after reload");
      assert.equal(reports.length, 1);
      const nextChild = manager.groups.get(group.id).children[0];
      nextChild.runSequence = 20;
      manager.notify = () => {
        calls++;
        return true;
      };
      await manager.refresh(group.owner);
      await manager.refresh(group.owner);
      assert.equal(calls, 6, "new run was suppressed or delivered twice");
      assert.equal(nextChild.terminalNotificationFailure, undefined);
      assert.equal(nextChild.terminalNotificationRetry, undefined);
    } finally {
      await manager.shutdown(false);
      await rm(root, { recursive: true, force: true });
    }
  });
