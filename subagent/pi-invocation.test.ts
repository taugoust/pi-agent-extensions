import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedPiInvocation, trustedNixStoreFile } from "./pi-invocation.ts";
const root = "/nix/store/aaaaaaaa-pi/lib/node_modules/pi", node = "/nix/store/bbbbbbbb-node/bin/node";
function trust(cli: string, pkg: unknown = { name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }) {
  return { trustedFile: (file: string) => file === "/proc/self/exe" ? node : [cli, root + "/package.json"].includes(file) ? file : undefined,
    readManifest: () => pkg as any };
}
test("guarded immutable Node Pi uses its exact declared CLI and preserves every argument", () => {
  const cli = root + "/dist/bundle/cli.js", args = ["--no-extensions", "--extension", "accounts.ts", "--mode", "json"];
  assert.deepEqual(guardedPiInvocation(args, undefined, cli, trust(cli)), { command: node, args: [cli, ...args] });
  assert.equal(args[0], "--no-extensions", "caller arguments are not mutated");
});
test("legacy immutable Pi package and Bun interpreter are supported", () => {
  const cli = root + "/dist/cli.js", authority = trust(cli, { name: "@mariozechner/pi-coding-agent", bin: { pi: "dist/cli.js" } });
  const base = authority.trustedFile;
  authority.trustedFile = file => file === "/proc/self/exe" ? "/nix/store/bun/bin/bun" : base(file);
  assert.equal(guardedPiInvocation([], undefined, cli, authority).args[0], cli);
});
test("compiled Pi invocation remains unchanged", () => {
  const args = ["--mode", "json"];
  assert.deepEqual(guardedPiInvocation(args, undefined, undefined, {trustedFile: () => "/nix/store/pi/bin/pi", readManifest: () => {throw Error("unused");}}), {command: "/nix/store/pi/bin/pi", args});
});
test("generic interpreter cannot launch mutable, missing, unrelated, or undeclared scripts", () => {
  for (const script of [undefined, "/tmp/cli.js", root + "/other.js"]) assert.throws(() => guardedPiInvocation([], undefined, script, trust(root + "/dist/bundle/cli.js")), /immutable declared Pi CLI/);
  const cli = root + "/dist/bundle/cli.js";
  for (const pkg of [{name: "unrelated", bin: {pi: "dist/bundle/cli.js"}}, {name: "@earendil-works/pi-coding-agent", bin: {pi: "other.js"}}, {name: "@earendil-works/pi-coding-agent"}])
    assert.throws(() => guardedPiInvocation([], undefined, cli, trust(cli, pkg)), /immutable declared Pi CLI/);
  assert.throws(() => guardedPiInvocation([], undefined, cli, {trustedFile: () => undefined, readManifest: () => ({})}), /immutable Nix-store executable/);
});
test("production authority rejects mutable executables and scripts", () => {
  assert.equal(trustedNixStoreFile(import.meta.filename), undefined);
  assert.throws(() => guardedPiInvocation([], import.meta.filename), /immutable Nix-store executable/);
});
