// Offline regression: goal PRs with a fake forge-pr. No network or real forge.
// Usage: node tests/goal-prs.mjs <installed pi package directory>
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sdk = resolve(process.argv[2]);
const { createJiti } = await import(pathToFileURL(join(sdk, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(sdk, "dist/index.js"),
  "@earendil-works/pi-ai": join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(sdk, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: join(sdk, "node_modules/typebox/build/index.mjs"),
} });
const { GoalRuntime } = await jiti.import("../workflows/goal/runtime.ts");
const { bindGoalMutations } = await jiti.import("../workflows/goal/mutations.ts");
const { mutateProgress } = await jiti.import("../shared/goal-progress.ts");
const { registerGoalTools } = await jiti.import("../workflows/goal/tools.ts");
const { parsePrRef, applyPrEvent, normalizeGoalPrs } = await jiti.import("../workflows/goal/prs.ts");
const { loadGoalStateFromSession } = await jiti.import("../workflows/goal/persistence.ts");

// A fake forge-pr. `check` prints the verdict in $FAKE_DIR/<number>.json.
// `watch` prints the lines in $FAKE_DIR/<number>.events, then stays alive.
const fakeDir = mkdtempSync(join(tmpdir(), "goal-prs-"));
const fakeBin = join(fakeDir, "forge-pr");
writeFileSync(fakeBin, `#!/bin/sh
cmd=$3; n=$4
case "$cmd" in
  check) cat "${fakeDir}/$n.json" ;;
  watch) echo '{"event":"watching"}'; cat "${fakeDir}/$n.events" 2>/dev/null; exec sleep 600 ;;
esac
`);
chmodSync(fakeBin, 0o755);
process.env.PI_FORGE_PR_BIN = fakeBin;
process.on("exit", () => rmSync(fakeDir, { recursive: true, force: true }));

function forge(number, check, events = []) {
  writeFileSync(join(fakeDir, `${number}.json`), JSON.stringify({ pr: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, branch: `b${number}`, ...check }));
  writeFileSync(join(fakeDir, `${number}.events`), events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
}

function fixture() {
  const entries = [], events = new EventEmitter(), tools = new Map(), messages = [];
  const pi = {
    events: { emit: (...args) => events.emit(...args), on(name, fn) { events.on(name, fn); return () => events.off(name, fn); } },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, on() {},
    getActiveTools: () => ["goal_complete", "goal_wait", "goal_blocked", "update_progress", "goal_pr"],
    sendMessage(...args) { messages.push(args); }, sendUserMessage() {},
  };
  const ctx = { cwd: "/unused", model: { id: "offline" }, hasUI: false, isIdle: () => false, hasPendingMessages: () => false,
    ui: { setStatus() {}, notify() {}, confirm: async () => false },
    sessionManager: { getSessionId: () => "offline", getBranch: () => entries, getEntries: () => entries } };
  const runtime = new GoalRuntime(pi);
  runtime.bindWorkflowSession(ctx.sessionManager);
  bindGoalMutations(pi, ctx, runtime, { child: false, busy: () => false });
  registerGoalTools(pi, runtime);
  const call = (name, args) => tools.get(name).execute(`call-${name}`, args, undefined, undefined, ctx);
  const create = () => mutateProgress(pi, ctx, { action: "create", request_id: "create", objective: "Ship it", steps: [{ text: "Do it", status: "completed" }] });
  return { runtime, ctx, entries, messages, call, create, dispose: () => runtime.prWatchers.stopAll() };
}

test("PR references parse from refs and URLs", () => {
  assert.equal(parsePrRef("github.com/o/r#12").ref, "github.com/o/r#12");
  assert.equal(parsePrRef("https://github.com/o/r/pull/12").ref, "github.com/o/r#12");
  assert.equal(parsePrRef("https://gitlab.com/group/sub/repo/-/merge_requests/7").ref, "gitlab.com/group/sub/repo#7");
  assert.throws(() => parsePrRef("not a pr"), /host\/owner\/repo#number/);
});

test("watch events update stored state and bad stored PRs are dropped", () => {
  const pr = { ref: "github.com/o/r#1", url: "u", state: "open", ci: "pending", checkedAt: 1 };
  assert.equal(applyPrEvent(pr, { event: "merged" }).state, "merged");
  assert.equal(applyPrEvent(pr, { event: "ci-failed" }).ci, "failed");
  assert.equal(applyPrEvent(pr, { event: "comment" }), undefined);
  assert.deepEqual(normalizeGoalPrs([pr, { ref: 1 }]), [pr]);
});

test("goal_pr records a PR on the goal and survives reload", async () => {
  const f = fixture();
  f.create();
  forge(1, { verdict: "pending", state: "open" });
  const result = await f.call("goal_pr", { pr: "github.com/o/r#1" });
  assert.match(result.content[0].text, /Recorded "PR 1"/);
  assert.deepEqual(f.runtime.activeGoal.prs.map(pr => [pr.ref, pr.state, pr.branch]), [["github.com/o/r#1", "open", "b1"]]);
  assert.equal(loadGoalStateFromSession(f.ctx).goal.prs[0].ref, "github.com/o/r#1");
  await f.call("goal_pr", { pr: "https://github.com/o/r/pull/1", remove: true });
  assert.deepEqual(f.runtime.activeGoal.prs, []);
  f.dispose();
});

test("goal_complete waits for every PR to merge with green CI", async () => {
  const f = fixture();
  f.create();
  f.runtime.beginAgentRun(f.runtime.activeGoal.id, "manual");
  forge(2, { verdict: "pending", state: "open" });
  await f.call("goal_pr", { pr: "github.com/o/r#2" });

  forge(2, { verdict: "pending", state: "open", ci: "pending" });
  let result = await f.call("goal_complete", { summary: "Verified the change and its tests" });
  assert.match(result.content[0].text, /not merged with green CI yet: "PR 2" .*: open, CI pending/);
  assert.equal(f.runtime.activeGoal.status, "active");

  forge(2, { verdict: "closed", state: "closed" });
  result = await f.call("goal_complete", { summary: "Verified the change and its tests" });
  assert.match(result.content[0].text, /closed without merging; report the goal blocked/);

  forge(2, { verdict: "ok", state: "merged", ci: "green" });
  result = await f.call("goal_complete", { summary: "Verified the change and its tests" });
  assert.match(result.content[0].text, /^Goal complete:/);
  f.runtime.clearCompletionStatusTimer();
  f.dispose();
});

test("a waiting goal watches its open PRs and wakes on their events", async () => {
  const f = fixture();
  f.create();
  f.runtime.beginAgentRun(f.runtime.activeGoal.id, "manual");
  forge(3, { verdict: "pending", state: "open" }, [{ event: "review", state: "approved", pr: "u" }, { event: "merged", pr: "u" }]);
  await f.call("goal_pr", { pr: "github.com/o/r#3" });
  assert.deepEqual(f.runtime.prWatchers.watching(), [], "no watcher before the goal waits");

  await f.call("goal_wait", { reason: "Waiting for review and merge" });
  assert.deepEqual(f.runtime.prWatchers.watching(), ["github.com/o/r#3"]);
  const prEvents = () => f.messages.filter(([message]) => message.customType === "goal-pr-event");
  for (let i = 0; i < 50 && prEvents().length < 2; i++) await delay(20);
  const texts = prEvents().map(([message]) => message.content);
  assert.match(texts[0], /got a review \(approved\)/);
  assert.match(texts[1], /was merged/);
  assert.ok(prEvents().every(([, options]) => options.triggerTurn));
  assert.equal(f.runtime.activeGoal.prs[0].state, "merged");
  assert.deepEqual(f.runtime.prWatchers.watching(), [], "a merged PR is no longer watched");
  f.dispose();
});

test("watchers stop when the goal stops waiting", async () => {
  const f = fixture();
  f.create();
  f.runtime.beginAgentRun(f.runtime.activeGoal.id, "manual");
  forge(4, { verdict: "pending", state: "open" });
  await f.call("goal_pr", { pr: "github.com/o/r#4" });
  await f.call("goal_wait", { reason: "Waiting for review" });
  assert.deepEqual(f.runtime.prWatchers.watching(), ["github.com/o/r#4"]);
  f.runtime.clearGoalWait(f.ctx, f.runtime.activeGoal.id, { reason: "user_input" });
  assert.deepEqual(f.runtime.prWatchers.watching(), []);
  f.dispose();
});
