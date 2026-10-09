import type { BackgroundJobManager } from "./manager.ts";
import type { JobStore } from "./store.ts";

export const OUTPUT_RETENTION_MS = 5 * 60 * 1000;

/** Inspect every retained ID, not just the session's bounded presentation list. */
export async function reapExpiredRetrieved(manager: BackgroundJobManager, store: JobStore, now = Date.now()): Promise<void> {
  for (const id of await store.listIds()) {
    try {
      await manager.reapExpired(id, now, OUTPUT_RETENTION_MS);
    } catch { /* Ownership/identity uncertainty or concurrent removal retains the job. */ }
  }
}
