import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSubagentResult } from "./subagent-render.ts";
import { extractToolPresentation } from "../shared/tool-presentation.ts";
import { nativeResultReport } from "../subagent/result-report.ts";
import { diagnosticReport } from "../subagent/result-artifact.ts";
import { resultPage } from "../subagent/result-page.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const report = "Worker completed: café 🐈.\nSecond report line.";
const texts = [
  nativeResultReport({sessionFile: "private", assistant: {textSignature: "hidden"}}, {reportText: report, diagnostics: true, jobId: "subagent-job-" + "a".repeat(24), childId: "subagent-child-" + "b".repeat(24), taskId: "subagent-task-" + "c".repeat(24), attempt: 2, state: "completed"}),
  diagnosticReport('Task outcome (model-reported, not independently verified): {"state":"delivered","summary":"Checked","extra":{"sessionFile":"private"}}\nRPC diagnostics: {"rawExit":{"code":0},"trace":[{"raw":"hidden"}]}\n\n' + report),
  nativeResultReport({error: "Worker failed to return a report"}, {reportText: "", diagnostics: true, jobId: "j", childId: "c", taskId: "t", attempt: 1, state: "failed"}),
];

test("stock Pi result renderer displays typed native/legacy reports and diagnostics as prose", () => {
  for (const text of texts) {
    const typed = extractToolPresentation("subagent", {content: [{type: "text", text}], details: {operation: "result", job_id: "subagent-job-" + "a".repeat(24), offset: 0, next_offset: Buffer.byteLength(text), complete: true}})!;
    assert.ok(typed);
    for (const expanded of [false, true]) {
      const visible = renderSubagentResult(typed.result, {expanded}, theme).render(160).map((line: string) => line.trimEnd()).join("\n");
      assert.ok(visible.startsWith(text.split("\n")[0]));
      assert.match(visible, /Diagnostics:/);
      assert.doesNotMatch(visible, /sessionFile|textSignature|\{"|hidden/);
    }
  }
});

test("stock Pi renderer displays bounded Unicode pages without replacement or serialization", () => {
  for (const text of texts) {
    const pages: string[] = []; let offset = 0;
    for (;;) {
      const page = resultPage(text, offset, 17); pages.push(page.text);
      assert.ok(Buffer.byteLength(page.text) <= 17); assert.doesNotMatch(page.text, /\uFFFD/);
      const typed = extractToolPresentation("subagent", {content: [{type: "text", text: page.text}], details: {operation: "result", job_id: "subagent-job-" + "a".repeat(24), offset, next_offset: page.nextOffset, complete: page.complete}})!;
      const visible = renderSubagentResult(typed.result, {}, theme).render(160).map((line: string) => line.trimEnd()).join("\n");
      assert.equal(visible.trimEnd(), page.text.trimEnd());
      if (page.complete) break; offset = page.nextOffset;
    }
    assert.equal(pages.join(""), text);
  }
});
