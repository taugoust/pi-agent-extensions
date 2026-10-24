import test from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
const accountStore = await readFile(new URL("../openai-accounts/account-store.ts", import.meta.url), "utf8");

test("legacy native runner receives trusted runtime routing and source agent directory", () => {
  assert.match(source, /runtime: \{ agentDir: string; routingEnvironment: Record<string, string> \}/);
  assert.match(source, /routingEnvironment: sessionRoutingEnvironment\(ctx\)/);
  assert.match(source, /Object\.assign\(env, runtime\.routingEnvironment\)/);
  assert.match(source, /prepareChildAgentDir\(subagentId, runtime\.agentDir\)/);
});

test("routed legacy children use the source config/auth root and retain private task state", () => {
  assert.match(source, /PI_CODING_AGENT_DIR: runtime\.routingEnvironment\.PI_SESSION_ROUTING_FILE \? runtime\.agentDir : childAgentDir/);
  assert.match(source, /PI_CODING_AGENT_SESSION_DIR: childSessionDir/);
  assert.match(source, /taskStore\.sessionPath\(taskRecord\.taskId\)/);
  assert.match(source, /outcomePath = path\.join\(childAgentDir, "task-outcome\.json"\)/);
  assert.match(accountStore, /export const ACCOUNTS_FILE = "pi-accounts\.json"/);
  assert.match(accountStore, /export const LEGACY_CODEX_ACCOUNTS_FILE = "pi-codex-accounts\.json"/);
  assert.match(accountStore, /join\(getAgentDir\(\), ACCOUNTS_FILE\)/);
});

test("guarded routed legacy children load the trusted sibling Accounts extension explicitly", async () => {
  assert.match(source, /nativeHelperEntrypoint\("\.\.\/openai-accounts\/accounts", true\)/);
  assert.match(source, /args\.push\("--no-extensions", "--extension", permissionProxyEntrypoint\)/);
  const accountsEntry = await realpath(new URL("../openai-accounts/accounts.ts", import.meta.url));
  const subagentEntry = await realpath(new URL("./index.ts", import.meta.url));
  assert.equal(path.dirname(accountsEntry), path.join(path.dirname(subagentEntry), "..", "openai-accounts"));
});
