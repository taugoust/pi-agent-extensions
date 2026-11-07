import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ForgeTarget, ForgeWatchState, ForgeWatchStorage } from "./types.ts";

export interface ApprovalObligation {
  goalId: string;
  target: ForgeTarget;
  reviewer: string;
  expectedHead: string;
}
interface Document {
  version: 1;
  sessionId: string;
  state: ForgeWatchState;
  approvals: ApprovalObligation[];
}
const MAX_BYTES = 4 * 1024 * 1024;
const initialState = (): ForgeWatchState => ({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 });

/** One owning session runtime; atomic private snapshots, not model-context entries.
 * Paths are derived by the extension from a session ID, never accepted from a tool.
 * No state/credentials are shared across sessions. Storage failure denies mutation.
 */
export class FileWatchStore implements ForgeWatchStorage {
  private document: Document;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private readonly file: string, sessionId: string, document?: Document) {
    this.document = document ?? { version: 1, sessionId, state: initialState(), approvals: [] };
  }
  static async load(file: string, sessionId: string): Promise<FileWatchStore> {
    let document: Document | undefined;
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe forge-watch state permissions or size");
      const content = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Forge-watch state exceeds size limit");
      document = JSON.parse(content);
      if (!document || document.version !== 1 || document.sessionId !== sessionId || document.state?.version !== 1 || !document.state.targets || !document.state.subscriptions || !document.state.queues || !Array.isArray(document.approvals) || document.approvals.length > 100) throw new Error("Invalid or foreign forge-watch state");
      for (const obligation of document.approvals) {
        if (!obligation || typeof obligation.goalId !== "string" || !obligation.goalId || typeof obligation.reviewer !== "string" || !obligation.reviewer || typeof obligation.expectedHead !== "string" || !obligation.expectedHead || typeof obligation.target?.url !== "string") throw new Error("Invalid persisted approval obligation");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { await handle?.close(); }
    return new FileWatchStore(file, sessionId, document);
  }
  private mutate<T>(mutate: (document: Document) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("Forge-watch state is closed");
      const next = structuredClone(this.document);
      const value = mutate(next);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Forge-watch state exceeds bounded retention; consume events or unwatch targets");
      if (serialized !== JSON.stringify(this.document)) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(serialized + "\n"); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, this.file);
          this.document = next;
        } finally { await rm(temporary, { force: true }); }
      }
      return structuredClone(value);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> { return this.mutate(document => mutate(document.state)); }
  obligations(goalId?: string): Promise<ApprovalObligation[]> { return this.mutate(document => document.approvals.filter(o => goalId === undefined || o.goalId === goalId)); }
  requireApproval(obligation: ApprovalObligation): Promise<void> {
    return this.mutate(document => {
      const index = document.approvals.findIndex(o => o.goalId === obligation.goalId && o.target.url === obligation.target.url);
      if (index >= 0) {
        if (document.approvals[index]!.reviewer !== obligation.reviewer) throw new Error("An approval obligation cannot change its required human reviewer");
        document.approvals[index] = structuredClone(obligation);
      } else {
        if (document.approvals.length >= 100) throw new Error("Approval obligation retention limit reached");
        document.approvals.push(structuredClone(obligation));
      }
    });
  }
  async close(): Promise<void> { await this.queue; this.closed = true; }
}
