import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { subagentTmuxName, validateSubagentName, withoutSubagentNames } from "./tui-names.ts";

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
  manager.tmux.resolveCaller = async () => ({ socketPath: "/unused", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1" });
  try {
    for (const form of ["tasks", "chain"]) {
      for (const name of [undefined, "root-label"]) {
        const result = await manager.launch({ background: true, name, [form]: [
          { name: "first-label", task: "First task" }, { name: "second-label", task: "Second {previous}" },
        ] }, "owner", root);
        const group = manager.groups.get(result.details.job_id);
        assert.equal(group.windowName, `agt-${name ?? "first-label"}`);
        assert.deepEqual(group.children.map((c: any) => c.spec.name), ["first-label", "second-label"]);
        group.children[0].state = "completed";
        assert.equal(group.windowName, `agt-${name ?? "first-label"}`);
      }
    }
    const result = await manager.launch({ background: true, task: "Review parser tests" }, "owner", root);
    assert.equal(manager.groups.get(result.details.job_id).windowName, "agt-review-parser-tests");
    await assert.rejects(manager.launch({ background: true, name: "Bad name", task: "Work" }, "owner", root), /Subagent name/);
    await assert.rejects(manager.launch({ background: true, tasks: [{ name: "bad\n", task: "Work" }] }, "owner", root), /Subagent name/);
  } finally {
    if (priorLauncher === undefined) delete process.env.PI_TUI_WORKER_LAUNCHER; else process.env.PI_TUI_WORKER_LAUNCHER = priorLauncher;
    if (priorMode === undefined) delete process.env.PI_TUI_WORKER_LAUNCH_MODE; else process.env.PI_TUI_WORKER_LAUNCH_MODE = priorMode;
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});
