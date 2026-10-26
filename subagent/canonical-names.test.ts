import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalSubagentName, validateSubagentDisplayName, subagentTmuxAlias, withoutSubagentNames, subagentResultPresentation } from "./tui-names.ts";

test("canonical names prefer parent wording, bound fallback and reject invalid names", () => {
  assert.equal(canonicalSubagentName("ignored", "Parser Review", "legacy-label"), "Parser Review");
  assert.equal(canonicalSubagentName("ignored", undefined, "legacy-label"), "legacy label");
  assert.equal(canonicalSubagentName("URGENT: Task: Please review parser tests and full instructions"), "review parser tests and");
  for (const task of ["", "!", "x".repeat(1000), "中文 检查", "a b c d e", "URGENT\nPlease test parser"]) {
    const name = canonicalSubagentName(task);
    assert.ok(name.length <= 80);
    assert.ok(name.split(/\s+/).length <= 4);
    assert.equal(validateSubagentDisplayName(name), name);
  }
  for (const name of ["", " five words are too many ", "one two three four five", "x".repeat(81), "a\nb", "a\u001bb", "a\u202eb", null, 1]) {
    assert.throws(() => validateSubagentDisplayName(name), /displayName/);
  }
  assert.equal(validateSubagentDisplayName("Parser   Review"), "Parser Review");
});

test("tmux aliases contain at most two readable words and collision-only numeric suffixes", () => {
  assert.equal(subagentTmuxAlias("Parser Review Work"), "parser-review");
  assert.equal(subagentTmuxAlias("Café Review"), "cafe-review");
  assert.equal(subagentTmuxAlias("Parser Review", ["parser-review", "parser-review-2"]), "parser-review-3");
  assert.equal(subagentTmuxAlias("中文"), "worker");
  assert.equal(subagentTmuxAlias("Parser Review", ["other"]), "parser-review");
});

test("terminal result headers follow exact child renames without exposing task IDs or changing answers", () => {
  const group = { job_id: "subagent-job-internal", mode: "parallel", children: [
    { child: 1, child_id: "child-one", task_id: "task-one", displayName: "Old Name", task: "Urgent instructions", attempt: 1 },
    { child: 2, child_id: "child-two", task_id: "task-two", displayName: "Other Name", task: "Other work", attempt: 1 },
  ] };
  const body = "subagent-job-internal completed\n1. child-one task_id=task-one completed\nReal answer with task-one as data.\n2. Other Name completed";
  const text = subagentResultPresentation(body, group, child => child.child_id === "child-one" ? "New Canonical Name" : undefined);
  assert.equal(text, "parallel completed\n1. New Canonical Name completed\nReal answer with task-one as data.\n2. Other Name completed");
  assert.equal(subagentResultPresentation("1. Old Name completed", group, () => "Renamed Task"), "1. Renamed Task completed");
  assert.equal(subagentResultPresentation("Worker answer", undefined, () => undefined), "Worker answer");
});

test("bridge-independent dispatch strips both naming fields without mutating nested requests", () => {
  const params = { displayName: "Root Work", name: "root", tasks: [{ displayName: "Parser Review", name: "parser", task: "Work" }] };
  assert.deepEqual(withoutSubagentNames(params), { tasks: [{ task: "Work" }] });
  assert.equal(params.tasks[0].displayName, "Parser Review");
});
