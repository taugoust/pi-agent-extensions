import { opendir, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitWorktreeError } from "./git.ts";
import { withinDiscoveryBudget, yieldDiscovery } from "./discovery-budget.ts";

export function outsideRepository(error: unknown): boolean {
	return error instanceof GitWorktreeError &&
		/not (?:inside )?a git repository|not a work tree|must be run in a work tree/i.test(error.message);
}
const ignored = new Set(["node_modules", "vendor", "dist", "build", "target", "result", "coverage", "__pycache__"]);

/** Read-only, bounded shallow discovery. Never follows directory symlinks or
 * walks into repositories. Expected non-repository probes are data, not thrown
 * Git errors on the background status path. Mutation checks remain separate.
 */
export async function workspaceRepositories(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal: AbortSignal,
	options: { timeoutMs?: number } = {},
) {
	const timeoutMs = Math.max(1, Math.min(2000, options.timeoutMs ?? 2000));
	const scan = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const roots: string[] = [], warnings: string[] = [];
	let inspected = 0, entries = 0, limited = false;
	const finish = () => {
		signal.throwIfAborted();
		if (scan.aborted) limited = true;
		if (limited) warnings.push("Repository discovery is partial or timed out; open a repository directly for a narrower view.");
		return { active: undefined as string | undefined, roots, limited, warnings };
	};
	// null means an ordinary container; undefined means lookup was unavailable.
	async function probe(path: string): Promise<string | null | undefined> {
		try {
			const result = await withinDiscoveryBudget(scan, () => pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, signal: scan, timeout: timeoutMs }));
			if (result.code === 0 && !result.killed && result.stdout.trim()) {
				const absolute = resolve(result.stdout.replace(/\r?\n$/, ""));
				return await withinDiscoveryBudget(scan, () => realpath(absolute)).catch(() => { scan.throwIfAborted(); return absolute; });
			}
			if (!result.killed && /not (?:inside )?a git repository|not a work tree|must be run in a work tree/i.test(result.stderr)) return null;
		} catch { signal.throwIfAborted(); }
		return undefined;
	}
	await yieldDiscovery(signal);
	const active = await probe(cwd);
	if (active) return { active, roots: [active], limited: false, warnings };
	if (active === undefined) {
		limited = true;
		warnings.push("Repository lookup is unavailable.");
		return finish();
	}
	const queue = [{ path: cwd, depth: 0 }];
	while (queue.length) {
		signal.throwIfAborted();
		if (scan.aborted || inspected >= 256 || entries >= 4096 || roots.length >= 64) { limited = true; break; }
		await yieldDiscovery(signal);
		const directory = queue.shift()!;
		inspected++;
		const children: string[] = [];
		try {
			// The iterator closes its handle on break, including budget expiry.
			const handle = await opendir(directory.path);
			for await (const entry of handle) {
				if (++entries > 4096 || scan.aborted) { limited = true; break; }
				if (entries % 32 === 0) await yieldDiscovery(signal);
				if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !ignored.has(entry.name)) children.push(entry.name);
			}
		} catch {
			signal.throwIfAborted();
			warnings.push(`Cannot read repository container: ${directory.path}`);
			continue;
		}
		children.sort();
		for (const name of children) {
			signal.throwIfAborted();
			if (scan.aborted || roots.length >= 64) { limited = true; break; }
			await yieldDiscovery(signal);
			const path = join(directory.path, name);
			let marker = false;
			try {
				const stat = await withinDiscoveryBudget(scan, () => lstat(join(path, ".git")));
				marker = stat.isDirectory() || stat.isFile();
			} catch (error) {
				if (!scan.aborted && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warnings.push(`Cannot inspect repository: ${path}`);
			}
			if (marker) {
				const root = await probe(path);
				if (root && !roots.includes(root)) roots.push(root);
				else if (!root && !scan.aborted) warnings.push(`Cannot read Git repository: ${path}`);
			} else if (directory.depth < 1) {
				if (queue.length + inspected < 256) queue.push({ path, depth: directory.depth + 1 });
				else limited = true;
			}
		}
	}
	return finish();
}
