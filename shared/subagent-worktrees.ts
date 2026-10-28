import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { addWorktree, currentWorktreePath, defaultWorktreePath, listWorktrees, pathEntryExists, resolveCommit, unresolvableSymlinkAncestor, validateBranch } from "../workflows/worktree/git.ts";
import { canonicalSubagentName, validateSubagentDisplayName } from "../subagent/tui-names.ts";
import { loadWorktreeSettings } from "../workflows/worktree/settings.ts";

export type WorktreeOption = { changes?: "include" | "exclude"; base?: string };
import { validateWorktreeCompletion, type WorktreeCompletion } from "./worktree-completion.ts";
export type OwnedWorktree = { completion?: WorktreeCompletion; retain?: boolean; version: 1; ownerSessionId: string; taskId: string; childId: string; title: string; canonicalDisplayName?: string; repo: string; commonDir: string;
  path: string; cwd: string; branch: string; baseCommit: string; includedChanges: boolean; createdAt: string;
  released: boolean; state: "preparing" | "ready" | "failed"; physicalIdentity?: { dev: string; ino: string; birthtimeMs: string }; error?: string };
const registry = () => join(getAgentDir(), "state", "subagent-worktrees-v1");
const recordFile = (owner: string, task: string) => join(registry(), `${createHash("sha256").update(`${owner}\0${task}`).digest("hex")}.json`);
export function worktreeOption(value: unknown): WorktreeOption | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worktree must be an object with optional changes and base");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["changes", "base"].includes(key)) || (v.changes !== undefined && !["include", "exclude"].includes(String(v.changes)))
    || (v.base !== undefined && (typeof v.base !== "string" || !v.base.trim() || v.base.length > 512 || v.base.includes("\0")))) throw new Error("Invalid worktree options");
  return v as WorktreeOption;
}
export async function worktreeGit(args: string[], cwd: string, signal?: AbortSignal, input?: Buffer): Promise<string> {
  const result = await gitClient(input).exec("git", args, { cwd, signal, timeout: 60_000 });
  if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}
function gitClient(input?: Buffer) {
  return { exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<any> {
    if (command !== "git") return Promise.reject(new Error("Only Git is allowed"));
    return new Promise((resolveResult, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
      for (const key of Object.keys(env)) if (key.startsWith("GIT_CONFIG") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"].includes(key)) delete env[key];
      const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0, killed = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (killed) return; killed = true;
        try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch {}
        force = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 1000);
        force.unref();
      };
      const timer = setTimeout(stop, options.timeout ?? 15_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      child.stdout.on("data", b => { bytes += b.length; if (bytes > 32 * 1024 * 1024) stop(); else out.push(b); });
      child.stderr.on("data", b => { bytes += b.length; if (bytes > 32 * 1024 * 1024) stop(); else err.push(b); });
      const cleanup = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener("abort", stop); };
      child.once("error", error => { cleanup(); reject(error); });
      child.once("close", code => {
        cleanup();
        try { resolveResult({ code: code ?? 1, stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(out)), stderr: Buffer.concat(err).toString("utf8"), killed }); }
        catch { reject(new Error("Git output contains unsupported non-UTF-8 data; no lossy snapshot is allowed")); }
      });
      child.stdin.on("error", () => undefined); child.stdin.end(input);
    });
  } };
}
export async function saveOwnedWorktree(record: OwnedWorktree) {
  if (record.completion) validateWorktreeCompletion(record.completion, record.ownerSessionId, record.taskId);
  const document = JSON.stringify(record);
  if (Buffer.byteLength(document) > 16384) throw new Error("Worktree ownership record exceeds the safe inventory limit");
  await fs.mkdir(registry(), { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(registry());
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("Worktree ownership registry unavailable");
  const file = recordFile(record.ownerSessionId, record.taskId), temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(document); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(registry(), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function ownedWorktrees(owner?: string): Promise<OwnedWorktree[]> {
  let files: string[];
  try { files = await fs.readdir(registry()); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  const records: OwnedWorktree[] = [];
  const names = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  if (names.length > 1000) throw new Error("Worktree ownership inventory exceeds its supported limit; cleanup requires operator review");
  for (const file of names) {
    const path = join(registry(), file), stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("Invalid worktree ownership record");
    const record = JSON.parse(await fs.readFile(path, "utf8")) as OwnedWorktree;
    if (record.version !== 1 || !/^subagent-task-[a-f0-9]{24}$/.test(record.taskId) || typeof record.ownerSessionId !== "string"
      || !/^subagent-child-[a-f0-9]{24}$/.test(record.childId) || typeof record.released !== "boolean"
      || ![record.path, record.repo, record.cwd, record.commonDir].every(p => typeof p === "string" && isAbsolute(p))
      || recordFile(record.ownerSessionId, record.taskId) !== path) throw new Error("Invalid worktree ownership identity");
    if (record.completion) validateWorktreeCompletion(record.completion, record.ownerSessionId, record.taskId);
    if (record.retain !== undefined && typeof record.retain !== "boolean") throw new Error("Invalid worktree retention marker");
    if (!owner || record.ownerSessionId === owner) records.push(record);
  }
  return records;
}
/** Never recover a canonical name from historical title/task instruction text. */
export function recordedWorktreeName(spec: { displayName?: string; name?: string }): string | undefined {
  return spec.displayName !== undefined || spec.name !== undefined
    ? canonicalSubagentName("", spec.displayName, spec.name) : undefined;
}

/** Presentation of one recorded owner only; callers must first verify physical identity. */
export function recordedWorktreeOwner(record: OwnedWorktree) {
  let canonicalDisplayName: string | undefined;
  try { canonicalDisplayName = validateSubagentDisplayName(record.canonicalDisplayName); } catch {}
  return { ownerSessionId: record.ownerSessionId, taskId: record.taskId, childId: record.childId,
    ...(canonicalDisplayName ? { canonicalDisplayName } : {}) };
}
const save = saveOwnedWorktree;
const queues: Map<string, Promise<unknown>> = (globalThis as any).__piWorktreeRegistryWritesV1 ??= new Map();
export async function serialized<T>(owner: string, taskId: string, action: () => Promise<T>): Promise<T> {
  const key = recordFile(owner, taskId), previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(registry(), { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(registry());
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("Worktree ownership registry unavailable");
    // Never steal a stale lock: interruption requires explicit operator review.
    const lock = `${key}.lock`;
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error: any) { if (error.code === "EEXIST") throw new Error("Worktree ownership mutation is locked; wait or review interrupted operation"); throw error; }
    try { return await action(); } finally { await fs.rmdir(lock); }
  }); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export async function releaseWorktree(owner: string, taskId: string, childId: string) {
  await serialized(owner, taskId, async () => {
    const record = (await ownedWorktrees(owner)).find(row => row.taskId === taskId);
    if (record && record.childId === childId && !record.released) await save({ ...record, released: true });
  });
}
async function capture(repo: string, signal?: AbortSignal) {
  const status = await worktreeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], repo, signal);
  const staged = await worktreeGit(["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--"], repo, signal);
  const unstaged = await worktreeGit(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--"], repo, signal);
  const paths = (await worktreeGit(["ls-files", "--others", "--exclude-standard", "-z"], repo, signal)).split("\0").filter(Boolean).sort();
  const files: { path: string; bytes?: Buffer; link?: string; mode: number }[] = [];
  let size = Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
  for (const path of paths) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.split(/[\\/]/).includes(".git")) throw new Error("Unsafe untracked path");
    const source = join(repo, path), stat = await fs.lstat(source);
    if (!within(repo, await fs.realpath(dirname(source)))) throw new Error("Untracked source escapes the repository");
    if (stat.isSymbolicLink()) files.push({ path, link: await fs.readlink(source), mode: stat.mode & 0o777 });
    else {
      if (!stat.isFile() || stat.size + size > 32 * 1024 * 1024) throw new Error("Untracked files exceed the snapshot limit or contain a nested repository/special file");
      const parent = await fs.realpath(dirname(source));
      if (parent !== repo && !parent.startsWith(repo + sep)) throw new Error("Untracked source escapes the repository");
      const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.size + size > 32 * 1024 * 1024) throw new Error("Untracked source changed");
        bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("Untracked source changed"); offset += read.bytesRead; }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Untracked source changed");
      } finally { await handle.close(); }
      size += bytes.length;
      files.push({ path, bytes, mode: stat.mode & 0o777 });
    }
  }
  if (size > 32 * 1024 * 1024) throw new Error("Working changes exceed the snapshot limit");
  const digest = createHash("sha256").update(status).update(staged).update(unstaged);
  for (const file of files) digest.update(file.path).update(String(file.mode)).update(file.link ?? file.bytes!);
  return { status, staged, unstaged, files, digest: digest.digest("hex") };
}
type Child = { taskId: string; childId: string; spec: { task: string; name?: string; displayName?: string; cwd?: string; systemPrompt?: string; worktree?: WorktreeOption; worktreeInfo?: { path: string; branch: string; baseCommit: string; includedChanges: boolean } } };
function within(root: string, path: string) {
  const part = relative(root, path);
  return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
function attachContext(child: Child, record: OwnedWorktree) {
  const note = `[Isolated worktree]\nWork in ${record.path} on branch ${record.branch}. The source checkout ${record.repo} is separate and must remain unchanged. Treat paths referring to that checkout as references; make your edits in this worktree. Retain the worktree and branch for parent review; do not merge or remove them automatically.`;
  if (!child.spec.systemPrompt?.includes(note)) child.spec.systemPrompt = [child.spec.systemPrompt, note].filter(Boolean).join("\n\n");
}
/** Preflight every requested tree before creating any; never mutate the parent's index or checkout. */
export async function provisionWorktrees(children: Child[], owner: string, signal: AbortSignal | undefined, current: () => boolean, resume = false) {
  const requested = children.filter(child => child.spec.worktree !== undefined);
  if (!requested.length) return;
  if (resume) {
    for (const child of requested) await serialized(owner, child.taskId, async () => {
      const record = (await ownedWorktrees(owner)).find(row => row.taskId === child.taskId);
      if (record?.completion) throw new Error("Completed worktree cannot be resumed; retained completion must be reviewed by its owner");
      if (!record || record.state !== "ready" || record.cwd !== child.spec.cwd) throw new Error("Retained worktree identity is unavailable");
      if (!within(record.path, await fs.realpath(record.cwd)) || (await worktreeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], record.path, signal)).trim() !== record.commonDir) throw new Error("Retained worktree directory identity changed");
      const list = await listWorktrees(gitClient(), record.commonDir, signal);
      if (!list.some(row => row.path === record.path && row.branch === record.branch)) throw new Error("Retained worktree moved or was removed");
      if (signal?.aborted || !current()) throw new Error("Worktree resume context changed");
      await save({ ...record, childId: child.childId, released: false });
      child.spec.worktreeInfo = { path: record.path, branch: record.branch, baseCommit: record.baseCommit, includedChanges: record.includedChanges };
      attachContext(child, record);
    });
    return;
  }
  const settings = await loadWorktreeSettings();
  if (settings.kind === "invalid") throw new Error("Worktree settings are invalid");
  const plans = [];
  for (const child of requested) {
    const choice = worktreeOption(child.spec.worktree)!;
    const sourceCwd = await fs.realpath(child.spec.cwd!);
    const repo = await currentWorktreePath(gitClient(), sourceCwd, signal);
    if (!within(repo, sourceCwd)) throw new Error("Source cwd is outside its Git checkout");
    const status = await worktreeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], repo, signal);
    if (status && !choice.changes) throw new Error(`Repository ${repo} has uncommitted changes. Set worktree.changes to "include" or "exclude".`);
    const head = await resolveCommit(gitClient(), repo, "HEAD", signal);
    const base = await resolveCommit(gitClient(), repo, choice.base ?? "HEAD", signal);
    if (status && choice.changes === "include" && head !== base) throw new Error("Including working changes requires HEAD as the base; choose exclude for another commit");
    let delta: Awaited<ReturnType<typeof capture>> | undefined;
    if (status && choice.changes === "include") {
      if ((await worktreeGit(["ls-files", "-u", "-z"], repo, signal)).length) throw new Error("Cannot include an unresolved merge index");
      const flags = (await worktreeGit(["ls-files", "-v", "-z"], repo, signal)).split("\0");
      if (flags.some(line => /^[a-zS]/.test(line))) throw new Error("Cannot snapshot assume-unchanged or skip-worktree index entries");
      const submodules = await worktreeGit(["submodule", "foreach", "--recursive", "--quiet", "git status --porcelain=v1 --untracked-files=all"], repo, signal);
      if (submodules.trim()) throw new Error("Cannot include uncommitted changes inside submodules");
      delta = await capture(repo, signal);
    }
    const records = await listWorktrees(gitClient(), repo, signal);
    const branch = await validateBranch(gitClient(), repo, `pi/${child.spec.name ?? "worker"}-${child.taskId.slice(-12)}`, signal);
    let path = defaultWorktreePath(records[0]?.path ?? repo, branch, settings.effectiveRoot);
    let ancestor = dirname(path); const suffix = [basename(path)];
    while (!pathEntryExists(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    path = join(await fs.realpath(ancestor), ...suffix);
    if (records.some(record => within(record.path, path))) throw new Error("Automatic worktrees must be outside existing checkouts");
    if (pathEntryExists(path) || unresolvableSymlinkAncestor(path) || records.some(row => row.branch === branch)) throw new Error(`Worktree target is occupied: ${path}`);
    const commonDir = (await worktreeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo, signal)).trim();
    const record: OwnedWorktree = { version: 1, ownerSessionId: owner, taskId: child.taskId, childId: child.childId, title: child.spec.name ?? child.spec.task.slice(0, 140),
      canonicalDisplayName: recordedWorktreeName(child.spec),
      repo, commonDir, path, cwd: join(path, relative(repo, sourceCwd)), branch, baseCommit: base,
      includedChanges: !!delta, createdAt: new Date().toISOString(), released: false, state: "preparing" };
    attachContext(child, record);
    if (Buffer.byteLength(child.spec.systemPrompt ?? "") > 64 * 1024) throw new Error("System prompt plus worktree context exceeds the worker limit");
    plans.push({ child, record, choice, delta, head });
  }
  const created: OwnedWorktree[] = [];
  try {
    for (const plan of plans) await serialized(owner, plan.record.taskId, async () => {
      if (signal?.aborted || !current()) throw new Error("Worktree launch context changed");
      const { record, delta, choice } = plan;
      const now = await worktreeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], record.repo, signal);
      if (now && (!choice.changes || (choice.changes === "include" && !delta))) throw new Error("Repository became dirty during preparation; retry with an explicit include or exclude choice");
      if (delta && ((await resolveCommit(gitClient(), record.repo, "HEAD", signal)) !== plan.head || (await capture(record.repo, signal)).digest !== delta.digest)) throw new Error("Source changes moved during snapshot preparation");
      await save(record); created.push(record);
      if (signal?.aborted || !current()) throw new Error("Worktree launch context changed");
      await addWorktree(gitClient(), record.repo, { path: record.path, branch: record.branch, startOid: record.baseCommit }, signal);
      const target = await fs.lstat(record.path);
      if (!target.isDirectory() || target.isSymbolicLink() || !(await listWorktrees(gitClient(), record.repo, signal)).some(row => row.path === record.path && row.branch === record.branch)) throw new Error("Created worktree identity changed");
      const adminStat = await fs.stat((await worktreeGit(["rev-parse", "--path-format=absolute", "--git-dir"], record.path, signal)).trim());
      record.physicalIdentity = { dev: String(adminStat.dev), ino: String(adminStat.ino), birthtimeMs: String(adminStat.birthtimeMs) };
      await save(record);
      await fs.chmod(record.path, 0o700);
      if (delta) {
        if (delta.staged) await worktreeGit(["apply", "--index", "--binary", "-"], record.path, signal, Buffer.from(delta.staged));
        if (delta.unstaged) await worktreeGit(["apply", "--binary", "-"], record.path, signal, Buffer.from(delta.unstaged));
        for (const file of delta.files) {
          const destination = join(record.path, file.path);
          let ancestor = dirname(destination);
          while (!pathEntryExists(ancestor)) ancestor = dirname(ancestor);
          if (!within(record.path, await fs.realpath(ancestor))) throw new Error("Untracked destination escapes the worktree");
          await fs.mkdir(dirname(destination), { recursive: true });
          const parent = await fs.realpath(dirname(destination));
          if (parent !== record.path && !parent.startsWith(record.path + sep)) throw new Error("Untracked destination escapes the worktree");
          if (file.link !== undefined) await fs.symlink(file.link, destination);
          else await fs.writeFile(destination, file.bytes!, { mode: file.mode, flag: "wx" });
        }
        if ((await resolveCommit(gitClient(), record.repo, "HEAD", signal)) !== plan.head || (await capture(record.repo, signal)).digest !== delta.digest) throw new Error("Source changed during snapshot copying");
      }
      if ((await resolveCommit(gitClient(), record.path, "HEAD", signal)) !== record.baseCommit) throw new Error("Created worktree HEAD changed");
      if (!(await fs.stat(record.cwd)).isDirectory()) throw new Error("Selected cwd does not exist in the isolated version");
      record.cwd = await fs.realpath(record.cwd);
      if (!within(record.path, record.cwd)) throw new Error("Selected cwd escapes the isolated worktree");
      if (!delta && choice.changes !== "exclude" && (await worktreeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], record.repo, signal))) throw new Error("Source became dirty during worktree creation; retry with an explicit changes choice");
      if (signal?.aborted || !current()) throw new Error("Worktree launch context changed");
      record.state = "ready"; await save(record); plan.child.spec.cwd = record.cwd;
      plan.child.spec.worktreeInfo = { path: record.path, branch: record.branch, baseCommit: record.baseCommit, includedChanges: record.includedChanges };
      attachContext(plan.child, record);
    });
  } catch (error) {
    for (const record of created) await serialized(owner, record.taskId, async () => {
      const latest = (await ownedWorktrees(owner)).find(row => row.taskId === record.taskId);
      await save({ ...record, ...latest, released: true, state: "failed", error: String(error).slice(0, 2000) });
    });
    throw new Error(`${error instanceof Error ? error.message : error}${created.length ? `; retained worktrees for inspection: ${created.map(row => row.path).join(", ")}` : ""}`);
  }
}
