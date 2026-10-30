import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DelegatedGoalEntry } from "./delegated-goals.ts";
import type { NativeTaskRecord } from "../subagent/resume.ts";

export function goalReviewRoot(owner: string, entry: Readonly<DelegatedGoalEntry>, record: Pick<NativeTaskRecord, "taskId" | "childId" | "attempt" | "ownerSessionId" | "spec">, parentReadAllowed: boolean): string {
  if (!parentReadAllowed || !entry.child || record.ownerSessionId !== owner || record.taskId !== entry.child.taskId || record.childId !== entry.child.childId || record.attempt !== entry.child.attempt || !record.spec.tools?.includes("read") || !isAbsolute(record.spec.cwd)) throw new Error("Goal review attempt or read policy changed");
  return record.spec.cwd;
}

export type GoalReviewReference = {
  id: string; goalId: string; taskId: string; childId: string; attempt: number;
  title: string; role: "source" | "deliverable"; kind: "text" | "image" | "link"; at: number;
  target: string; sha256?: string; bytes?: number; mime?: string;
};
export type GoalReviewPreview = { kind: "text"; text: string } | { kind: "image"; dataUri: string } | { kind: "link"; url: string };
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function https(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
function imageMime(data: Buffer): string | undefined {
  if (!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return undefined;
  if (data.length < 57 || data.readUInt32BE(8) !== 13 || data.subarray(12,16).toString("ascii") !== "IHDR" || data.subarray(-8,-4).toString("ascii") !== "IEND") throw new Error("Invalid PNG review image");
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error("Review image dimensions exceed limits");
  return "image/png";
}
function binding(entry: Readonly<DelegatedGoalEntry>, ref?: GoalReviewReference) {
  if (!entry.child || (ref && (ref.goalId !== entry.id || ref.taskId !== entry.child.taskId || ref.childId !== entry.child.childId || ref.attempt !== entry.child.attempt)))
    throw new Error("Review reference belongs to another goal or attempt");
  return entry.child;
}
export function validateGoalReview(refs: GoalReviewReference[] | undefined, goalId: string): void {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.length > 16) throw new Error("Invalid goal review references");
  const ids = new Set<string>();
  for (const ref of refs) {
    if (!ref || Object.keys(ref).some(key => !["id","goalId","taskId","childId","attempt","title","role","kind","at","target","sha256","bytes","mime"].includes(key))
      || typeof ref.id !== "string" || !/^[a-f0-9-]{36}$/.test(ref.id) || ids.has(ref.id) || ref.goalId !== goalId
      || typeof ref.taskId !== "string" || !ref.taskId || ref.taskId.length > 128 || typeof ref.childId !== "string" || !ref.childId || ref.childId.length > 128
      || !Number.isSafeInteger(ref.attempt) || ref.attempt < 1 || !Number.isSafeInteger(ref.at) || ref.at < 0
      || typeof ref.title !== "string" || !ref.title.trim() || ref.title.length > 160 || !["source","deliverable"].includes(ref.role)
      || typeof ref.target !== "string" || !ref.target || ref.target.length > 4096) throw new Error("Invalid goal review reference");
    ids.add(ref.id);
    if (ref.kind === "link") {
      if (!https(ref.target) || ref.sha256 !== undefined || ref.bytes !== undefined || ref.mime !== undefined) throw new Error("Invalid review link");
    } else if (!["text","image"].includes(ref.kind) || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "") || !Number.isSafeInteger(ref.bytes) || ref.bytes! < 0 || ref.bytes! > MAX_FILE_BYTES
      || (ref.kind === "text" ? ref.mime !== "text/plain" || ref.bytes! > MAX_TEXT_BYTES : ref.mime !== "image/png")) throw new Error("Invalid review file");
  }
}
/** Root comes from the exact retained native task, never a caller-supplied cwd.
 * Read the opened inode, bounded; recheck both path and inode after the read.
 * References freeze the content hash, so a later path replacement cannot silently
 * substitute another file. No HTML/SVG execution, host opener, or network fetch.
 */
async function readFile(root: string, target: string): Promise<Buffer> {
  if (isAbsolute(target) || target.includes("\\") || target.includes("\0") || target.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Use a file path inside the goal workspace");
  const base = await realpath(root), path = resolve(base, target);
  const inside = (candidate: string) => { const rel = relative(base, candidate); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
  const canonical = await realpath(path);
  if (!inside(canonical) || canonical !== path) throw new Error("Review paths cannot traverse symlinks or leave the goal workspace");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Review file is not a regular file within the 256 KiB limit");
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, before.size + 1));
    let size = 0;
    while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    const after = await file.stat(), current = await stat(path);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || await realpath(path) !== canonical)
      throw new Error("Review file changed while reading; register it again");
    return buffer.subarray(0,size);
  } finally { await file.close(); }
}
export async function registerGoalReview(root: string, entry: Readonly<DelegatedGoalEntry>, title: string, target: string, role: "source" | "deliverable"): Promise<GoalReviewReference> {
  const child = binding(entry);
  if (typeof title !== "string" || !title.trim() || title.trim().length > 160 || typeof target !== "string" || !target || target.length > 4096 || !["source","deliverable"].includes(role)) throw new Error("Provide a title and a workspace file or HTTPS link");
  const base = { id: randomUUID(), goalId: entry.id, taskId: child.taskId, childId: child.childId, attempt: child.attempt, title: title.trim(), target, role, at: Date.now() };
  if (https(target)) return { ...base, kind: "link" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new Error("Only HTTPS links and workspace files are supported");
  const data = await readFile(root,target), mime = imageMime(data);
  if (!mime && (data.length > MAX_TEXT_BYTES || data.includes(0) || !Buffer.from(data.toString("utf8"),"utf8").equals(data))) throw new Error("Use a UTF-8 text file up to 32 KiB or a supported image up to 256 KiB");
  return { ...base, kind: mime ? "image" : "text", mime: mime ?? "text/plain", bytes: data.length, sha256: hash(data) };
}
export async function previewGoalReview(root: string, entry: Readonly<DelegatedGoalEntry>, refId: string): Promise<GoalReviewPreview> {
  const ref = entry.review?.find(item => item.id === refId);
  if (!ref) throw new Error("Review reference is unavailable");
  validateGoalReview([ref],entry.id);binding(entry,ref);
  if (ref.kind === "link") return { kind: "link", url: ref.target };
  const data = await readFile(root,ref.target);
  if (data.length !== ref.bytes || hash(data) !== ref.sha256) throw new Error("Review file changed; register it again");
  return ref.kind === "text" ? { kind: "text", text: data.toString("utf8") } : { kind: "image", dataUri: `data:${ref.mime};base64,${data.toString("base64")}` };
}
