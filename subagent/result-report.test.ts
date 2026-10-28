import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeResultReport } from "./result-report.ts";
import { extractToolPresentation } from "../shared/tool-presentation.ts";

const options = { reportText: "Worker report prose.", jobId: "subagent-job-" + "a".repeat(24), childId: "subagent-child-" + "b".repeat(24), taskId: "subagent-task-" + "c".repeat(24), attempt: 2, state: "completed" };
const raw = { sessionFile: "/private/session", leafId: "private-leaf", assistant: { role: "assistant", content: [{type: "text", text: options.reportText, textSignature: "private-signature"}], stopReason: "stop" } };

test("normal and diagnostic report prose excludes private envelope, preserves resumed identity", () => {
  assert.equal(nativeResultReport(raw, options), options.reportText);
  const text = nativeResultReport(raw, { ...options, diagnostics: true, retained: true, verification: { status: "unavailable", secret: "hidden" } });
  assert.ok(text.startsWith(options.reportText));
  assert.match(text, /Attempt: 2/); assert.ok(text.includes(`Task: ${options.taskId}`));
  assert.match(text, /retained result may be stale/);
  assert.doesNotMatch(text, /\/private\/session|private-signature|sessionFile|textSignature|leafId|hidden/);
});

test("absent report and errors are prose, arbitrary diagnostic objects are not stringified", () => {
  assert.match(nativeResultReport({ error: "Worker stopped" }, { ...options, reportText: "" }), /^Worker stopped/);
  assert.match(nativeResultReport({}, { ...options, reportText: "" }), /^\(no visible terminal report\)/);
  assert.doesNotMatch(nativeResultReport({ assistant: {stopReason: {raw: "secret"}} }, { ...options, diagnostics: true }), /secret|\[object Object\]/);
});

test("typed result projection preserves human pages and paging details without raw report", () => {
  const text = nativeResultReport(raw, { ...options, diagnostics: true });
  const pages: string[] = [];
  for (let offset = 0; offset < text.length; offset += 40) {
    const page = text.slice(offset, offset + 40); pages.push(page);
    const projected: any = extractToolPresentation("subagent", { content: [{type: "text", text: page}], details: { tui_subagent: true, backend: "native", operation: "result", job_id: options.jobId, child_id: options.childId, offset, next_offset: Math.min(text.length, offset + 40), complete: offset + 40 >= text.length } });
    assert.ok(projected); assert.equal(projected.result.content[0].text, page);
  }
  assert.equal(pages.join(""), text);
});
