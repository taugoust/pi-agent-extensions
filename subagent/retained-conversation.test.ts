import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRetainedConversation } from "./retained-conversation.ts";

async function withSession(rows: unknown[], run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "retained-conversation-"));
  try {
    const path = join(directory, "session.jsonl");
    await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    await run(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const toolCall = { type: "message", id: "call-entry", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }] } };
const toolResult = (isError = false) => ({ type: "message", id: "result-entry", message: { role: "toolResult", toolCallId: "call-1", isError, content: [{ type: "text", text: "done" }] } });
const textRow = (id: number) => ({ type: "message", id: `text-${id}`, message: { role: "user", content: `message ${id}` } });

test("retained projection correlates structured result after its call", async () => {
  await withSession([toolCall, toolResult()], async path => {
    const page = readRetainedConversation(path);
    assert.equal(page.messages[0]?.parts?.[0]?.status, "completed");
  });
});

test("retained projection finds a result just beyond its 50-message page boundary", async () => {
  await withSession([toolCall, ...Array.from({ length: 50 }, (_, index) => textRow(index)), toolResult(true)], async path => {
    const page = readRetainedConversation(path);
    assert.equal(page.messages.length, 50);
    assert.equal(page.messages[0]?.parts?.[0]?.status, "failed");
    assert.ok(page.nextCursor, "history pagination remains bounded and available");
  });
});

test("missing result stays unknown; transcript age or absence never implies completion", async () => {
  await withSession([toolCall], async path => {
    assert.equal(readRetainedConversation(path).messages[0]?.parts?.[0]?.status, "unknown");
  });
});
