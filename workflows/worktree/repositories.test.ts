import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceRepositories } from "./repositories.ts";

const controller = () => new AbortController();
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Discovery did not respect its deadline")), 1000); })]); }
	finally { clearTimeout(timer!); }
}

test("repository detection is read-only, canonical and does not enumerate inside a repository", async t => {
	const root = await mkdtemp(join(tmpdir(), "repository-probe-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let calls = 0;
	const pi = { async exec(command: string, args: string[], options: any) {
		calls++; assert.equal(command, "git"); assert.deepEqual(args, ["rev-parse", "--show-toplevel"]); assert.ok(options.signal);
		return { code: 0, stdout: root + "\n", stderr: "", killed: false };
	} };
	const result = await workspaceRepositories(pi, root, controller().signal);
	assert.equal(result.active, root); assert.deepEqual(result.roots, [root]); assert.equal(calls, 1);
});

test("shallow container discovery yields, skips ignored/hidden/symlink directories and preserves its depth bound", async t => {
	const root = await mkdtemp(join(tmpdir(), "repository-container-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of ["alpha/.git", "group/beta/.git", "group/deep/gamma/.git", "node_modules/ignored/.git", ".hidden/.git"]) await mkdir(join(root, path), { recursive: true });
	await symlink(join(root, "group"), join(root, "alias"));
	const seen: string[] = [];
	const pi = { async exec(_command: string, _args: string[], options: any) {
		seen.push(options.cwd);
		return options.cwd.endsWith("alpha") || options.cwd.endsWith("beta")
			? { code: 0, stdout: options.cwd + "\n", stderr: "", killed: false }
			: { code: 128, stdout: "", stderr: "fatal: not a git repository", killed: false };
	} };
	let yielded = false; setImmediate(() => { yielded = true; });
	const result = await workspaceRepositories(pi, root, controller().signal);
	assert.equal(yielded, true); assert.deepEqual(result.roots, [join(root, "alpha"), join(root, "group/beta")]);
	assert.equal(seen.some(path => /alias|hidden|node_modules|gamma/.test(path)), false);
});

test("an uncancellable Git probe returns explicitly limited discovery at its deadline", async () => {
	const pi = { exec: () => new Promise<any>(() => {}) };
	const result = await bounded(workspaceRepositories(pi, "/unused", controller().signal, { timeoutMs: 20 }));
	assert.equal(result.limited, true); assert.deepEqual(result.roots, []); assert.match(result.warnings.join(" "), /unavailable|timed out/);
});

test("caller cancellation propagates instead of reporting an empty successful scan", async () => {
	const abort = controller();
	const pi = { exec: () => { abort.abort(new Error("Owner changed")); return new Promise<any>(() => {}); } };
	await assert.rejects(bounded(workspaceRepositories(pi, "/unused", abort.signal)), /Owner changed/);
});
