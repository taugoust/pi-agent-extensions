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
const toolResult = (isError = false) => ({ type: "message", id: "result-entry", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError, content: [{ type: "text", text: "done" }] } });
const textRow = (id: number) => ({ type: "message", id: `text-${id}`, message: { role: "user", content: `message ${id}` } });

test("default transcript page is the newest tail and explicit cursor pages older without overlap", async () => {
  await withSession([toolCall, ...Array.from({ length: 60 }, (_, index) => textRow(index)), toolResult()], async path => {
    const latest = readRetainedConversation(path);
    assert.equal(latest.messages.length, 50);
    assert.equal(latest.messages[0]?.text, "message 11");
    assert.equal(latest.messages.at(-1)?.role, "tool");
    assert.ok(latest.nextCursor && latest.nextCursor > 0, "older page boundary is returned");
    const older = readRetainedConversation(path, latest.nextCursor);
    assert.equal(older.messages[0]?.parts?.[0]?.type, "toolCall");
    const call = older.messages[0]?.parts?.[0];
    assert.equal(call?.type === "toolCall" ? call.status : undefined, "completed", "forward result lookup correlates a result newer than this page");
    assert.equal(call?.type === "toolCall" ? call.result : undefined, "done");
    assert.equal(older.messages.at(-1)?.text, "message 10");
    assert.equal(older.nextCursor, undefined);
  });
});

test("tool results retain structured call identity and error status for compact badge rendering", async () => {
  await withSession([toolCall, toolResult(true)], async path => {
    const page = readRetainedConversation(path);
    assert.equal(page.messages[0]?.parts?.[0]?.type, "toolCall");
    assert.equal(page.messages[0]?.parts?.[0]?.type === "toolCall" ? page.messages[0].parts[0].status : undefined, "failed");
    assert.equal(page.messages[0]?.parts?.[0]?.type === "toolCall" ? page.messages[0].parts[0].result : undefined, "done");
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages[1]?.role, "tool");
    assert.equal(page.messages[1]?.text, "done", "result DTO retains its body; the renderer suppresses paired prose after final page selection");
    assert.equal(page.messages[1]?.toolCallId, "call-1");
  });
});

test("orphaned result remains a structured badge candidate, never inferred as assistant prose", async () => {
  await withSession([toolResult()], async path => {
    const page = readRetainedConversation(path);
    assert.equal(page.messages[0]?.role, "tool");
    assert.equal(page.messages[0]?.toolCallId, "call-1");
    assert.equal(page.messages[0]?.status, "completed");
  });
});

test("large structured tool details remain within the response budget while latest records survive", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: "x".repeat(3000) } }));
  const rows = [{ type: "message", id: "large-assistant", message: { role: "assistant", content: [{ type: "text", text: "p".repeat(8000) }, ...calls] } },
    ...calls.map(call => ({ type: "message", id: `result-${call.id}`, message: { role: "toolResult", toolCallId: call.id, isError: false, content: [{ type: "text", text: "r".repeat(5000) }] } }))];
  await withSession(rows, async path => {
    const page = readRetainedConversation(path);
    assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= 24 * 1024);
    const assistant = page.messages.find(message => message.id.includes("large-assistant"))
      ?? (page.nextCursor === undefined ? undefined : readRetainedConversation(path, page.nextCursor).messages.find(message => message.id.includes("large-assistant")));
    assert.ok(assistant?.parts?.filter(part => part.type === "toolCall").length === 4, "budget-pruned calls remain accessible through older-page navigation");
    assert.ok(assistant?.parts?.every(part => part.type !== "toolCall" || part.status === "completed"));
    assert.equal(page.messages.at(-1)?.id.includes("result-call-3"), true, "newest eligible complete source record remains present");
  });
});

test("serialized page budget includes escaped text, correlated results and array overhead", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({ type: "toolCall", id: `escaped-${index}`, name: "bash", arguments: { command: '"'.repeat(400) } }));
  const assistant = { type: "message", id: "escaped-assistant", message: { role: "assistant", content: [{ type: "text", text: '"'.repeat(8192) }, ...calls] } };
  const results = calls.map(call => ({ type: "message", id: `result-${call.id}`, message: { role: "toolResult", toolCallId: call.id, content: [{ type: "text", text: '"'.repeat(2048) }] } }));
  await withSession([assistant, ...results], async path => {
    const older = readRetainedConversation(path, Buffer.byteLength(JSON.stringify(assistant) + "\n"));
    assert.ok(Buffer.byteLength(JSON.stringify(older.messages)) <= 24 * 1024);
    assert.equal(older.messages.length, 1);
    assert.equal(older.messages[0]?.truncated, true);
    assert.equal(older.messages[0]?.parts?.length, 4);
    assert.ok(older.messages[0]?.parts?.every(part => part.type === "toolCall" && part.status === "completed"));
    assert.equal(readRetainedConversation(path).messages.at(-1)?.toolCallId, "escaped-3");
  });
});

test("budget pruning a call never blanks its retained result on the selected page", async () => {
  const largeCall = { ...toolCall, message: { role: "assistant", content: [{ type: "text", text: '"'.repeat(8192) }, ...toolCall.message.content] } };
  const middle = [1, 2].map(index => ({ type: "message", id: `large-${index}`, message: { role: "user", content: "x".repeat(8192) } }));
  await withSession([largeCall, ...middle, toolResult()], async path => {
    const latest = readRetainedConversation(path);
    assert.ok(Buffer.byteLength(JSON.stringify(latest.messages)) <= 24 * 1024);
    assert.equal(latest.messages.some(message => message.id.includes("call-entry")), false);
    assert.equal(latest.messages.at(-1)?.text, "done");
    assert.equal(latest.messages.at(-1)?.toolCallId, "call-1");
    assert.ok(latest.nextCursor);
    const older = readRetainedConversation(path, latest.nextCursor);
    assert.equal(older.messages[0]?.parts?.[0]?.type === "toolCall" ? older.messages[0].parts[0].result : undefined, "done");
  });
});

test("missing result stays unknown; transcript age or absence never implies completion", async () => {
  await withSession([toolCall], async path => {
    assert.equal(readRetainedConversation(path).messages[0]?.parts?.[0]?.type === "toolCall" ? readRetainedConversation(path).messages[0]?.parts?.[0]?.status : undefined, "unknown");
  });
});
