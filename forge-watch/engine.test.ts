import { describe, expect, test } from "bun:test";
import { ForgeWatchEngine } from "./engine.ts";
import { parseTarget, type ForgeEvent, type ForgeSnapshot, type ForgeWatchState } from "./types.ts";
const target = parseTarget("https://github.com/acme/repo/pull/7");
const target2 = parseTarget("https://github.com/acme/other/pull/8");
const identity = (goalId = "one") => ({ sessionId: "session", goalId, activationId: "activation" });
const snap = (head = "a", comment = "c1"): ForgeSnapshot => ({ head, state: "open", comments: [{ id: comment, fingerprint: comment, actor: "reviewer" }], reviews: [], ci: [] });
class Memory {
  state: ForgeWatchState = { version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 };
  async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> { return mutate(this.state); }
}
const setup = (options: { eligible?: boolean; maxEventsPerSubscription?: number; fail?: boolean; maxConcurrency?: number } = {}) => {
  const storage = new Memory(); let snapshot = snap(); let polls = 0; let wakes = 0;
  const engine = new ForgeWatchEngine({ storage, adapter: { async poll() { polls++; if (options.fail) throw Object.assign(new Error("rate limited"), { retryAfterMs: 5000 }); return snapshot; } }, wake: () => { wakes++; }, isEligible: () => options.eligible ?? true, now: () => 100, intervalMs: 10, maxEventsPerSubscription: options.maxEventsPerSubscription, maxConcurrency: options.maxConcurrency, jitter: (d) => d });
  return { engine, storage, set snapshot(value: ForgeSnapshot) { snapshot = value; }, incrementWakes: () => { wakes++; }, get polls() { return polls; }, get wakes() { return wakes; } };
}

describe("forge watch engine", () => {
  test("parses canonical URLs, encoded project names and rejects ambiguous provider/host paths", () => {
    expect(parseTarget("https://gitlab.com/group/sub/project/-/merge_requests/2").project).toBe("group/sub/project");
    expect(parseTarget("https://git.example.test/org/my%20repo/-/merge_requests/4", ["git.example.test"]).project).toBe("org/my repo");
    expect(parseTarget("https://github.com/acme/my%20repo/pull/5").url).toBe("https://github.com/acme/my%20repo/pull/5");
    expect(() => parseTarget("https://github.com/group/project/-/merge_requests/2")).toThrow();
    expect(() => parseTarget("https://gitlab.com/group/project/pull/2")).toThrow();
    expect(() => parseTarget("https://gitlab.com/group%2Fother/project/-/merge_requests/2")).toThrow();
    expect(() => parseTarget("http://github.com/a/b/pull/1")).toThrow();
  });
  test("baseline emits no flood; unchanged snapshots do not wake; a relevant change emits once", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() });
    await f.engine.pollOnce(target); expect(f.wakes).toBe(0);
    await f.engine.pollOnce(target); expect(f.wakes).toBe(0);
    f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target); expect(f.wakes).toBe(1);
    expect((await f.engine.events(identity())).map((e) => e.category)).toEqual(["head", "comments", "comments"]);
    await f.engine.pollOnce(target); expect(f.wakes).toBe(1);
    expect(await f.engine.ack(identity(), ["1", "2", "3"])).toBe(3);
    f.snapshot = snap("c", "c3"); await f.engine.pollOnce(target); expect(f.wakes).toBe(2);
  });
  test("same identity may watch multiple targets; identity methods aggregate and scoped unwatch prunes orphan target", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.watch({ target: target2, identity: identity() });
    expect((await f.engine.status(identity())).length).toBe(2);
    await f.engine.pollOnce(target); await f.engine.pollOnce(target2); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target); await f.engine.pollOnce(target2);
    expect((await f.engine.events(identity())).length).toBe(6);
    await f.engine.unwatch(identity(), target); expect((await f.engine.status(identity())).length).toBe(1);
    expect(Object.keys(f.storage.state.targets)).toEqual([`${target2.provider}:${target2.host}/${target2.project}#${target2.number}`]);
    expect(await f.engine.unwatch(identity())).toBe(true); expect(Object.keys(f.storage.state.targets)).toHaveLength(0);
  });
  test("deletions, review revocations and CI removal are diffed; ignores only suppress comment/review", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity(), ignoreActors: ["bot"] });
    const initial: ForgeSnapshot = { head: "a", state: "open", comments: [{ id: "c", fingerprint: "comment", actor: "bot" }], reviews: [{ id: "r", fingerprint: "approved", actor: "bot" }], ci: [{ id: "ci", fingerprint: "success", actor: "bot" }] };
    f.snapshot = initial; await f.engine.pollOnce(target);
    f.snapshot = { head: "a", state: "open", comments: [], reviews: [{ id: "r", fingerprint: "revoked", actor: "bot" }], ci: [] }; await f.engine.pollOnce(target);
    const events = await f.engine.events(identity());
    expect(events.map((e) => e.category)).toEqual(["ci"]);
    expect(events[0]?.fingerprint).toContain("removed:success");
    const f2 = setup(); await f2.engine.watch({ target, identity: identity(), ignoreActors: ["bot"] });
    f2.snapshot = initial; await f2.engine.pollOnce(target);
    f2.snapshot = { head: "b", state: "open", comments: [], reviews: [], ci: [] }; await f2.engine.pollOnce(target);
    expect((await f2.engine.events(identity())).map((e) => e.category).sort()).toEqual(["ci", "head"]);
  });
  test("equal fingerprints on different stable IDs remain distinct events", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target);
    f.snapshot = { head: "a", state: "open", comments: [{ id: "a", fingerprint: "same" }, { id: "b", fingerprint: "same" }], reviews: [], ci: [] }; await f.engine.pollOnce(target);
    const commentEvents = (await f.engine.events(identity())).filter((e) => e.category === "comments");
    expect(commentEvents.filter((e) => e.fingerprint.includes(":same")).map((e) => e.fingerprint)).toHaveLength(2);
    expect(new Set(commentEvents.map((e) => e.fingerprint)).size).toBe(3);
  });
  test("one identity with pending events on multiple targets receives one combined wake batch", async () => {
    const storage = new Memory(), snapshots = new Map([[target.url, snap()], [target2.url, snap()]]); let wakes: ForgeEvent[][] = [];
    const engine = new ForgeWatchEngine({ storage, maxConcurrency: 2, adapter: { poll: async (t) => snapshots.get(t.url)! }, wake: (_i, events) => { wakes.push(events); } });
    await engine.watch({ target, identity: identity() }); await engine.watch({ target: target2, identity: identity() }); await engine.pollOnce();
    snapshots.set(target.url, snap("b", "c2")); snapshots.set(target2.url, snap("b", "c2")); await engine.pollOnce();
    expect(wakes).toHaveLength(1); expect(new Set(wakes[0]!.map((e) => e.target.url))).toEqual(new Set([target.url, target2.url]));
    const firstTargetIds = wakes[0]!.filter((e) => e.target.url === target.url).map((e) => e.id);
    expect(await engine.ack(identity(), firstTargetIds)).toBe(firstTargetIds.length); expect(wakes).toHaveLength(1);
    snapshots.set(target.url, snap("c", "c3")); await engine.pollOnce(target);
    expect(wakes).toHaveLength(2); expect(wakes[1]!.every((event) => event.target.url === target.url)).toBe(true);
  });
  test("stop drains an unsent durable claim so replacement runtime sends it once", async () => {
    const storage = new Memory(); let snapshot = snap(), claimReached!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { claimReached = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    let pauseClaim = false, wakes = 0;
    const blockingStorage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> {
      const result = mutate(storage.state);
      if (pauseClaim && Object.values(storage.state.subscriptions).some((sub) => !!sub.deliveryClaim)) { pauseClaim = false; claimReached(); await gate; }
      return result;
    } };
    const first = new ForgeWatchEngine({ storage: blockingStorage, adapter: { poll: async () => snapshot }, wake: () => { wakes++; } });
    await first.watch({ target, identity: identity() }); await first.pollOnce(target); snapshot = snap("b", "c2"); pauseClaim = true;
    const poll = first.pollOnce(target); await reached; const stopping = first.stop(); release(); await stopping; await poll;
    expect(Object.values(storage.state.subscriptions)[0]?.deliveryClaim).toBeUndefined();
    const replacement = new ForgeWatchEngine({ storage: blockingStorage, adapter: { poll: async () => snapshot }, wake: () => { wakes++; } });
    await replacement.pollOnce(target); expect(wakes).toBe(1); await replacement.pollOnce(target); expect(wakes).toBe(1);
  });
  test("partial acknowledgement releases newer unnotified events only after covered batch is fully acked", async () => {
    const storage = new Memory(); let snapshot = snap(), wakes = 0;
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, wake: () => { wakes++; } });
    await engine.watch({ target, identity: identity() }); await engine.pollOnce(target); snapshot = snap("b", "c2"); await engine.pollOnce(target); expect(wakes).toBe(1);
    const firstBatch = await engine.events(identity()); expect(firstBatch).toHaveLength(3);
    snapshot = snap("c", "c3"); await engine.pollOnce(target); expect(wakes).toBe(1);
    expect(await engine.ack(identity(), [firstBatch[0]!.id])).toBe(1); expect(wakes).toBe(1);
    expect(await engine.ack(identity(), firstBatch.slice(1).map((e) => e.id))).toBe(2); expect(wakes).toBe(2);
    expect((await engine.events(identity())).length).toBe(3);
  });
  test("receipt write failure retries persistence without resending accepted wake", async () => {
    const base = new Memory(); let failed = false, wakes = 0;
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> {
      const draft = structuredClone(base.state), result = mutate(draft);
      const accepted = Object.values(draft.subscriptions).some((s) => s.deliveryNotified && !!s.deliveryToken);
      if (accepted && !failed) { failed = true; throw new Error("receipt commit failed"); }
      base.state = draft; return result;
    } };
    let snapshot = snap();
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, wake: () => { wakes++; }, setTimer: (cb) => setTimeout(cb, 0), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), jitter: () => 100 }); await engine.watch({ target, identity: identity() }); await engine.pollOnce(target); snapshot = snap("b", "c2"); await engine.pollOnce(target);
    expect(failed).toBe(true); expect(wakes).toBe(1); await engine.stop(); expect((await engine.status(identity()))[0]?.subscription.deliveryNotified).toBe(true);
  });
  test("ack and a newer poll during receipt retry release only the newer batch after commit", async () => {
    const base = new Memory(); let snapshot = snap(), failReceipt = false, failedReceipt!: () => void, wakeEvents: ForgeEvent[][] = [];
    const failed = new Promise<void>((resolve) => { failedReceipt = resolve; }); let retryCallback: (() => void) | undefined;
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> {
      const draft = structuredClone(base.state), result = mutate(draft);
      const receipt = Object.values(draft.subscriptions).some((s) => s.deliveryNotified && !!s.deliveryToken);
      if (failReceipt && receipt) { failReceipt = false; failedReceipt(); throw new Error("receipt commit failed before transaction commit"); }
      base.state = draft; return result;
    } };
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, wake: (_i, events) => { wakeEvents.push(events); }, setTimer: (cb, delay) => { if (delay > 0 && delay < 1000) retryCallback = cb; return 1; }, clearTimer: () => {}, jitter: () => 100 });
    await engine.watch({ target, identity: identity() }); await engine.pollOnce(target); engine.start(); snapshot = snap("b", "c2"); failReceipt = true;
    const firstPoll = engine.pollOnce(target); await failed;
    const acceptedIds = wakeEvents[0]!.map((event) => event.id); expect(wakeEvents).toHaveLength(1);
    expect(await engine.ack(identity(), acceptedIds)).toBe(3);
    snapshot = snap("c", "c3"); await engine.pollOnce(target);
    retryCallback!(); await firstPoll;
    while (wakeEvents.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wakeEvents).toHaveLength(2); expect(wakeEvents[1]!.map((event) => event.category).sort()).toEqual(["comments", "comments", "head"]);
    await engine.stop();
  });
  test("persistent receipt failures keep accepted claim and stop returns within finite budget", async () => {
    const base = new Memory(); let failing = true, failures = 0, wakes = 0, snapshot = snap();
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> {
      const draft = structuredClone(base.state), result = mutate(draft);
      if (failing && Object.values(draft.subscriptions).some((s) => s.deliveryNotified && !!s.deliveryToken)) { failures++; throw new Error("persistent receipt outage"); }
      base.state = draft; return result;
    } };
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, wake: () => { wakes++; }, setTimer: (cb) => setTimeout(cb, 0), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), jitter: () => 100 });
    await engine.watch({ target, identity: identity() }); await engine.pollOnce(target); snapshot = snap("b", "c2");
    const polling = engine.pollOnce(target); await polling;
    expect(failures).toBe(1); expect((await engine.status(identity()))[0]?.deliveryError).toContain("persistent receipt outage");
    await Promise.race([engine.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error("stop exceeded finite budget")), 100))]);
    expect(failures).toBe(2); expect(wakes).toBe(1); expect((await engine.status(identity()))[0]?.deliveryError).toContain("persistent receipt outage");
    const sub = Object.values(base.state.subscriptions)[0]!; expect(sub.deliveryClaim).toBeTruthy(); expect(sub.deliveryNotified).toBe(false);
  });
  test("restart reconciles recorded delivery before sending only newer queued events", async () => {
    const base = new Memory(); let snapshot = snap(), failReceipt = false, delivered: ForgeEvent[][] = [];
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> {
      const draft = structuredClone(base.state), result = mutate(draft);
      if (failReceipt && Object.values(draft.subscriptions).some((s) => s.deliveryNotified && !!s.deliveryToken)) throw new Error("receipt disk failure");
      base.state = draft; return result;
    } };
    const first = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, wake: (_i, events) => { delivered.push(events); } });
    await first.watch({ target, identity: identity() }); await first.pollOnce(target); snapshot = snap("b", "c2"); failReceipt = true; await first.pollOnce(target);
    const oldIds = (await first.events(identity())).map((event) => event.id); expect(delivered).toHaveLength(1);
    await first.ack(identity(), oldIds); snapshot = snap("c", "c3"); await first.pollOnce(target); await first.stop();
    failReceipt = false;
    const replacement = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, recoverDelivery: (_identity, token) => token.startsWith("forge-watch:"), wake: (_i, events) => { delivered.push(events); } });
    await replacement.pollOnce(target);
    expect(delivered).toHaveLength(2); expect(delivered[1]!.every((event) => !oldIds.includes(event.id))).toBe(true);
    expect((await replacement.status(identity()))[0]?.subscription.deliveryNotified).toBe(true); await replacement.stop();
  });
  test("foreign claim confirmed unsent is cleared and delivered exactly once", async () => {
    const storage = new Memory(); const first = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() } });
    await first.watch({ target, identity: identity() }); await first.pollOnce(target);
    const sub = Object.values(storage.state.subscriptions)[0]!; storage.state.queues[sub.id]!.push({ id: "99", target, category: "head", fingerprint: "head:a->b", at: 2 }); storage.state.nextEvent = 100;
    sub.deliveryClaim = "old-token"; sub.deliveryClaimOwner = "old-runtime"; sub.deliveryClaimEventIds = ["99"];
    let wakes = 0; const replacement = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() }, recoverDelivery: () => false, wake: () => { wakes++; } });
    await replacement.pollOnce(target); expect(wakes).toBe(1); expect((await replacement.events(identity())).some((event) => event.id === "99")).toBe(true); await replacement.stop();
  });
  test("unknown foreign claim fails closed and blocks sibling targets", async () => {
    const storage = new Memory(), first = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() } });
    await first.watch({ target, identity: identity() }); await first.watch({ target: target2, identity: identity() }); await first.pollOnce();
    for (const sub of Object.values(storage.state.subscriptions)) storage.state.queues[sub.id]!.push({ id: String(storage.state.nextEvent++), target: sub.target, category: "head", fingerprint: "head:a->b", at: 2 });
    const claimed = Object.values(storage.state.subscriptions).find((sub) => sub.target.url === target.url)!; claimed.deliveryClaim = "unknown-token"; claimed.deliveryClaimOwner = "old-runtime"; claimed.deliveryClaimEventIds = [storage.state.queues[claimed.id]![0]!.id];
    let wakes = 0, errors = 0; const replacement = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() }, onError: () => { errors++; }, wake: () => { wakes++; } });
    await replacement.pollOnce(); expect(wakes).toBe(0); expect(errors).toBeGreaterThan(0); expect((await replacement.status(identity())).some((status) => status.deliveryError?.includes("fail-closed"))).toBe(true); await replacement.stop();
  });
  test("accepted delivery receipt survives eligibility clearing after send", async () => {
    const storage = new Memory(); let eligible = true, wakeCount = 0, snapshot = snap();
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snapshot }, isEligible: () => eligible, wake: () => { wakeCount++; eligible = false; } });
    await engine.watch({ target, identity: identity() }); await engine.pollOnce(target); snapshot = snap("b", "c2"); await engine.pollOnce(target);
    eligible = true; await engine.pollOnce(target); expect(wakeCount).toBe(1);
    expect((await engine.status(identity()))[0]?.subscription.deliveryNotified).toBe(true);
  });
  test("setActive pauses network polling while retaining queued events and resumes explicitly", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    expect(await f.engine.setActive(identity(), false)).toBe(1); const polls = f.polls; f.snapshot = snap("c", "c3"); await f.engine.pollOnce(target);
    expect(f.polls).toBe(polls); expect((await f.engine.events(identity())).length).toBe(3);
    expect(await f.engine.setActive(identity(), true)).toBe(1); await f.engine.pollOnce(target); expect(f.polls).toBe(polls + 1);
  });
  test("inactive subscriptions expire only when configured; old persisted records migrate timestamps", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.setActive(identity(), false);
    delete f.storage.state.subscriptions[Object.keys(f.storage.state.subscriptions)[0]!]!.createdAt;
    delete f.storage.state.subscriptions[Object.keys(f.storage.state.subscriptions)[0]!]!.updatedAt;
    const noTtl = new ForgeWatchEngine({ storage: f.storage, now: () => 100_000 }); expect((await noTtl.status()).length).toBe(1);
    expect(Number.isFinite(Object.values(f.storage.state.subscriptions)[0]?.createdAt)).toBe(true);
    const expired = new ForgeWatchEngine({ storage: f.storage, now: () => 100_002, inactiveTtlMs: 1 }); expect((await expired.status()).length).toBe(0);
    expect(Object.keys(f.storage.state.targets)).toHaveLength(0);
  });
  test("inactive or ineligible identities retain events without waking", async () => {
    const f = setup({ eligible: false }); await f.engine.watch({ target, identity: identity("one") }); await f.engine.watch({ target, identity: identity("two"), active: false });
    await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target); expect(f.wakes).toBe(0);
    expect((await f.engine.events(identity("two"))).length).toBe(3);
  });
  test("accepted batches survive reload without repeat wakes; consume resets delivery latch", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    let reloadSnapshot = snap("b", "c2"); const reloaded = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: async () => reloadSnapshot }, wake: () => { f.incrementWakes(); } });
    await reloaded.pollOnce(target); expect(f.wakes).toBe(1);
    expect((await reloaded.events(identity(), true)).length).toBe(3);
    expect((await reloaded.status(identity()))[0]?.subscription.deliveryNotified).toBe(false);
    reloadSnapshot = snap("c", "c3"); await reloaded.pollOnce(target); expect((await reloaded.events(identity())).length).toBe(3);
  });
  test("overflow is visible and queues survive reload", async () => {
    const f = setup({ maxEventsPerSubscription: 1 }); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target);
    f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    expect((await f.engine.status(identity()))[0]?.subscription.overflow).toContain("limit");
    const reloaded = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: async () => snap() } }); expect((await reloaded.events(identity())).length).toBe(1);
  });
  test("rate-limit failures preserve status, callback and Retry-After lower bound", async () => {
    let reported = ""; const storage = new Memory(); const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => { throw Object.assign(new Error("rate limited"), { retryAfterMs: 5000 }); } }, now: () => 100, onError: (e) => { reported = e.message; }, jitter: (d) => d });
    await engine.watch({ target, identity: identity() }); await engine.pollOnce(target);
    const status = await engine.status(identity()); expect(status[0]?.lastError).toBe("rate limited"); expect(status[0]?.nextPollAt).toBe(5100); expect(reported).toBe("rate limited");
  });
  test("unwatch clears orphan targets and reload rejects invalid persisted state", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.unwatch(identity()); expect(Object.keys(f.storage.state.targets)).toHaveLength(0);
    f.storage.state.version = 7 as 1; await expect(f.engine.status()).rejects.toThrow("Invalid persisted forge watch state");
  });
  test("global concurrency cap applies across overlapping pollOnce calls", async () => {
    const f = setup({ maxConcurrency: 1 }); let active = 0, peak = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = new ForgeWatchEngine({ storage: f.storage, maxConcurrency: 1, adapter: { async poll() { active++; peak = Math.max(peak, active); await gate; active--; return snap(); } } });
    await engine.watch({ target, identity: identity() }); await engine.watch({ target: target2, identity: identity() });
    const one = engine.pollOnce(); const two = engine.pollOnce(); await new Promise((r) => setTimeout(r, 0)); expect(peak).toBe(1); release(); await Promise.all([one, two]);
  });
  test("a started engine with no active targets stops scheduling itself", async () => {
    const timers: Array<() => void> = [], storage = new Memory(); let polls = 0;
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => { polls++; return snap(); } }, setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {} });
    engine.start(); timers.shift()!(); await new Promise((r) => setTimeout(r, 0));
    expect(polls).toBe(0); expect(timers).toHaveLength(0); await engine.stop();
  });
  test("scheduled storage failures are reported and schedule bounded retry rather than dying", async () => {
    const timers: Array<{ cb: () => void; delay: number }> = []; let reads = 0, reported = "";
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> { reads++; if (reads === 2) throw new Error("disk unavailable"); return mutate({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 }); } };
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() }, now: () => 100, setTimer: (cb, delay) => { timers.push({ cb, delay }); return timers.length; }, clearTimer: () => {}, onError: (e) => { reported = e.message; }, random: () => 0 });
    await engine.watch({ target, identity: identity() }); engine.start(); timers.shift()!.cb(); await new Promise((r) => setTimeout(r, 0));
    expect(reported).toBe("disk unavailable"); expect(timers.length).toBeGreaterThan(0); expect(timers[0]!.delay).toBeGreaterThanOrEqual(100); await engine.stop();
  });
  test("stop fences late poll completion and timeout aborts ignored signal", async () => {
    const storage = new Memory(); let signal: AbortSignal | undefined;
    const engine = new ForgeWatchEngine({ storage, timeoutMs: 10, adapter: { poll: (_t, s) => { signal = s; return new Promise(() => {}); } } });
    await engine.watch({ target, identity: identity() }); const polling = engine.pollOnce(); await new Promise((r) => setTimeout(r, 20)); expect(signal?.aborted).toBe(true); await polling;
    const f = setup(); let finish!: (s: ForgeSnapshot) => void; const e = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: () => new Promise((resolve) => { finish = resolve; }) } });
    await e.watch({ target, identity: identity() }); const late = e.pollOnce(); await new Promise((r) => setTimeout(r, 0)); const stopping = e.stop(); finish(snap()); await Promise.all([late, stopping]);
    expect(f.storage.state.targets[`${target.provider}:${target.host}/${target.project}#${target.number}`]?.baseline).toBeUndefined();
  });
});
