import { type ForgeCategory, type ForgeEvent, type ForgeIdentity, type ForgeItem, type ForgeSnapshot, type ForgeSubscription, type ForgeTarget, type ForgeWatchOptions, type ForgeWatchState, type ForgeWatchStatus } from "./types.ts";

const categories: ForgeCategory[] = ["head", "state", "comments", "reviews", "ci"];
const keyFor = (t: ForgeTarget) => `${t.provider}:${t.host}/${t.project}#${t.number}`;
const identityKey = (i: ForgeIdentity) => `${i.sessionId}\0${i.goalId}\0${i.activationId}`;
const subscriptionId = (i: ForgeIdentity, t: ForgeTarget) => `${identityKey(i)}\0${keyFor(t)}`;
const sameIdentity = (a: ForgeIdentity, b: ForgeIdentity) => identityKey(a) === identityKey(b);
const empty = (): ForgeWatchState => ({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 });
const errorOf = (e: unknown) => e instanceof Error ? e : new Error(String(e));
let engineSequence = 0;

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
  private readonly deliveryWork = new Set<Promise<unknown>>();
  private readonly pollWork = new Set<Promise<void>>();
  private readonly receiptErrors = new Map<string, string>();
  private readonly pendingReceipts = new Map<string, { ids: string[]; token: string; owner?: string }>();
  private receiptRetryTimer?: unknown;
  private mutation = Promise.resolve();
  private readonly opts: ForgeWatchOptions;
  private readonly runtimeId = `forge-watch-runtime-${Date.now()}-${++engineSequence}`;

  constructor(options: ForgeWatchOptions) {
    this.opts = options; this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  private report(error: unknown): void { try { this.opts.onError?.(errorOf(error)); } catch { /* Error reporting must not break the scheduler. */ } }
  private update<T>(fn: (state: ForgeWatchState) => T): Promise<T> {
    const operation = this.mutation.then(() => this.opts.storage.update((raw) => {
      const state = raw ?? empty(); migrateState(state, this.opts, this.now(), this.runtimeId); validateState(state, this.opts); expireInactive(state, this.opts, this.now()); const result = fn(state); expireInactive(state, this.opts, this.now()); validateState(state, this.opts); return result;
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
      const value: ForgeSubscription = { id, identity: { ...input.identity }, target: input.target, categories: selected, ignoreActors: (input.ignoreActors ?? []).map((a) => a.toLowerCase()), active: input.active ?? true, deliveryNotified: state.subscriptions[id]?.deliveryNotified ?? false, deliveryToken: state.subscriptions[id]?.deliveryToken, deliveryClaim: state.subscriptions[id]?.deliveryClaim, deliveryClaimOwner: state.subscriptions[id]?.deliveryClaimOwner, deliveryClaimEventIds: state.subscriptions[id]?.deliveryClaimEventIds, deliveryEventIds: state.subscriptions[id]?.deliveryEventIds, deliveryError: state.subscriptions[id]?.deliveryError, createdAt: state.subscriptions[id]?.createdAt ?? this.now(), updatedAt: this.now() };
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
  async setActive(identity: ForgeIdentity, active: boolean, target?: ForgeTarget): Promise<number> {
    validateIdentity(identity); if (target) validateTarget(target);
    const count = await this.update((state) => { let changed = 0; for (const sub of Object.values(state.subscriptions)) if (sameIdentity(sub.identity, identity) && (!target || keyFor(sub.target) === keyFor(target)) && sub.active !== active) { sub.active = active; sub.updatedAt = this.now(); changed++; } return changed; });
    if (active) this.schedule(0); else this.rescheduleIfRunning();
    return count;
  }
  private rescheduleIfRunning(): void { if (!this.stopped) this.schedule(0); }

  async status(identity?: ForgeIdentity): Promise<ForgeWatchStatus[]> {
    if (identity) validateIdentity(identity);
    return this.update((state) => Object.values(state.subscriptions)
      .filter((sub) => !identity || sameIdentity(sub.identity, identity))
      .map((subscription) => ({
        subscription: { ...structuredClone(subscription), ...(this.receiptErrors.get(subscription.id) ? { deliveryError: this.receiptErrors.get(subscription.id) } : {}) },
        pending: state.queues[subscription.id]?.length ?? 0,
        ...(state.targets[keyFor(subscription.target)]?.lastError ? { lastError: state.targets[keyFor(subscription.target)]!.lastError } : {}),
        ...(state.targets[keyFor(subscription.target)] ? { nextPollAt: state.targets[keyFor(subscription.target)]!.nextPollAt } : {}),
        ...(this.receiptErrors.get(subscription.id) ? { deliveryError: this.receiptErrors.get(subscription.id) } : {}),
      })));
  }
  async events(identity: ForgeIdentity, consume = false): Promise<ForgeEvent[]> {
    validateIdentity(identity);
    return this.update((state) => {
      const ids = Object.values(state.subscriptions).filter((s) => sameIdentity(s.identity, identity)).map((s) => s.id);
      const all = ids.flatMap((id) => state.queues[id] ?? []).sort((a, b) => Number(a.id) - Number(b.id));
      if (consume) for (const id of ids) { state.queues[id] = []; state.subscriptions[id]!.deliveryNotified = false; state.subscriptions[id]!.deliveryToken = undefined; state.subscriptions[id]!.deliveryEventIds = []; }
      return structuredClone(all);
    });
  }
  async ack(identity: ForgeIdentity, eventIds: string[]): Promise<number> {
    validateIdentity(identity); if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string")) throw new Error("Invalid forge event acknowledgement");
    const n = await this.update((state) => {
      let removed = 0;
      for (const sub of Object.values(state.subscriptions).filter((s) => sameIdentity(s.identity, identity))) {
        const queue = state.queues[sub.id] ?? [], ids = new Set(eventIds), kept = queue.filter((e) => !ids.has(e.id)); removed += queue.length - kept.length; state.queues[sub.id] = kept;
        const remainingReceipt = (sub.deliveryEventIds ?? []).filter((id) => kept.some((event) => event.id === id));
        if (!remainingReceipt.length) { sub.deliveryNotified = false; sub.deliveryToken = undefined; sub.deliveryEventIds = []; }
        else sub.deliveryEventIds = remainingReceipt;
      }
      return removed;
    });
    await this.deliverPending(); return n;
  }

  start(): void { if (!this.stopped) return; this.stopped = false; this.generation++; this.schedule(0); this.trackReceiptFlush(); }
  async stop(): Promise<void> {
    this.stopped = true; this.generation++;
    if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined;
    if (this.receiptRetryTimer !== undefined) this.clearTimer(this.receiptRetryTimer); this.receiptRetryTimer = undefined;
    for (const c of this.controllers.values()) c.abort(new Error("Forge watcher stopped"));
    let timeout: unknown;
    const drain = (async () => {
      await Promise.allSettled([...this.deliveryWork, ...this.pollWork]);
      await this.flushPendingReceipts();
    })();
    const shutdownBudget = this.opts.shutdownTimeoutMs ?? 2_000;
    const deadline = new Promise<void>((resolve) => { timeout = this.setTimer(resolve, Number.isFinite(shutdownBudget) ? Math.max(1, Math.min(30_000, shutdownBudget)) : 2_000); });
    await Promise.race([drain, deadline]);
    if (timeout !== undefined) this.clearTimer(timeout);
    if (this.pendingReceipts.size) {
      const error = new Error(`Forge watcher stopped with ${this.pendingReceipts.size} accepted receipt(s) not persisted; stable batch tokens retained for recovery`);
      this.report(error); for (const receipt of this.pendingReceipts.values()) for (const id of receipt.ids) this.receiptErrors.set(id, this.receiptErrors.get(id) ?? error.message);
    }
  }
  async close(): Promise<void> { await this.stop(); }
  private schedule(delay: number): void { if (this.stopped) return; if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = this.setTimer(() => { this.timer = undefined; void this.tick().catch((e) => { this.report(e); this.schedule(this.retryDelay(1000)); }); }, Math.max(0, delay)); }

  async pollOnce(target?: ForgeTarget): Promise<void> { const generation = this.generation; await this.pollDue(target, false); if (generation === this.generation) await this.deliverPending(); }
  private async pollDue(target: ForgeTarget | undefined, dueOnly: boolean): Promise<void> {
    const state = await this.update((s) => structuredClone(s));
    const limit = Math.max(1, this.opts.maxConcurrency ?? 3), generation = this.generation;
    const activeKeys = new Set(Object.values(state.subscriptions).filter((sub) => sub.active).map((sub) => keyFor(sub.target)));
    const due = Object.entries(state.targets).filter(([key, t]) => activeKeys.has(key) && (!target || key === keyFor(target)) && (!dueOnly || t.nextPollAt <= this.now()));
    const attempted = new Set<string>();
    while (generation === this.generation) {
      const slots = Math.max(0, limit - this.inFlight.size);
      const selected = due.filter(([key]) => !attempted.has(key) && !this.inFlight.has(key)).slice(0, slots);
      if (!selected.length) break;
      for (const [key] of selected) { attempted.add(key); this.inFlight.add(key); }
      const tasks = selected.map(([key, record]) => this.pollTarget(key, record.target, generation));
      for (const task of tasks) this.pollWork.add(task);
      await Promise.allSettled(tasks);
      for (const task of tasks) this.pollWork.delete(task);
    }
  }
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    await this.pollDue(undefined, true);
    if (this.stopped || generation !== this.generation) return;
    await this.deliverPending();
    if (this.stopped || generation !== this.generation) return;
    const latest = await this.update((s) => structuredClone(s));
    const activeKeys = new Set(Object.values(latest.subscriptions).filter((sub) => sub.active).map((sub) => keyFor(sub.target)));
    const deadlines = Object.entries(latest.targets).filter(([key]) => activeKeys.has(key)).map(([, t]) => t.nextPollAt);
    if (this.opts.inactiveTtlMs !== undefined) deadlines.push(...Object.values(latest.subscriptions).filter((sub) => !sub.active).map((sub) => (sub.updatedAt ?? sub.createdAt ?? this.now()) + this.opts.inactiveTtlMs!));
    if (!deadlines.length) { if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; return; }
    this.schedule(Math.max(100, Math.min(...deadlines) - this.now()));
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
            const fingerprint = eventFingerprint(category, change);
            if (queue.some((event) => event.category === category && event.fingerprint === fingerprint)) continue;
            const globalLimit = this.opts.maxQueueEvents ?? 10_000;
            if (queue.length >= (this.opts.maxEventsPerSubscription ?? 100) || Object.values(state.queues).reduce((n, q) => n + q.length, 0) >= globalLimit) { sub.overflow = `Event queue retention limit exceeded (${globalLimit} total events maximum)`; continue; }
            if (queue.length === 0) sub.deliveryNotified = false;
            queue.push({ id: String(state.nextEvent++), target, category, fingerprint, at: this.now() });
          }
        }
      });
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
  private async recoverForeignClaims(generation: number): Promise<Set<string>> {
    const blocked = new Set<string>();
    const snapshot = await this.update((state) => structuredClone(state));
    const byToken = new Map<string, { identity: ForgeIdentity; owner: string; ids: string[]; token: string }>();
    for (const sub of Object.values(snapshot.subscriptions)) {
      if (!sub.deliveryClaim) continue;
      // An abandoned own-runtime claim (e.g. rejected send plus failed rollback)
      // needs the same authoritative recovery as a prior process. Never race an
      // active send or an accepted receipt still pending persistence.
      if (sub.deliveryClaimOwner === this.runtimeId && (this.wakePending.has(sub.id) || this.pendingReceipts.has(sub.deliveryClaim))) continue;
      const owner = sub.deliveryClaimOwner ?? "legacy-unknown", token = sub.deliveryClaim, key = `${identityKey(sub.identity)}\0${owner}\0${token}`;
      const group = byToken.get(key) ?? { identity: sub.identity, owner, ids: [], token }; group.ids.push(sub.id); byToken.set(key, group);
    }
    for (const group of byToken.values()) {
      if (generation !== this.generation) return blocked;
      if (!this.opts.recoverDelivery) { blocked.add(identityKey(group.identity)); this.markRecoveryUnknown(group.ids, "Foreign forge delivery claim remains fail-closed: no recoverDelivery callback configured"); continue; }
      let recorded: boolean | undefined;
      try { recorded = await this.opts.recoverDelivery(group.identity, group.token); }
      catch (error) { blocked.add(identityKey(group.identity)); this.markRecoveryUnknown(group.ids, `Foreign forge delivery recovery failed: ${errorOf(error).message}`); continue; }
      if (generation !== this.generation) return blocked;
      if (recorded === undefined) { blocked.add(identityKey(group.identity)); this.markRecoveryUnknown(group.ids, "Foreign forge delivery claim remains unknown; delivery is paused fail-closed"); continue; }
      if (!recorded) {
        await this.update((state) => { for (const id of group.ids) { const sub = state.subscriptions[id]; if (sub?.deliveryClaim === group.token && sub.deliveryClaimOwner === group.owner) { sub.deliveryClaim = undefined; sub.deliveryClaimOwner = undefined; sub.deliveryClaimEventIds = undefined; } } });
        for (const id of group.ids) this.receiptErrors.delete(id);
        continue;
      }
      const receipt = { ids: group.ids, token: group.token, owner: group.owner };
      this.pendingReceipts.set(group.token, receipt);
      if (!await this.persistAcceptedReceipt(receipt)) blocked.add(identityKey(group.identity));
    }
    return blocked;
  }
  private markRecoveryUnknown(ids: string[], message: string): void {
    for (const id of ids) this.receiptErrors.set(id, message);
    this.report(new Error(message));
  }
  private async deliverPending(): Promise<void> {
    if (!this.opts.wake) return;
    const generation = this.generation;
    const blockedIdentities = await this.recoverForeignClaims(generation);
    const snapshot = await this.update((s) => structuredClone(s));
    const groups = new Map<string, { identity: ForgeIdentity; ids: string[]; events: ForgeEvent[]; eventIdsBySubscription: Record<string, string[]> }>();
    for (const sub of Object.values(snapshot.subscriptions)) {
      const queue = snapshot.queues[sub.id] ?? [];
      if (!sub.active || !queue.length || sub.deliveryNotified || sub.deliveryClaim || blockedIdentities.has(identityKey(sub.identity)) || this.wakePending.has(sub.id) || this.opts.isEligible?.(sub.identity) === false) continue;
      const key = identityKey(sub.identity), group = groups.get(key) ?? { identity: sub.identity, ids: [], events: [], eventIdsBySubscription: {} };
      group.ids.push(sub.id); group.events.push(...queue); group.eventIdsBySubscription[sub.id] = queue.map((event) => event.id); groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (generation !== this.generation || this.opts.isEligible?.(group.identity) === false) return;
      const events = [...new Map(group.events.map((e) => [e.id, e])).values()].sort((a, b) => Number(a.id) - Number(b.id));
      const token = `forge-watch:${group.ids.sort().join("|")}:${events.map((e) => e.id).join(",")}`;
      for (const id of group.ids) this.wakePending.add(id);
      const work = this.sendBatch(group.identity, group.ids, events, group.eventIdsBySubscription, token, generation);
      this.deliveryWork.add(work);
      let accepted = false;
      try { accepted = await work; }
      finally { this.deliveryWork.delete(work); for (const id of group.ids) this.wakePending.delete(id); }
      if (accepted && generation === this.generation) await this.deliverPending();
    }
  }
  private async sendBatch(identity: ForgeIdentity, ids: string[], events: ForgeEvent[], eventIdsBySubscription: Record<string, string[]>, token: string, generation: number): Promise<boolean> {
    let claimed = false;
    try {
      claimed = await this.update((current) => {
        if (generation !== this.generation || this.opts.isEligible?.(identity) === false) return false;
        for (const id of ids) {
          const sub = current.subscriptions[id];
          if (!sub || !sub.active || sub.deliveryNotified || sub.deliveryClaim || !(current.queues[id]?.length)) return false;
        }
        for (const id of ids) { current.subscriptions[id]!.deliveryClaim = token; current.subscriptions[id]!.deliveryClaimOwner = this.runtimeId; current.subscriptions[id]!.deliveryClaimEventIds = eventIdsBySubscription[id] ?? []; }
        return true;
      });
    } catch (error) { this.report(error); return false; }
    if (!claimed) return false;
    if (generation !== this.generation || this.opts.isEligible?.(identity) === false) { await this.rollbackClaim(ids, token); return false; }
    try { await this.opts.wake!(identity, events, token); }
    catch (error) { this.report(error); await this.rollbackClaim(ids, token); return false; }
    // Once wake accepts, never resend: retain an in-memory receipt for bounded persistence retries.
    this.pendingReceipts.set(token, { ids, token });
    await this.persistAcceptedReceipt({ ids, token });
    return generation === this.generation;
  }
  private async persistAcceptedReceipt(receipt: { ids: string[]; token: string; owner?: string }): Promise<boolean> {
    try {
      await this.update((current) => {
        for (const id of receipt.ids) {
          const sub = current.subscriptions[id];
          if (sub?.deliveryClaim === receipt.token && sub.deliveryClaimOwner === (receipt.owner ?? this.runtimeId)) {
            sub.deliveryClaim = undefined; sub.deliveryClaimOwner = undefined; sub.deliveryToken = receipt.token;
            const queuedIds = new Set((current.queues[id] ?? []).map((event) => event.id));
            sub.deliveryEventIds = (sub.deliveryClaimEventIds ?? []).filter((eventId) => queuedIds.has(eventId)); sub.deliveryClaimEventIds = undefined;
            sub.deliveryNotified = sub.deliveryEventIds.length > 0; sub.deliveryError = undefined;
          } else if (sub?.deliveryNotified && sub.deliveryToken === receipt.token) {
            // Idempotent after an adapter that committed before reporting an error.
          }
        }
      });
      this.pendingReceipts.delete(receipt.token);
      for (const id of receipt.ids) this.receiptErrors.delete(id);
      return true;
    } catch (error) {
      const message = `Accepted forge wake receipt persistence failed: ${errorOf(error).message}`;
      this.report(new Error(message)); for (const id of receipt.ids) this.receiptErrors.set(id, message);
      this.scheduleReceiptRetry();
      return false;
    }
  }
  private trackReceiptFlush(): void {
    // Detached startup/retry work must handle rejection as well as cleanup.
    // A failed wake followed by a failed rollback is reported, never unhandled.
    const task = this.flushPendingReceipts().catch((error) => { this.report(error); });
    this.deliveryWork.add(task);
    void task.then(() => { this.deliveryWork.delete(task); });
  }
  private scheduleReceiptRetry(): void {
    if (this.stopped || this.receiptRetryTimer !== undefined || !this.pendingReceipts.size) return;
    const delay = this.retryDelay(1000);
    this.receiptRetryTimer = this.setTimer(() => { this.receiptRetryTimer = undefined; this.trackReceiptFlush(); }, delay);
  }
  private async flushPendingReceipts(): Promise<void> {
    for (const receipt of [...this.pendingReceipts.values()]) await this.persistAcceptedReceipt(receipt);
    if (!this.stopped && this.pendingReceipts.size === 0) await this.deliverPending();
  }
  private async rollbackClaim(ids: string[], token: string): Promise<void> {
    await this.update((state) => { for (const id of ids) { const sub = state.subscriptions[id]; if (sub?.deliveryClaim === token && sub.deliveryClaimOwner === this.runtimeId) { sub.deliveryClaim = undefined; sub.deliveryClaimOwner = undefined; sub.deliveryClaimEventIds = undefined; } } });
  }
}

function changes(before: ForgeSnapshot, after: ForgeSnapshot, category: ForgeCategory): Array<{ fingerprint: string; actor?: string; itemId?: string }> {
  if (category === "head" || category === "state") { const a = before[category], b = after[category]; return a === b ? [] : [{ fingerprint: `${a}->${b}` }]; }
  const old = new Map(before[category].map((item) => [item.id, item])), current = new Map(after[category].map((item) => [item.id, item]));
  const result: Array<{ fingerprint: string; actor?: string; itemId?: string }> = [];
  for (const item of after[category]) { const prior = old.get(item.id); if (!prior || prior.fingerprint !== item.fingerprint) result.push({ itemId: item.id, fingerprint: item.fingerprint, actor: item.actor }); }
  for (const item of before[category]) if (!current.has(item.id)) result.push({ itemId: item.id, fingerprint: `removed:${item.fingerprint}`, actor: item.actor });
  return result;
}
function eventFingerprint(category: ForgeCategory, change: { fingerprint: string; itemId?: string }): string {
  return category === "head" || category === "state" ? `${category}:${change.fingerprint}` : `${category}:${encodeURIComponent(change.itemId ?? "")}:${change.fingerprint}`;
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
function migrateState(state: ForgeWatchState, opts: ForgeWatchOptions, now: number, runtimeId: string): void {
  if (!state || (state.version !== 1 && state.version !== 2) || !state.subscriptions) return;
  for (const sub of Object.values(state.subscriptions)) { sub.createdAt ??= now; sub.updatedAt ??= sub.createdAt; }
  void runtimeId;
  expireInactive(state, opts, now);
}
function expireInactive(state: ForgeWatchState, opts: ForgeWatchOptions, now: number): void {
  const ttl = opts.inactiveTtlMs;
  if (ttl !== undefined && Number.isFinite(ttl) && ttl >= 0) for (const [id, sub] of Object.entries(state.subscriptions)) if (!sub.active && now - (sub.updatedAt ?? sub.createdAt ?? now) >= ttl) { delete state.subscriptions[id]; delete state.queues[id]; }
  const retained = new Set(Object.values(state.subscriptions).map((sub) => keyFor(sub.target)));
  for (const key of Object.keys(state.targets)) if (!retained.has(key)) delete state.targets[key];
}
function validateState(state: ForgeWatchState, opts: ForgeWatchOptions): void {
  if (!state || state.version !== 1 || !state.targets || !state.subscriptions || !state.queues || !Number.isSafeInteger(state.nextEvent) || state.nextEvent < 1) throw new Error("Invalid persisted forge watch state");
  if (Object.keys(state.targets).length > (opts.maxTargets ?? 256) || Object.keys(state.subscriptions).length > (opts.maxSubscriptions ?? 512)) throw new Error("Persisted forge watch state exceeds retention limits");
  for (const [id, sub] of Object.entries(state.subscriptions)) { validateIdentity(sub.identity); validateTarget(sub.target); if (id !== sub.id || id !== subscriptionId(sub.identity, sub.target) || (sub.createdAt !== undefined && !Number.isFinite(sub.createdAt)) || (sub.updatedAt !== undefined && !Number.isFinite(sub.updatedAt)) || (sub.deliveryNotified !== undefined && typeof sub.deliveryNotified !== "boolean") || (sub.deliveryClaim !== undefined && typeof sub.deliveryClaim !== "string") || (sub.deliveryClaimOwner !== undefined && typeof sub.deliveryClaimOwner !== "string") || (sub.deliveryClaimEventIds !== undefined && (!Array.isArray(sub.deliveryClaimEventIds) || sub.deliveryClaimEventIds.some((eventId) => typeof eventId !== "string"))) || (sub.deliveryEventIds !== undefined && (!Array.isArray(sub.deliveryEventIds) || sub.deliveryEventIds.some((eventId) => typeof eventId !== "string"))) || !Array.isArray(sub.categories) || sub.categories.some((c) => !categories.includes(c)) || !Array.isArray(sub.ignoreActors)) throw new Error("Invalid persisted forge subscription"); }
  const maxQueue = opts.maxEventsPerSubscription ?? 100;
  for (const [id, queue] of Object.entries(state.queues)) if (!state.subscriptions[id] || !Array.isArray(queue) || queue.length > maxQueue || queue.some((e) => !e || typeof e.id !== "string" || !categories.includes(e.category) || typeof e.fingerprint !== "string" || !Number.isFinite(e.at))) throw new Error("Invalid or oversized persisted forge event queue");
  if (Object.values(state.queues).reduce((n, q) => n + q.length, 0) > (opts.maxQueueEvents ?? 10_000)) throw new Error("Persisted forge queues exceed retention limit");
  for (const t of Object.values(state.targets)) { validateTarget(t.target); if (!Number.isFinite(t.nextPollAt) || !Number.isSafeInteger(t.retryCount) || t.retryCount < 0) throw new Error("Invalid persisted forge target state"); if (t.baseline) validateSnapshot(t.baseline, opts); }
}
