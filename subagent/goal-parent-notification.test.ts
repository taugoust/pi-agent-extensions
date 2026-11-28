import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { readPrivateJson, TuiWorkerStore } from "./tui-worker-store.ts";
import { registerGoalParentNotifications } from "./goal-parent-notification.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";
import { installQuietState, QUIET_STATE_RECEIPT_CUSTOM_TYPE } from "../shared/quiet-state.ts";

function manifestAt(directory: string): TuiWorkerManifest {
  return {
    protocol: 1,
    ownerSessionId: "parent",
    taskId: "task-1",
    runtimeId: "runtime-1",
    groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`,
    attempt: 1,
    workerEpoch: "c".repeat(32),
    controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"),
    sessionFile: join(directory, "session.jsonl"),
    placement: {
      socketPath: "/tmp/tmux-test",
      serverEpoch: "123:456",
      sessionId: "$1",
      windowId: "@1",
      paneId: "%1",
      ownershipNonce: "e".repeat(64),
    },
    presentation: "background",
    launchMode: "none",
  };
}

function textMessage(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

function notifyThroughToolResult(
  server: TuiWorkerServer,
  branch: unknown[],
  enabled = true,
): (event: ToolResultEvent) => void {
  let handler: ((event: ToolResultEvent) => void) | undefined;
  registerGoalParentNotifications(
    (callback) => {
      handler = callback;
      return () => {
        handler = undefined;
      };
    },
    () =>
      enabled
        ? (message, states) => {
            server.notification({ message, requires_guidance: false, wake_parent: true }, states);
            return true;
          }
        : undefined,
    () => branch,
  );
  return (event) => handler?.(event);
}

function notifications(server: TuiWorkerServer) {
  return server.state.events
    .filter((event) => event.kind === "notification")
    .map((event) => readPrivateJson((event.data as any).artifact) as any);
}

function toolResult(
  toolName: string,
  input: Record<string, unknown>,
  details: unknown,
  isError = false,
): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName,
    input,
    content: [],
    isError,
    details,
  } as ToolResultEvent;
}

function parentDelivery(t: any, sessionId: string) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1800000000000 });
  const entries: any[] = [];
  const messages: any[] = [];
  const handlers = new Map<string, Function[]>();
  const ctx: any = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: { setStatus() {}, notify() {} },
  };
  const pi: any = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
      entries.push({ type: "message", message: { role: "custom", ...message } });
    },
  };
  const quiet = installQuietState(pi, 5);
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown", { reason: "exit" });
    t.mock.timers.reset();
  });
  return { quiet, ctx, entries, messages, emit };
}

for (const toolName of ["goal_pr", "goal_wait", "notify_parent"]) {
  test(`${toolName} notification is delivered to the parent and starts a turn`, async (t) => {
    const parent = parentDelivery(t, `goal-notification-${toolName}`);
    const directory = await mkdtemp(join(tmpdir(), "goal-parent-delivery-"));
    try {
      await parent.emit("session_start");
      const store = new TuiWorkerStore(directory);
      store.writeManifest(manifestAt(directory));
      const server = new TuiWorkerServer(store, {
        isIdle: () => true,
        send() {},
        abort() {},
        shutdown() {},
      });
      const onToolResult = notifyThroughToolResult(server, [
        textMessage("assistant", "Ready for the parent's review"),
      ]);
      const input: Record<string, any> =
        toolName === "notify_parent"
          ? { message: "Explicit coordinator report", requires_guidance: false }
          : { pr: "github.com/org/repo#7", reason: "Waiting for parent review" };
      const details =
        toolName === "goal_pr"
          ? { prs: [{ ref: input.pr }] }
          : toolName === "goal_wait"
            ? { status: "waiting" }
            : {};
      onToolResult(toolResult(toolName, input, details));
      for (const [index, notification] of notifications(server).entries()) {
        parent.quiet.enqueue(parent.ctx, {
          kind: "notification",
          id: `child-notification-${index}`,
          child_id: store.readManifest().childId,
          ...notification,
        });
      }
      t.mock.timers.tick(5);
      for (let i = 0; i < 16; i++) await Promise.resolve();
      assert.equal(parent.messages.length, 1);
      assert.equal(parent.messages[0].options.triggerTurn, true);
      const [update] = parent.messages[0].message.details.updates;
      const expectedReport =
        toolName === "notify_parent" ? input.message : "Ready for the parent's review";
      assert.ok(update.message.includes(expectedReport));
      if (toolName === "goal_pr") assert.ok(update.message.includes(input.pr));
      if (toolName === "notify_parent") assert.ok(update.message.includes(input.message));
      assert.ok(
        parent.entries.some(
          (entry) =>
            entry.customType === QUIET_STATE_RECEIPT_CUSTOM_TYPE &&
            entry.data.state === "delivered",
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("tool-result hook stores waking PR notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-notification-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const branch = [
      textMessage("assistant", [{ type: "text", text: "The PR is ready." }]),
      textMessage("assistant", [{ type: "toolCall", text: "" }]),
      textMessage("toolResult", [{ type: "text", text: "not the report" }]),
    ];
    const onToolResult = notifyThroughToolResult(server, branch);
    onToolResult(
      toolResult(
        "goal_pr",
        { pr: "https://github.com/org/repo/pull/7" },
        {
          prs: [{ ref: "github.com/org/repo#7" }],
        },
      ),
    );
    const [notification] = notifications(server);
    assert.equal(notification.requires_guidance, false);
    assert.equal(notification.wake_parent, true);
    assert.match(notification.message, /github\.com\/org\/repo#7/);
    assert.match(notification.message, /The PR is ready\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic progress deduplication survives a worker-server reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-reload-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const adapter = {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    };
    const first = new TuiWorkerServer(store, adapter);
    const branch = [textMessage("assistant", "PR is ready.")];
    const pr = toolResult(
      "goal_pr",
      { pr: "github.com/org/repo#7" },
      {
        prs: [{ ref: "github.com/org/repo#7" }],
      },
    );
    notifyThroughToolResult(first, branch)(pr);
    const restarted = new TuiWorkerServer(new TuiWorkerStore(directory), adapter);
    notifyThroughToolResult(restarted, branch)(pr);
    assert.equal(notifications(restarted).length, 1);
    assert.equal(Object.keys(restarted.state.notificationStates ?? {}).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted waits wake once for a changed report, not a reworded reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-wait-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const branch = [
      textMessage("assistant", "The implementation is complete; CI is pending."),
      textMessage("assistant", [{ type: "toolCall", text: "" }]),
    ];
    const onToolResult = notifyThroughToolResult(server, branch);
    const wait = (reason: string) => toolResult("goal_wait", { reason }, { status: "waiting" });
    onToolResult(wait("Waiting for CI checks"));
    onToolResult(wait("Still waiting on CI"));
    assert.equal(notifications(server).length, 1);
    assert.equal(notifications(server)[0].requires_guidance, false);
    assert.equal(notifications(server)[0].wake_parent, true);
    assert.match(notifications(server)[0].message, /CI is pending/);
    branch[0] = textMessage("assistant", "CI passed; moving to review.");
    onToolResult(wait("Waiting for review"));
    assert.equal(notifications(server).length, 2);
    branch[0] = textMessage("assistant", "The implementation is complete; CI is pending.");
    onToolResult(wait("Waiting for review again"));
    assert.equal(notifications(server).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task text and status changes create distinct automatic progress notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-tasks-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const branch: unknown[] = [];
    const onToolResult = notifyThroughToolResult(server, branch);
    const update = (text: string, status: string) =>
      toolResult("update_progress", {}, { steps: [{ id: "task-1", text, status }] });
    onToolResult(update("Implement routing", "in_progress"));
    assert.match(notifications(server)[0].message, /Implement routing \(in_progress\)/);
    onToolResult(update("Implement routing", "in_progress"));
    onToolResult(
      toolResult(
        "goal_manage",
        { action: "update" },
        {
          goal: { tasks: [{ id: "task-1", text: "Implement routing", status: "in_progress" }] },
        },
      ),
    );
    onToolResult(
      toolResult(
        "goal_manage",
        { action: "status" },
        {
          goal: { tasks: [{ id: "task-1", text: "Changed by inspection", status: "completed" }] },
        },
      ),
    );
    onToolResult(update("Implement the routing chain", "in_progress"));
    onToolResult(update("Implement the routing chain", "completed"));
    assert.equal(notifications(server).length, 3);
    assert.ok(notifications(server).every((item) => item.wake_parent));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routine explicit reports wake once, while real guidance stays separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-explicit-report-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const branch = [textMessage("assistant", "Older assistant summary.")];
    const onToolResult = notifyThroughToolResult(server, branch);
    const report = (message: string, requires_guidance = false) =>
      toolResult("notify_parent", { message, requires_guidance }, {});
    onToolResult(report("Checklist is now verified."));
    branch.push(
      textMessage("assistant", [
        {
          type: "toolCall",
          id: "report-call",
          name: "notify_parent",
          arguments: { message: "Checklist is now verified.", requires_guidance: false },
        },
      ]),
    );
    branch.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "notify_parent",
        toolCallId: "report-call",
        isError: false,
      },
    });
    onToolResult(report("Checklist is now verified."));
    onToolResult(report("Checklist is now verified.", true));
    onToolResult(toolResult("goal_wait", { reason: "Waiting for review" }, { status: "waiting" }));
    assert.equal(notifications(server).length, 1);
    assert.equal(notifications(server)[0].wake_parent, true);
    assert.equal(notifications(server)[0].requires_guidance, false);
    assert.match(notifications(server)[0].message, /Checklist is now verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected waits, PR removal, and tool errors do not notify", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-rejected-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const branch = [textMessage("assistant", "This rejected wait must stay quiet.")];
    const onToolResult = notifyThroughToolResult(server, branch);
    onToolResult(toolResult("goal_wait", { reason: "Waiting for CI" }, { status: "active" }));
    onToolResult(toolResult("goal_wait", { reason: "Waiting for CI" }, {}, true));
    onToolResult(toolResult("goal_pr", { pr: "org/repo#7", remove: true }, { prs: [] }));
    assert.equal(notifications(server).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary sessions without a parent notifier remain quiet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-ordinary-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const onToolResult = notifyThroughToolResult(server, [], false);
    onToolResult(toolResult("goal_wait", { reason: "Waiting for user" }, { status: "waiting" }));
    assert.equal(notifications(server).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("short actions preserve reports up to the full remaining notification budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-full-report-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const report = "R".repeat(700);
    const branch = [
      textMessage("assistant", report),
      textMessage("assistant", [{ type: "toolCall", text: "" }]),
    ];
    const onToolResult = notifyThroughToolResult(server, branch);
    onToolResult(toolResult("goal_wait", { reason: "Waiting for CI" }, { status: "waiting" }));
    const [notification] = notifications(server);
    assert.ok(Buffer.byteLength(notification.message) <= 1000);
    assert.ok(notification.message.includes(report));
    assert.equal(notification.message.includes("truncated"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports skip empty assistant turns and fit byte limits with Unicode heads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-parent-long-report-"));
  try {
    const store = new TuiWorkerStore(directory);
    store.writeManifest(manifestAt(directory));
    const server = new TuiWorkerServer(store, {
      isIdle: () => true,
      send() {},
      abort() {},
      shutdown() {},
    });
    const report = `Useful opening 🧪 ${"details ".repeat(300)}`;
    const branch = [
      textMessage("assistant", `Earlier summary: ${report}`),
      textMessage("assistant", [{ type: "toolCall", text: "" }]),
    ];
    const onToolResult = notifyThroughToolResult(server, branch);
    onToolResult(
      toolResult("goal_wait", { reason: `CI ${"長い理由 ".repeat(120)}` }, { status: "waiting" }),
    );
    const [notification] = notifications(server);
    assert.ok(Buffer.byteLength(notification.message) <= 1000);
    assert.match(notification.message, /Useful opening 🧪/);
    assert.match(notification.message, /truncated/);
    assert.equal(notification.requires_guidance, false);
    assert.equal(notification.wake_parent, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
