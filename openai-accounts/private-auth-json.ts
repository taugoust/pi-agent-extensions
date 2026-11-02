import { constants, lstatSync, readlinkSync, openSync, fstatSync, readSync, closeSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const reject = (): never => { throw new Error("Unsafe local authentication file"); };
const same = (a: Stats, b: Stats, content = false) =>
	a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
	(!content || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));

/** Read-only proof input, not a credential resolver or refresh path.
 * Mirrors the bridge's managed-file boundary without a cross-repository import.
 * User-owned links and root-owned /nix/store links may lead to a private user
 * file; system directory links are supported. Replacement checks defend against
 * ordinary concurrent rotation, not hostile same-UID code (no Node openat walk).
 */
export function readPrivateAuthJson(dir: string): Record<string, any> {
	let fd: number | undefined;
	try {
		if (!isAbsolute(dir) || !process.getuid || dir.split("/").some(part => part === "." || part === "..")) reject();
		const directoryPath = dir.replace(/\/+$/, "") || "/";
		const uid = process.getuid(), directory = lstatSync(directoryPath);
		if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o022)) reject();
		const snapshots = new Map<string, { stat: Stats; target?: string }>();
		const remember = (path: string, stat: Stats, target?: string) => {
			const prior = snapshots.get(path);
			if (prior && (!same(prior.stat, stat, !stat.isDirectory()) || prior.target !== target)) reject();
			snapshots.set(path, { stat, target });
		};
		let path = "/", links = 0;
		let parts = join(directoryPath, "auth.json").split("/").filter(Boolean);
		remember(directoryPath, directory);
		remember("/", lstatSync("/"));
		while (parts.length) {
			const part = parts.shift()!;
			if (part === ".") continue;
			if (part === "..") { path = dirname(path); continue; }
			const next = join(path, part), stat = lstatSync(next);
			if (stat.isSymbolicLink()) {
				if (++links > 32 || (stat.uid !== uid && !(stat.uid === 0 && (next.startsWith("/nix/store/") || parts.length > 0)))) reject();
				const target = readlinkSync(next);
				if (!parts.length && target.endsWith("/")) reject();
				remember(next, stat, target);
				parts = [...target.split("/").filter(Boolean), ...parts];
				if (isAbsolute(target)) path = "/";
				continue;
			}
			if (parts.length) {
				const stickyRoot = stat.uid === 0 && Boolean(stat.mode & 0o1000);
				if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) && !stickyRoot)) reject();
			}
			remember(next, stat);
			path = next;
		}
		const valid = (stat: Stats) => stat.isFile() && stat.uid === uid && !(stat.mode & 0o077) && stat.size <= 1024 * 1024;
		const final = snapshots.get(path)?.stat;
		if (!final || !valid(final)) reject();
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (!valid(opened) || !same(final, opened, true)) reject();
		const verify = () => {
			for (const [name, previous] of snapshots) {
				const current = lstatSync(name);
				if (!same(previous.stat, current, !current.isDirectory()) ||
					(previous.target !== undefined && readlinkSync(name) !== previous.target)) reject();
			}
			if (!same(opened, fstatSync(fd!), true)) reject();
		};
		verify();
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		let size = 0;
		while (size < buffer.length) {
			const n = readSync(fd, buffer, size, buffer.length - size, size);
			if (!n) break;
			size += n;
		}
		if (size > 1024 * 1024) reject();
		verify();
		const data = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) reject();
		return data;
	} catch {
		return reject();
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
