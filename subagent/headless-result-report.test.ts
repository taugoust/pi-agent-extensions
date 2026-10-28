import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessForegroundManager } from "./headless-foreground.ts";

test("headless retained result uses human diagnostic pages, not private report envelopes", async t => {
  const root = await mkdtemp(join(tmpdir(), "headless-result-")); t.after(() => rm(root, {recursive: true, force: true}));
  const manager: any = new HeadlessForegroundManager(root, () => "native", () => true);
  const report = join(root, "report-2-" + "a".repeat(16) + ".json");
  await writeFile(report, JSON.stringify({sessionFile: "/private/session", leafId: "private", assistant: {role: "assistant", content: [{type: "text", text: "Report café 🐈", textSignature: "private"}]}}), {mode: 0o600});
  const child = {childId: "subagent-child-" + "b".repeat(24), taskId: "subagent-task-" + "c".repeat(24), status: "completed", attempt: 2, directory: root, report, spec: {task: "fixture", cwd: root, displayName: "Fixture"}};
  const group = {id: "subagent-job-" + "d".repeat(24), children: [child], mode: "single", createdAt: "now"};
  for (const diagnostics of [false, true]) {
    const full = manager.result(group, child, {diagnostics, retained: true});
    assert.ok(full.content[0].text.startsWith("Report café 🐈"));
    assert.doesNotMatch(full.content[0].text, /sessionFile|textSignature|leafId|\{"/);
    assert.equal(full.details.task_id, child.taskId); assert.equal(full.details.attempt, 2);
    let offset = 0; const pages: string[] = [];
    for (;;) {
      const page = manager.result(group, child, {diagnostics, retained: true, offset, limit: 17});
      assert.ok(Buffer.byteLength(page.content[0].text) <= 17); assert.doesNotMatch(page.content[0].text, /\uFFFD/); pages.push(page.content[0].text);
      if (page.details.complete) break; offset = page.details.next_offset;
    }
    assert.equal(pages.join(""), full.content[0].text);
  }
  child.report = ""; (child as any).error = "Fixture failed";
  assert.equal(manager.result(group, child).content[0].text, "Worker failed: Fixture failed");
});
