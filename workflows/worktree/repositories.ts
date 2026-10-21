import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentWorktreePath, GitWorktreeError } from "./git.js";

export function outsideRepository(error: unknown): boolean {
	return (
		error instanceof GitWorktreeError &&
		/not (?:inside )?a git repository|not a work tree|must be run in a work tree/i.test(
			error.message,
		)
	);
}
const ignored = new Set([
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	"result",
	"coverage",
	"__pycache__",
]);

/** Read-only, shallow discovery. Never follows directory symlinks or walks into repositories. */
export async function workspaceRepositories(
	pi: Pick<ExtensionAPI, "exec">,
	cwd: string,
	signal: AbortSignal,
) {
	try {
		const active = await currentWorktreePath(pi, cwd, signal);
		return {
			active,
			roots: [active],
			limited: false,
			warnings: [] as string[],
		};
	} catch (error) {
		if (!outsideRepository(error)) throw error;
	}
	const scan = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const roots: string[] = [],
		warnings: string[] = [];
	const queue = [{ path: cwd, depth: 0 }];
	let inspected = 0,
		entries = 0,
		limited = false;
	while (queue.length) {
		signal.throwIfAborted();
		if (
			scan.aborted ||
			inspected >= 256 ||
			entries >= 4096 ||
			roots.length >= 64
		) {
			limited = true;
			break;
		}
		const directory = queue.shift()!;
		inspected++;
		let children: string[] = [];
		try {
			const handle = await opendir(directory.path);
			for await (const entry of handle) {
				if (++entries > 4096 || scan.aborted) {
					limited = true;
					break;
				}
				if (
					entry.isDirectory() &&
					!entry.isSymbolicLink() &&
					!entry.name.startsWith(".") &&
					!ignored.has(entry.name)
				)
					children.push(entry.name);
			}
		} catch {
			warnings.push(`Cannot read repository container: ${directory.path}`);
			continue;
		}
		children.sort();
		for (const name of children) {
			signal.throwIfAborted();
			if (scan.aborted || roots.length >= 64) {
				limited = true;
				break;
			}
			const path = join(directory.path, name);
			let marker = false;
			try {
				const stat = await lstat(join(path, ".git"));
				marker = stat.isDirectory() || stat.isFile();
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" &&
					(error as NodeJS.ErrnoException).code !== "ENOTDIR"
				)
					warnings.push(`Cannot inspect repository: ${path}`);
			}
			if (marker) {
				try {
					const root = await currentWorktreePath(pi, path, scan);
					if (!roots.includes(root)) roots.push(root);
				} catch {
					signal.throwIfAborted();
					if (scan.aborted) {
						limited = true;
						break;
					}
					warnings.push(`Cannot read Git repository: ${path}`);
				}
			} else if (directory.depth < 1) {
				if (queue.length + inspected < 256)
					queue.push({ path, depth: directory.depth + 1 });
				else limited = true;
			}
		}
	}
	return { active: undefined, roots, limited, warnings };
}
