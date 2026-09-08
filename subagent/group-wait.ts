export type WaitGroup = { job_id: string; status: string; background?: boolean; children: Array<{ child: number; status: string; [key: string]: unknown }>; [key: string]: unknown };
const active = (status: string) => ["pending", "launching", "running", "cancelling"].includes(status);
/** One bounded observation over both backends. New groups/old finished children
 * never join the snapshot; cancelling observation never cancels execution. */
export async function waitForGroupSnapshot(read: () => Promise<WaitGroup[]>, operation: "wait_any" | "wait_all", timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  const check = () => { if (signal?.aborted) throw signal.reason ?? new Error("Wait cancelled; work remains running"); };
  check();
  const initial = (await read()).filter(g => g.background !== false && active(g.status));
  const candidates = initial.flatMap(g => g.children.filter(c => active(c.status)).map(c => ({ job: g.job_id, child: c.child })));
  let groups = initial;
  for (;;) {
    check();
    const remaining_children = groups.reduce((sum, g) => sum + g.children.filter(c => active(c.status)).length, 0);
    const terminal = candidates.map(c => ({ group: groups.find(g => g.job_id === c.job), child: groups.find(g => g.job_id === c.job)?.children.find(ch => ch.child === c.child) }))
      .find(c => c.child && !active(c.child.status));
    const done = operation === "wait_any" ? candidates.length === 0 || Boolean(terminal) : groups.every(g => !active(g.status));
    if (done || Date.now() >= deadline) return { groups, terminal, remaining_children, timed_out: !done };
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason ?? new Error("Wait cancelled")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, Math.min(100, Math.max(0, deadline - Date.now())));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    check();
    const current = await read();
    groups = initial.map(g => {
      const found = current.find(item => item.job_id === g.job_id);
      if (!found) throw new Error(`Snapshot group disappeared: ${g.job_id}`);
      return found;
    });
  }
}
