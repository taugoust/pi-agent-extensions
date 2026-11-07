import { type ForgeCategory, type ForgeEvent, type ForgeIdentity, type ForgeItem, type ForgeSnapshot, type ForgeSubscription, type ForgeTarget, type ForgeWatchOptions, type ForgeWatchState, type ForgeWatchStatus } from "./types.js";

const categories: ForgeCategory[] = ["head", "state", "comments", "reviews", "ci"];
const keyFor = (t: ForgeTarget) => `${t.provider}:${t.host}/${t.project}#${t.number}`;
const identityKey = (i: ForgeIdentity) => `${i.sessionId}\0${i.goalId}\0${i.activationId}`;
const subscriptionId = (i: ForgeIdentity, t: ForgeTarget) => `${identityKey(i)}\0${keyFor(t)}`;
const sameIdentity = (a: ForgeIdentity, b: ForgeIdentity) => identityKey(a) === identityKey(b);
const empty = (): ForgeWatchState => ({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 });
const errorOf = (e: unknown) => e instanceof Error ? e : new Error(String(e));

export class ForgeWatchEngine {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ForgeWatchOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ForgeWatchOptions["clearTimer"]>;
  private timer?: unknown;
  private stopped = true;
  private generation = 0;
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly wakePending = new Set<string>();
  private mutation = Promise.resolve();
  private readonly opts: ForgeWatchOptions;

  constructor(options: ForgeWatchOptions) {
    this.opts = options; this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  private report(error: unknown): void { try { this.opts.onError?.(errorOf(error)); } catch { /* Error reporting must not break the scheduler. */ } }
  private update<T>(fn: (state: ForgeWatchState) => T): Promise<T> {
    const operation = this.mutation.then(() => this.opts.storage.update((raw) => {
      const state = raw ?? empty(); validateState(state, this.opts); const result = fn(state); validateState(state, this.opts); return result;
    }));
    this.mutation = operation.then(() => undefined, (error) => { this.report(error); });
    return operation;
  }

  async watch(input: { target: ForgeTarget; identity: ForgeIdentity; categories?: ForgeCategory[]; ignoreActors?: string[]; active?: boolean }): Promise<ForgeSubscription> {
    validateIdentity(input.identity); validateTarget(input.target);
    const id = subscriptionId(input.identity, input.target), targetKey = keyFor(input.target);
    const sub = await this.update((state) => {
      if (!state.targets[targetKey] && Object.keys(state.targets).length >= (this.opts.maxTargets ?? 256)) throw new Error("Forge target retention limit exceeded");
      if (!state.subscriptions[id] && Object.keys(state.subscriptions).length >= (this.opts.maxSubscriptions ?? 512)) throw new Error("Forge subscription retention limit exceeded");
      state.targets[targetKey] ??= { target: input.target, retryCount: 0, nextPollAt: this.now() };
      const selected = [...new Set(input.categories ?? categories)];
      if (!selected.length || selected.some((c) => !categories.includes(c))) throw new Error("Invalid or empty forge category selection");
      const value: ForgeSubscription = { id, identity: { ...input.identity }, target: input.target, categories: selected, ignoreActors: (input.ignoreActors ?? []).map((a) => a.toLowerCase()), active: input.active ?? true, deliveryNotified: state.subscriptions[id]?.deliveryNotified ?? false };
      state.subscriptions[id] = value; state.queues[id] ??= [];
      return structuredClone(value);
    });
    this.schedule(0); return sub;
  }

  async unwatch(identity: ForgeIdentity, target?: ForgeTarget): Promise<boolean> {
    validateIdentity(identity); if (target) validateTarget(target);
    return this.update((state) => {
      let removed = false;
      for (const [id, sub] of Object.entries(state.subscriptions)) if (sameIdentity(sub.identity, identity) && (!target || keyFor(sub.target) === keyFor(target))) { delete state.subscriptions[id]; delete state.queues[id]; removed = true; }
      this.pruneTargets(state); return removed;
    });
  }
  async stopIdentity(identity: ForgeIdentity, target?: ForgeTarget): Promise<boolean> { return this.unwatch(identity, target); }
  async expire(identity: ForgeIdentity, target?: ForgeTarget): Promise<boolean> { return this.unwatch(identity, target); }

  async status(identity?: ForgeIdentity): Promise<ForgeWatchStatus[]> {
    if (identity) validateIdentity(identity);
    return this.update((state) => Object.values(state.subscriptions).filter((s) => !identity || sameIdentity(s.identity, identity)).map((subscription) => ({ subscription: structuredClone(subscription), pending: state.queues[subscription.id]?.length ?? 0, ...(state.targets[keyFor(subscription.target)]?.lastError ? { lastError: state.targets[keyFor(subscription.target)]!.lastError } : {}), ...(state.targets[keyFor(subscription.target)] ? { nextPollAt: state.targets[keyFor(subscription.target)]!.nextPollAt } : {}) })));
  }
  async events(identity: ForgeIdentity, consume = false): Promise<ForgeEvent[]> {
    validateIdentity(identity);
    return this.update((state) => {
      const ids = Object.values(state.subscriptions).filter((s) => sameIdentity(s.identity, identity)).map((s) => s.id);
      const all = ids.flatMap((id) => state.queues[id] ?? []).sort((a, b) => Number(a.id) - Number(b.id));
      if (consume) for (const id of ids) { state.queues[id] = []; state.subscriptions[id]!.deliveryNotified = false; }
      return structuredClone(all);
    });
  }
  async ack(identity: ForgeIdentity, eventIds: string[]): Promise<number> {
    validateIdentity(identity); if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string")) throw new Error("Invalid forge event acknowledgement");
    const n = await this.update((state) => {
      let removed = 0;
      for (const sub of Object.values(state.subscriptions).filter((s) => sameIdentity(s.identity, identity))) {
        const queue = state.queues[sub.id] ?? [], ids = new Set(eventIds), kept = queue.filter((e) => !ids.has(e.id)); removed += queue.length - kept.length; state.queues[sub.id] = kept; if (!kept.length) sub.deliveryNotified = false;
      }
      return removed;
    });
    await this.deliverPending(); return n;
  }

  start(): void { if (!this.stopped) return; this.stopped = false; this.generation++; this.schedule(0); }
  stop(): void { this.stopped = true; this.generation++; if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; for (const c of this.controllers.values()) c.abort(new Error("Forge watcher stopped")); }
  private schedule(delay: number): void { if (this.stopped) return; if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = this.setTimer(() => { this.timer = undefined; void this.tick().catch((e) => { this.report(e); this.schedule(this.retryDelay(1000)); }); }, Math.max(0, delay)); }

  async pollOnce(target?: ForgeTarget): Promise<void> { await this.pollDue(target, false); await this.deliverPending(); }
  private async pollDue(target: ForgeTarget | undefined, dueOnly: boolean): Promise<void> {
    const state = await this.update((s) => structuredClone(s));
    const limit = Math.max(1, this.opts.maxConcurrency ?? 3), generation = this.generation;
    const due = Object.entries(state.targets).filter(([key, t]) => (!target || key === keyFor(target)) && (!dueOnly || t.nextPollAt <= this.now()) && !this.inFlight.has(key));
    const slots = Math.max(0, limit - this.inFlight.size);
    const selected = due.slice(0, slots);
    for (const [key] of selected) this.inFlight.add(key);
    await Promise.all(selected.map(([key, record]) => this.pollTarget(key, record.target, generation)));
  }
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    await this.pollDue(undefined, true);
    if (this.stopped || generation !== this.generation) return;
    await this.deliverPending();
    if (this.stopped || generation !== this.generation) return;
    const latest = await this.update((s) => structuredClone(s));
    const next = Math.min(...Object.values(latest.targets).map((t) => t.nextPollAt), this.now() + (this.opts.intervalMs ?? 60_000));
    this.schedule(Math.max(100, next - this.now()));
  }
  private retryDelay(base: number): number {
    const jitter = this.opts.jitter ? this.opts.jitter(base) : base * (0.8 + Math.max(0, Math.min(1, (this.opts.random ?? Math.random)())) * 0.4);
    return Math.max(100, Math.min(this.opts.maxBackoffMs ?? 15 * 60_000, Number.isFinite(jitter) ? jitter : base));
  }
  private async pollTarget(key: string, target: ForgeTarget, generation: number): Promise<void> {
    if (generation !== this.generation) { this.inFlight.delete(key); return; }
    const controller = new AbortController(); this.controllers.set(key, controller);
    let rejectTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    controller.signal.addEventListener("abort", () => rejectTimeout(errorOf(controller.signal.reason ?? new Error("Forge poll aborted"))), { once: true });
    const timeout = this.setTimer(() => { const error = new Error("Forge poll timed out"); controller.abort(error); rejectTimeout(error); }, this.opts.timeoutMs ?? 20_000);
    try {
      const snapshot = validateSnapshot(await Promise.race([this.opts.adapter.poll(target, controller.signal), timedOut]), this.opts);
      if (generation !== this.generation) return;
      await this.update((state) => {
        if (generation !== this.generation) return;
        const record = state.targets[key]; if (!record) return;
        const previous = record.baseline; record.baseline = snapshot; record.retryCount = 0; record.lastError = undefined; record.nextPollAt = this.now() + (this.opts.intervalMs ?? 60_000);
        if (!previous) return;
        for (const sub of Object.values(state.subscriptions).filter((candidate) => keyFor(candidate.target) === key)) {
          for (const category of categories) for (const change of changes(previous, snapshot, category)) {
            if (!sub.categories.includes(category)) continue;
            if ((category === "comments" || category === "reviews") && change.actor && sub.ignoreActors.includes(change.actor.toLowerCase())) continue;
            const queue = state.queues[sub.id] ?? (state.queues[sub.id] = []);
            if (queue.some((event) => event.category === category && event.fingerprint === change.fingerprint)) continue;
            const globalLimit = this.opts.maxQueueEvents ?? 10_000;
            if (queue.length >= (this.opts.maxEventsPerSubscription ?? 100) || Object.values(state.queues).reduce((n, q) => n + q.length, 0) >= globalLimit) { sub.overflow = `Event queue retention limit exceeded (${globalLimit} total events maximum)`; continue; }
            if (queue.length === 0) sub.deliveryNotified = false;
            queue.push({ id: String(state.nextEvent++), target, category, fingerprint: `${category}:${change.fingerprint}`, at: this.now() });
          }
        }
      });
      if (generation === this.generation) await this.deliverPending();
    } catch (error) {
      if (generation !== this.generation) return;
      const err = errorOf(error); this.report(err);
      await this.update((state) => { const record = state.targets[key]; if (!record || generation !== this.generation) return; record.retryCount++; record.lastError = err.message; const exp = Math.min(this.opts.maxBackoffMs ?? 15 * 60_000, 1000 * 2 ** Math.min(record.retryCount, 16)); const retryRaw = (error as { retryAfterMs?: number })?.retryAfterMs; const retry = Number(retryRaw); const validRetry = retryRaw !== undefined && Number.isFinite(retry) && retry >= 0 && retry <= 24 * 60 * 60_000; if (retryRaw !== undefined && !validRetry) this.report(new Error("Invalid or excessive Retry-After value; using exponential backoff")); const backoff = this.retryDelay(exp); record.nextPollAt = this.now() + Math.max(backoff, validRetry ? retry : 0); });
    } finally { this.clearTimer(timeout); this.inFlight.delete(key); this.controllers.delete(key); }
  }
  private pruneTargets(state: ForgeWatchState): void {
    const retained = new Set(Object.values(state.subscriptions).map((s) => keyFor(s.target)));
    for (const key of Object.keys(state.targets)) if (!retained.has(key)) delete state.targets[key];
  }
  private async deliverPending(): Promise<void> {
    if (!this.opts.wake) return;
    const generation = this.generation, state = await this.update((s) => structuredClone(s));
    for (const sub of Object.values(state.subscriptions)) {
      const queue = state.queues[sub.id] ?? [];
      if (generation !== this.generation) return;
      if (!sub.active || !queue.length || sub.deliveryNotified || this.wakePending.has(sub.id) || this.opts.isEligible?.(sub.identity) === false) continue;
      this.wakePending.add(sub.id);
      try {
        if (generation !== this.generation || this.opts.isEligible?.(sub.identity) === false) continue;
        await this.opts.wake(sub.identity, queue);
        if (generation !== this.generation || this.opts.isEligible?.(sub.identity) === false) continue;
        await this.update((current) => { if (generation === this.generation && current.subscriptions[sub.id] && current.queues[sub.id]?.length) current.subscriptions[sub.id]!.deliveryNotified = true; });
      } catch { /* Retain the durable batch for a later retry. */ }
      finally { this.wakePending.delete(sub.id); }
    }
  }
}

function changes(before: ForgeSnapshot, after: ForgeSnapshot, category: ForgeCategory): Array<{ fingerprint: string; actor?: string }> {
  if (category === "head" || category === "state") { const a = before[category], b = after[category]; return a === b ? [] : [{ fingerprint: `${a}->${b}` }]; }
  const old = new Map(before[category].map((item) => [item.id, item])), current = new Map(after[category].map((item) => [item.id, item]));
  const result: Array<{ fingerprint: string; actor?: string }> = [];
  for (const item of after[category]) { const prior = old.get(item.id); if (!prior || prior.fingerprint !== item.fingerprint) result.push({ fingerprint: item.fingerprint, actor: item.actor }); }
  for (const item of before[category]) if (!current.has(item.id)) result.push({ fingerprint: `removed:${item.fingerprint}`, actor: item.actor });
  return result;
}
function validateIdentity(i: ForgeIdentity): void { if (!i || [i.sessionId, i.goalId, i.activationId].some((x) => typeof x !== "string" || !x.trim())) throw new Error("Invalid forge identity"); }
function validateTarget(t: ForgeTarget): void { if (!t || !["github", "gitlab"].includes(t.provider) || typeof t.host !== "string" || !t.host || typeof t.project !== "string" || !t.project || !Number.isSafeInteger(t.number) || t.number < 1 || typeof t.url !== "string") throw new Error("Invalid forge target"); }
function validateSnapshot(value: ForgeSnapshot, opts: ForgeWatchOptions): ForgeSnapshot {
  if (!value || typeof value.head !== "string" || !value.head.trim() || typeof value.state !== "string" || !value.state.trim()) throw new Error("Invalid forge snapshot");
  const max = opts.maxBaselineItems ?? 5000; let count = 0;
  for (const cat of ["comments", "reviews", "ci"] as const) {
    if (!Array.isArray(value[cat]) || value[cat].some((item: ForgeItem) => !item || typeof item.id !== "string" || !item.id || typeof item.fingerprint !== "string" || !item.fingerprint || (item.actor !== undefined && typeof item.actor !== "string")) || new Set(value[cat].map((x) => x.id)).size !== value[cat].length) throw new Error(`Invalid forge ${cat} data`);
    count += value[cat].length;
  }
  if (count > max) throw new Error(`Forge baseline exceeds ${max} items`);
  return structuredClone(value);
}
function validateState(state: ForgeWatchState, opts: ForgeWatchOptions): void {
  if (!state || state.version !== 1 || !state.targets || !state.subscriptions || !state.queues || !Number.isSafeInteger(state.nextEvent) || state.nextEvent < 1) throw new Error("Invalid persisted forge watch state");
  if (Object.keys(state.targets).length > (opts.maxTargets ?? 256) || Object.keys(state.subscriptions).length > (opts.maxSubscriptions ?? 512)) throw new Error("Persisted forge watch state exceeds retention limits");
  for (const [id, sub] of Object.entries(state.subscriptions)) { validateIdentity(sub.identity); validateTarget(sub.target); if (id !== sub.id || id !== subscriptionId(sub.identity, sub.target) || !Array.isArray(sub.categories) || sub.categories.some((c) => !categories.includes(c)) || !Array.isArray(sub.ignoreActors)) throw new Error("Invalid persisted forge subscription"); }
  const maxQueue = opts.maxEventsPerSubscription ?? 100;
  for (const [id, queue] of Object.entries(state.queues)) if (!state.subscriptions[id] || !Array.isArray(queue) || queue.length > maxQueue || queue.some((e) => !e || typeof e.id !== "string" || !categories.includes(e.category) || typeof e.fingerprint !== "string" || !Number.isFinite(e.at))) throw new Error("Invalid or oversized persisted forge event queue");
  if (Object.values(state.queues).reduce((n, q) => n + q.length, 0) > (opts.maxQueueEvents ?? 10_000)) throw new Error("Persisted forge queues exceed retention limit");
  for (const t of Object.values(state.targets)) { validateTarget(t.target); if (!Number.isFinite(t.nextPollAt) || !Number.isSafeInteger(t.retryCount) || t.retryCount < 0) throw new Error("Invalid persisted forge target state"); if (t.baseline) validateSnapshot(t.baseline, opts); }
}
