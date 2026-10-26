import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { subagentTmuxName, validateSubagentName, withoutSubagentNames, canonicalSubagentName, validateSubagentDisplayName, subagentTmuxAlias } from "./tui-names.ts";

test("native labels are bounded ASCII kebab-case, deterministic and presentation-only", () => {
  assert.equal(subagentTmuxName("Review HTTP parser tests"), "agt-review-http-parser-tests");
  assert.equal(subagentTmuxName("ignored task", "parser-tests"), "agt-parser-tests");
  assert.equal(subagentTmuxName("Café / API: Tests!"), "agt-cafe-api-tests");
  for (const task of ["", "中文", "🔥", "---", "x".repeat(100), "Review a b c ".repeat(30), "$(touch /tmp/no); #{pane_id}\n"]) {
    const name = subagentTmuxName(task);
    assert.match(name, /^agt-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(name.length <= 32);
    assert.equal(name, subagentTmuxName(task));
  }
  assert.equal(subagentTmuxName("中文"), "agt-worker");
  assert.equal(subagentTmuxName(""), "agt-worker");
  assert.equal(subagentTmuxName("Review deeply complicated implementation"), "agt-review-deeply-complicated");
  assert.equal(subagentTmuxName("one two three four five"), "agt-one-two-three-four");
  assert.equal(validateSubagentName(undefined), undefined);
  assert.equal(validateSubagentName("a".repeat(28)), "a".repeat(28));
  for (const name of ["", " ", "UPPER", "a_b", "a--b", "-a", "a-", "é", "a".repeat(29), "a\nb", "a\n", "$(id)", 1, null]) {
    assert.throws(() => validateSubagentName(name), /Subagent name/);
  }
});

test("non-native dispatch removes only native names without mutating launch arguments", () => {
  for (const form of ["tasks", "chain"]) {
    const params = { name: "group", [form]: [{ name: "pane", task: "work", model: "test" }], background: true };
    assert.deepEqual(withoutSubagentNames(params), { [form]: [{ task: "work", model: "test" }], background: true });
    assert.equal(params.name, "group");
    assert.equal(params[form][0].name, "pane");
  }
  assert.deepEqual(withoutSubagentNames({ task: "work", name: "label" }), { task: "work" });
});

test("native groups allocate root/first-task names once and retain per-task labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-names-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  const priorLauncher = process.env.PI_TUI_WORKER_LAUNCHER;
  const priorMode = process.env.PI_TUI_WORKER_LAUNCH_MODE;
  process.env.PI_TUI_WORKER_LAUNCHER = "/nix/store/test/bin/pi";
  process.env.PI_TUI_WORKER_LAUNCH_MODE = "none";
  manager.refresh = async () => {}; // Test allocation only; never launch real workers.
  manager.activate("owner");
  manager.tmux.resolveCaller = async () => ({ socketPath: "/unused", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1" });
  try {
    for (const form of ["tasks", "chain"]) {
      for (const name of [undefined, "root-label"]) {
        const result = await manager.launch({ background: true, name, [form]: [
          { name: "first-label", task: "First task" }, { name: "second-label", task: "Second {previous}" },
        ] }, "owner", root);
        const group = manager.groups.get(result.details.job_id);
        assert.match(group.windowName, new RegExp(`^${name ?? "first-label"}(?:-[0-9]+)?$`));
        assert.deepEqual(group.children.map((c: any) => c.spec.name), ["first-label", "second-label"]);
        assert.equal(group.renameWindowWithFirstChild, name === undefined);
        const allocated = group.windowName;
        group.children[0].state = "completed";
        assert.equal(group.windowName, allocated);
      }
    }
    const result = await manager.launch({ background: true, task: "Review parser tests" }, "owner", root);
    assert.equal(manager.groups.get(result.details.job_id).windowName, "review-parser");
    const parallel = await Promise.all([0, 1].map(() => manager.launch({ background: true, tasks: [
      { displayName: "Shared Parser Review", task: "URGENT completely different instructions" },
      { displayName: "Shared Parser Review", task: "other instructions" },
    ] }, "owner", root)));
    const children = parallel.flatMap(result => manager.groups.get(result.details.job_id).children);
    assert.equal(new Set(children.map((child: any) => child.spec.tmuxAlias)).size, 4);
    assert.deepEqual(children.map((child: any) => child.spec.displayName), Array(4).fill("Shared Parser Review"));
    assert.equal(new Set(children.map((child: any) => child.taskId)).size, 4);
    assert.equal(new Set(children.map((child: any) => child.childId)).size, 4);
    assert.ok(children.every((child: any) => child.attempt === 1));
    assert.ok(parallel.every(result => manager.groups.get(result.details.job_id).background === true));
    await assert.rejects(manager.launch({ background: true, displayName: "one two three four five", task: "Work" }, "owner", root), /displayName/);
    await assert.rejects(manager.launch({ background: true, name: "Bad name", task: "Work" }, "owner", root), /Subagent name/);
    await assert.rejects(manager.launch({ background: true, tasks: [{ name: "bad\n", task: "Work" }] }, "owner", root), /Subagent name/);
  } finally {
    if (priorLauncher === undefined) delete process.env.PI_TUI_WORKER_LAUNCHER; else process.env.PI_TUI_WORKER_LAUNCHER = priorLauncher;
    if (priorMode === undefined) delete process.env.PI_TUI_WORKER_LAUNCH_MODE; else process.env.PI_TUI_WORKER_LAUNCH_MODE = priorMode;
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});
