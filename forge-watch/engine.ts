import { type ForgeCategory, type ForgeEvent, type ForgeIdentity, type ForgeItem, type ForgeSnapshot, type ForgeSubscription, type ForgeTarget, type ForgeWatchOptions, type ForgeWatchState, type ForgeWatchStatus } from "./types.js";

const categories: ForgeCategory[] = ["head", "state", "comments", "reviews", "ci"];
const keyFor = (target: ForgeTarget) => `${target.provider}:${target.host}/${target.project}#${target.number}`;
const idFor = (identity: ForgeIdentity) => `${identity.sessionId}\0${identity.goalId}\0${identity.activationId}`;
const empty = (): ForgeWatchState => ({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 });

export class ForgeWatchEngine {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ForgeWatchOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ForgeWatchOptions["clearTimer"]>;
  private timer?: unknown;
  private stopped = true;
  private readonly inFlight = new Set<string>();
  private readonly wakePending = new Set<string>();
  private mutation = Promise.resolve();
  private readonly opts: ForgeWatchOptions;

  constructor(options: ForgeWatchOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  private update<T>(fn: (state: ForgeWatchState) => T): Promise<T> {
    const operation = this.mutation.then(() => this.opts.storage.update((state) => fn(state ?? empty())));
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async watch(input: { target: ForgeTarget; identity: ForgeIdentity; categories?: ForgeCategory[]; ignoreActors?: string[]; active?: boolean }): Promise<ForgeSubscription> {
    const id = idFor(input.identity);
    return this.update((state) => {
      const targetKey = keyFor(input.target);
      state.targets[targetKey] ??= { target: input.target, retryCount: 0, nextPollAt: this.now() };
      const sub: ForgeSubscription = { id, identity: input.identity, target: input.target, categories: [...new Set(input.categories ?? categories)], ignoreActors: (input.ignoreActors ?? []).map((a) => a.toLowerCase()), active: input.active ?? true };
      state.subscriptions[id] = sub;
      state.queues[id] ??= [];
      return structuredClone(sub);
    }).then((sub) => { this.schedule(0); return sub; });
  }

  async unwatch(identity: ForgeIdentity): Promise<boolean> {
    return this.update((state) => { const id = idFor(identity); delete state.subscriptions[id]; delete state.queues[id]; return true; });
  }

  async stopIdentity(identity: ForgeIdentity): Promise<boolean> { return this.unwatch(identity); }
  async expire(identity: ForgeIdentity): Promise<boolean> { return this.unwatch(identity); }

  async status(identity?: ForgeIdentity): Promise<ForgeWatchStatus[]> {
    return this.update((state) => Object.values(state.subscriptions).filter((s) => !identity || s.id === idFor(identity)).map((subscription) => ({ subscription: structuredClone(subscription), pending: state.queues[subscription.id]?.length ?? 0, ...(state.targets[keyFor(subscription.target)]?.lastError ? { lastError: state.targets[keyFor(subscription.target)]!.lastError } : {}), ...(state.targets[keyFor(subscription.target)] ? { nextPollAt: state.targets[keyFor(subscription.target)]!.nextPollAt } : {}) })));
  }

  async events(identity: ForgeIdentity, consume = false): Promise<ForgeEvent[]> {
    return this.update((state) => { const id = idFor(identity); const result = structuredClone(state.queues[id] ?? []); if (consume) state.queues[id] = []; return result; });
  }

  async ack(identity: ForgeIdentity, eventIds: string[]): Promise<number> {
    return this.update((state) => { const id = idFor(identity); const queue = state.queues[id] ?? []; const ids = new Set(eventIds); const kept = queue.filter((event) => !ids.has(event.id)); state.queues[id] = kept; if (!kept.length && state.subscriptions[id]) state.subscriptions[id]!.deliveryNotified = false; return queue.length - kept.length; }).then(async (n) => { await this.deliverPending(); return n; });
  }

  start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
  stop(): void { this.stopped = true; if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; for (const key of this.inFlight) this.controllers.get(key)?.abort(); }
  private controllers = new Map<string, AbortController>();
  private schedule(delay: number): void { if (this.stopped) return; if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = this.setTimer(() => { this.timer = undefined; void this.tick(); }, Math.max(0, delay)); }

  async pollOnce(target?: ForgeTarget): Promise<void> {
    const state = await this.update((s) => structuredClone(s));
    const due = Object.entries(state.targets).filter(([key, t]) => (!target || key === keyFor(target)) && !this.inFlight.has(key)).slice(0, this.opts.maxConcurrency ?? 3);
    await Promise.all(due.map(([key, record]) => this.pollTarget(key, record.target)));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const state = await this.update((s) => structuredClone(s));
    const now = this.now();
    const due = Object.entries(state.targets).filter(([key, t]) => t.nextPollAt <= now && !this.inFlight.has(key)).slice(0, this.opts.maxConcurrency ?? 3);
    await Promise.all(due.map(([key, record]) => this.pollTarget(key, record.target)));
    await this.deliverPending();
    if (!this.stopped) {
      const latest = await this.update((s) => structuredClone(s));
      const next = Math.min(...Object.values(latest.targets).map((t) => t.nextPollAt), now + (this.opts.intervalMs ?? 60_000));
      this.schedule(Math.max(100, next - this.now()));
    }
  }

  private async pollTarget(key: string, target: ForgeTarget): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const controller = new AbortController(); this.controllers.set(key, controller);
    let rejectTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = this.setTimer(() => { const error = new Error("Forge poll timed out"); controller.abort(error); rejectTimeout(error); }, this.opts.timeoutMs ?? 20_000);
    try {
      const snapshot = validateSnapshot(await Promise.race([this.opts.adapter.poll(target, controller.signal), timedOut]));
      await this.update((state) => {
        const record = state.targets[key]; if (!record) return;
        const previous = record.baseline; record.baseline = snapshot; record.retryCount = 0; record.lastError = undefined; record.nextPollAt = this.now() + (this.opts.intervalMs ?? 60_000);
        if (!previous) return;
        for (const sub of Object.values(state.subscriptions).filter((candidate) => keyFor(candidate.target) === key)) {
          for (const category of categories) for (const fingerprint of changes(previous, snapshot, category)) {
            if (!sub.categories.includes(category)) continue;
            const item = [...snapshot.comments, ...snapshot.reviews].find((entry) => entry.fingerprint === fingerprint);
            if (item?.actor && sub.ignoreActors.includes(item.actor.toLowerCase())) continue;
            const queue = state.queues[sub.id] ?? (state.queues[sub.id] = []);
            if (queue.some((event) => event.category === category && event.fingerprint === fingerprint)) continue;
            if (queue.length >= (this.opts.maxEventsPerSubscription ?? 100)) { sub.overflow = `Event queue limit (${this.opts.maxEventsPerSubscription ?? 100}) exceeded`; continue; }
            queue.push({ id: String(state.nextEvent++), target, category, fingerprint, at: this.now() });
          }
        }
      });
      await this.deliverPending();
    } catch (error) {
      if (this.stopped && controller.signal.aborted) return;
      await this.update((state) => { const record = state.targets[key]; if (!record) return; record.retryCount++; record.lastError = error instanceof Error ? error.message : String(error); const exp = Math.min(this.opts.maxBackoffMs ?? 15 * 60_000, 1000 * 2 ** Math.min(record.retryCount, 16)); const retryAfter = Number((error as { retryAfterMs?: number })?.retryAfterMs); const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : exp; record.nextPollAt = this.now() + (this.opts.jitter ?? ((d) => d))(delay); });
    } finally { this.clearTimer(timeout); this.inFlight.delete(key); this.controllers.delete(key); }
  }

  private async deliverPending(): Promise<void> {
    if (!this.opts.wake) return;
    const state = await this.update((s) => structuredClone(s));
    for (const sub of Object.values(state.subscriptions)) {
      const queue = state.queues[sub.id] ?? [];
      if (!sub.active || !queue.length || sub.deliveryNotified || this.wakePending.has(sub.id) || this.opts.isEligible?.(sub.identity) === false) continue;
      this.wakePending.add(sub.id);
      try {
        await this.opts.wake(sub.identity, queue);
        await this.update((current) => { if (current.subscriptions[sub.id] && current.queues[sub.id]?.length) current.subscriptions[sub.id]!.deliveryNotified = true; });
      } catch { /* Retain the durable batch for a later retry. */ }
      finally { this.wakePending.delete(sub.id); }
    }
  }
}

function changes(before: ForgeSnapshot, after: ForgeSnapshot, category: ForgeCategory): string[] {
  if (category === "head" || category === "state") { const a = before[category], b = after[category]; return a === b ? [] : [`${category}:${a}->${b}`]; }
  const old = new Set(before[category].map((item) => item.fingerprint));
  return after[category].filter((item) => !old.has(item.fingerprint)).map((item) => item.fingerprint);
}
function validateSnapshot(value: ForgeSnapshot): ForgeSnapshot {
  if (!value || typeof value.head !== "string" || typeof value.state !== "string") throw new Error("Invalid forge snapshot");
  for (const category of ["comments", "reviews", "ci"] as const) {
    if (!Array.isArray(value[category]) || value[category].some((item: ForgeItem) => !item || typeof item.id !== "string" || typeof item.fingerprint !== "string" || (item.actor !== undefined && typeof item.actor !== "string"))) throw new Error(`Invalid forge ${category} data`);
  }
  return structuredClone(value);
}
