import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BackgroundSubagentManager } from "./background.ts";
import { answerOnlyReport, diagnosticReport } from "./result-artifact.ts";
import { resultPage } from "./result-page.ts";

const metadata = 'Task outcome (model-reported, not independently verified): {"state":"partial","summary":"Checks pending","remaining":["run tests"],"next_action":"check","assistant":{"textSignature":"secret"}}\nRPC diagnostics: {"rawExit":{"code":1},"trace":[{"sessionFile":"secret"}]}\n\n';

test("legacy manager diagnostic view is human, Unicode-paged, with unchanged private artifact", async t => {
  const root = await mkdtemp(join(tmpdir(), "legacy-report-")); t.after(() => rm(root, {recursive: true, force: true}));
  const id = "subagent-job-" + "a".repeat(24), directory = join(root, "jobs", id);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const source = metadata + "Report: café 🐈 completed.\n".repeat(4), now = new Date().toISOString();
  const procStat = process.platform === "linux" ? await readFile(`/proc/${process.pid}/stat`, "utf8") : "";
  const ownerStartToken = procStat ? procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19] : "fixture";
  await writeFile(join(directory, "state.json"), JSON.stringify({schemaVersion: 2, id, sessionId: "owner", backend: "native", mode: "single", summary: "fixture", createdAt: now, updatedAt: now, ownerPid: process.pid, ownerStartToken, status: "failed", latest: source}), {mode: 0o600});
  const manager = new BackgroundSubagentManager(root); await manager.initialize();
  for (const diagnostics of [false, true]) {
    const full = await manager.readResult(id, undefined, 0, 48 * 1024, diagnostics);
    assert.ok(full.text.startsWith("Report: café 🐈 completed."));
    assert.doesNotMatch(full.text, /sessionFile|textSignature|secret|\{"/);
    if (diagnostics) { assert.match(full.text, /Process exit code: 1/); assert.match(full.text, /Remaining: run tests/); }
    assert.equal(full.sha256, createHash("sha256").update(full.text).digest("hex"));
    let offset = 0; const pages: string[] = [];
    for (;;) {
      const page = await manager.readResult(id, undefined, offset, 17, diagnostics);
      assert.ok(page.bytes <= 17); assert.doesNotMatch(page.text, /\uFFFD/); pages.push(page.text);
      if (page.nextOffset === undefined) break; assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.equal(pages.join(""), full.text);
    const emoji = Buffer.byteLength(full.text.slice(0, full.text.indexOf("🐈")));
    await assert.rejects(manager.readResult(id, undefined, emoji + 1, 17, diagnostics), /boundary/);
  }
  const record = await manager.get(id);
  assert.equal(await readFile(join(directory, "result-1.md"), "utf8"), source);
  assert.ok(record.artifacts?.length);
});

test("metadata-only, errors, and Unicode boundary validation remain prose", () => {
  assert.equal(answerOnlyReport(metadata), "");
  assert.match(diagnosticReport(metadata), /^\(no visible terminal report\)/);
  assert.equal(diagnosticReport("Worker failed: unavailable"), "Worker failed: unavailable");
  assert.equal(answerOnlyReport("{legitimate report prose}"), "{legitimate report prose}");
  const text = "a🐈é";
  assert.equal(resultPage(text, 0, 4).text, "a");
  assert.equal(resultPage(text, 1, 4).text, "🐈");
  assert.throws(() => resultPage(text, 2, 4), /boundary/);
  assert.throws(() => resultPage(text, 1, 3), /complete UTF-8/);
});
