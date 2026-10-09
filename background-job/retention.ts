import type { JobRecord } from "./types.ts";

export const OUTPUT_RETENTION_MS = 5 * 60 * 1000;

/** Persistent retrieval timestamps are scoped to manager-controlled jobs only. */
export async function retrieveAndSchedule(record: JobRecord, store: any, now = Date.now()): Promise<void> {
  if (record.result && !record.metadata.observed && !record.metadata.pane && record.launch) {
    await store.markRetrieved(record.metadata.id, now);
  }
}

export async function reapExpiredRetrieved(manager: any, store: any, now = Date.now()): Promise<void> {
  for (const id of await store.listIds()) {
    try {
      const record: JobRecord = await manager.get(id);
      if (!record.result || record.metadata.infrastructure || record.metadata.observed || record.metadata.pane || !record.launch) continue;
      const retrieved = await store.readRetrieved(id);
      if (retrieved !== undefined && now - retrieved >= OUTPUT_RETENTION_MS) await manager.reap(id);
    } catch { /* ownership/identity uncertainty retains the job */ }
  }
}
