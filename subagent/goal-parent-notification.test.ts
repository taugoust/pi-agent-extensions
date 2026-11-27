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
        ? (message) => {
            server.notification({ message, requires_guidance: true });
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

for (const toolName of ["goal_pr", "goal_wait"]) {
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
      const input = { pr: "github.com/org/repo#7", reason: "Waiting for parent review" };
      const details = toolName === "goal_pr" ? { prs: [] } : { status: "waiting" };
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
      assert.ok(update.message.includes("Ready for the parent's review"));
      assert.ok(update.message.includes(toolName === "goal_pr" ? input.pr : input.reason));
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
      toolResult("goal_pr", { pr: "github.com/org/repo#7" }, { prs: [{ ref: "repo#7" }] }),
    );
    const [notification] = notifications(server);
    assert.equal(notification.requires_guidance, true);
    assert.match(notification.message, /github\.com\/org\/repo#7/);
    assert.match(notification.message, /The PR is ready\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted CI waits wake the parent once and carry reason and latest report", async () => {
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
    const wait = toolResult(
      "goal_wait",
      { reason: "Waiting for CI checks" },
      { status: "waiting" },
    );
    onToolResult(wait);
    onToolResult(wait);
    const [notification] = notifications(server);
    assert.equal(notification.requires_guidance, true);
    assert.match(notification.message, /Waiting for CI checks/);
    assert.match(notification.message, /CI is pending/);
    assert.equal(notifications(server).length, 1);
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
    const onToolResult = notifyThroughToolResult(server, []);
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
    assert.equal(notification.requires_guidance, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
