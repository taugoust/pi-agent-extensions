/** Per-child outcome of a permission prompt mode change sent to retained workers. */
export type ModeDelivery = {
  applied: string[];
  /** Workers whose recorded process identity is verifiably gone; nothing to deliver to. */
  stopped: string[];
  failed: { childId: string; error: string }[];
};

export type ModeTarget = {
  childId: string;
  send: () => Promise<void>;
  /** True only when the worker's own pid and start token prove it has exited. */
  stopped: () => Promise<boolean>;
};

/**
 * Sends the mode to every target and reports each one. A worker counts as stopped only by its
 * process identity, never by missing activity; any other failure stays visible as failed.
 */
export async function deliverMode(targets: ModeTarget[]): Promise<ModeDelivery> {
  const result: ModeDelivery = { applied: [], stopped: [], failed: [] };
  await Promise.all(targets.map(async (target) => {
    if (await target.stopped().catch(() => false)) { result.stopped.push(target.childId); return; }
    try {
      await target.send();
      result.applied.push(target.childId);
    } catch (error) {
      if (await target.stopped().catch(() => false)) result.stopped.push(target.childId);
      else result.failed.push({ childId: target.childId, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
  }));
  return result;
}

export function mergeModeDeliveries(deliveries: (ModeDelivery | undefined)[]): ModeDelivery {
  const merged: ModeDelivery = { applied: [], stopped: [], failed: [] };
  for (const delivery of deliveries) {
    if (!delivery) continue;
    merged.applied.push(...delivery.applied);
    merged.stopped.push(...delivery.stopped);
    merged.failed.push(...delivery.failed);
  }
  return merged;
}

/** The operator notice for a finished delivery, or undefined when there were no children. */
export function modeDeliveryNotice(delivery: ModeDelivery): { text: string; level: "info" | "error" } | undefined {
  const total = delivery.applied.length + delivery.stopped.length + delivery.failed.length;
  if (!total) return undefined;
  const stopped = delivery.stopped.length ? `; skipped ${delivery.stopped.length} stopped worker(s)` : "";
  if (!delivery.failed.length)
    return { text: `Child permission mode applied to ${delivery.applied.length} worker(s)${stopped}.`, level: "info" };
  const failures = delivery.failed.slice(0, 3).map(f => `${f.childId}: ${f.error}`).join("; ");
  return {
    text: `Child permission mode not applied to ${delivery.failed.length} of ${total} worker(s): ${failures}`
      + `${delivery.failed.length > 3 ? "; …" : ""}. Applied to ${delivery.applied.length}${stopped}.`,
    level: "error",
  };
}
