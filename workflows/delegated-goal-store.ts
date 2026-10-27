import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { DelegatedGoals, DelegatedGoalIntent } from "./delegated-goals.ts";

/** Separate session-bound metadata: never adds messages or goal-state to a parent. */
export function delegatedGoalStore(sessionId: string, root = process.env.PI_DELEGATED_GOALS_STATE_ROOT ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi", "delegated-goals")) {
  const path = join(root, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  function read(target: string) {
    let raw: string;
    try { raw = readFileSync(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const data = JSON.parse(raw);
    if (data.sessionId !== sessionId) throw new Error("Invalid delegated goals session binding");
    return data;
  }
  function syncDirectory(directory = root) {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  function save(target: string, value: unknown) {
    const created = mkdirSync(root, { recursive: true, mode: 0o700 });
    if (created) {
      // Persist newly-created directory entries too, including their first
      // existing ancestor, before relying on this location for a launch fence.
      const existingParent = dirname(resolve(created));
      for (let directory = resolve(root); ; directory = dirname(directory)) {
        syncDirectory(directory);
        if (directory === existingParent) break;
      }
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(value));
        // A child may launch immediately after its intent is recorded. Atomic
        // rename alone is not a durable pre-effect fence across a host crash.
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(temporary, target);
      syncDirectory();
    } finally { try { unlinkSync(temporary); } catch {} }
  }
  return {
    load(): DelegatedGoals {
      const data = read(path);
      if (!data) return { version: 1, revision: 0, entries: [] };
      if (data.registry?.version !== 1 || !Number.isSafeInteger(data.registry.revision) || !Array.isArray(data.registry.entries)) throw new Error("Invalid delegated goals metadata");
      return data.registry;
    },
    save(registry: DelegatedGoals) { save(path, { sessionId, registry }); },
    loadIntent(): DelegatedGoalIntent | null {
      const data = read(`${path}.intent`);
      if (!data) return null;
      if (!data.intent || typeof data.intent.requestId !== "string" || typeof data.intent.action !== "string" || typeof data.intent.entryId !== "string" || !Number.isSafeInteger(data.intent.expectedEntryRevision)) throw new Error("Invalid delegated goal pending intent");
      return data.intent;
    },
    saveIntent(intent: DelegatedGoalIntent | null) {
      if (intent === null) { try { unlinkSync(`${path}.intent`); syncDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      else save(`${path}.intent`, { sessionId, intent });
    },
  };
}
