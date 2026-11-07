import { describe, expect, test } from "bun:test";
import { ForgeWatchEngine } from "./engine.js";
import { parseTarget, type ForgeSnapshot, type ForgeWatchState } from "./types.js";
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
  test("parses canonical public and explicitly configured self-hosted targets", () => {
    expect(parseTarget("https://gitlab.com/group/sub/project/-/merge_requests/2").project).toBe("group/sub/project");
    expect(parseTarget("https://git.example.test/org/repo/-/merge_requests/4", ["git.example.test"]).provider).toBe("gitlab");
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
    expect((await f2.engine.events(identity())).map((e) => e.category).sort()).toEqual(["ci", "head"]); // CI deletion is not ignored
  });
  test("inactive or ineligible identities retain events without waking", async () => {
    const f = setup({ eligible: false }); await f.engine.watch({ target, identity: identity("one") }); await f.engine.watch({ target, identity: identity("two"), active: false });
    await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target); expect(f.wakes).toBe(0);
    expect((await f.engine.events(identity("two"))).length).toBe(3);
  });
  test("accepted batches survive reload without repeat wakes; consume resets delivery latch", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    let reloadSnapshot = snap("b", "c2");
    const reloaded = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: async () => reloadSnapshot }, wake: () => { f.incrementWakes(); } });
    await reloaded.pollOnce(target); expect(f.wakes).toBe(1);
    expect((await reloaded.events(identity(), true)).length).toBe(3);
    expect((await reloaded.status(identity()))[0]?.subscription.deliveryNotified).toBe(false);
    reloadSnapshot = snap("c", "c3"); await reloaded.pollOnce(target); expect((await reloaded.events(identity())).length).toBe(3);
  });
  test("overflow is visible and queues survive reload", async () => {
    const f = setup({ maxEventsPerSubscription: 1 }); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target);
    f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    expect((await f.engine.status(identity()))[0]?.subscription.overflow).toContain("limit");
    const reloaded = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: async () => snap() } });
    expect((await reloaded.events(identity())).length).toBe(1);
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
    const f = setup({ maxConcurrency: 1 }); let active = 0, peak = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = new ForgeWatchEngine({ storage: f.storage, maxConcurrency: 1, adapter: { async poll() { active++; peak = Math.max(peak, active); await gate; active--; return snap(); } } });
    await engine.watch({ target, identity: identity() }); await engine.watch({ target: target2, identity: identity() });
    const one = engine.pollOnce(); const two = engine.pollOnce(); await new Promise((r) => setTimeout(r, 0)); expect(peak).toBe(1); release(); await Promise.all([one, two]);
  });
  test("scheduled storage failures are reported and schedule bounded retry rather than dying", async () => {
    const timers: Array<{ cb: () => void; delay: number }> = []; let reads = 0, reported = "";
    const storage = { async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> { reads++; if (reads === 2) throw new Error("disk unavailable"); return mutate({ version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 }); } };
    const engine = new ForgeWatchEngine({ storage, adapter: { poll: async () => snap() }, now: () => 100, setTimer: (cb, delay) => { timers.push({ cb, delay }); return timers.length; }, clearTimer: () => {}, onError: (e) => { reported = e.message; }, random: () => 0 });
    await engine.watch({ target, identity: identity() }); engine.start(); const first = timers.shift()!; first.cb(); await new Promise((r) => setTimeout(r, 0));
    expect(reported).toBe("disk unavailable"); expect(timers.length).toBeGreaterThan(0); expect(timers[0]!.delay).toBeGreaterThanOrEqual(100);
    engine.stop();
  });
  test("stop fences late poll completion and timeout aborts ignored signal", async () => {
    const storage = new Memory(); let release!: (s: ForgeSnapshot) => void; let signal: AbortSignal | undefined;
    const engine = new ForgeWatchEngine({ storage, timeoutMs: 10, setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), adapter: { poll: (_t, s) => { signal = s; return new Promise((resolve) => { release = resolve; }); } } });
    await engine.watch({ target, identity: identity() }); const polling = engine.pollOnce(); await new Promise((r) => setTimeout(r, 20)); expect(signal?.aborted).toBe(true); await polling; expect(storage.state.targets[`${target.provider}:${target.host}/${target.project}#${target.number}`]?.lastError).toContain("timed out");
    let finish!: (s: ForgeSnapshot) => void; const f = setup(); const e = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: () => new Promise((resolve) => { finish = resolve; }) } }); await e.watch({ target, identity: identity() }); const late = e.pollOnce(); await new Promise((r) => setTimeout(r, 0)); e.stop(); finish(snap()); await late; expect(f.storage.state.targets[`${target.provider}:${target.host}/${target.project}#${target.number}`]?.baseline).toBeUndefined();
  });
});
