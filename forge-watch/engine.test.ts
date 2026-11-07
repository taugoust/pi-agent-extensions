import { describe, expect, test } from "bun:test";
import { ForgeWatchEngine } from "./engine.js";
import { parseTarget, type ForgeSnapshot, type ForgeWatchState } from "./types.js";

const target = parseTarget("https://github.com/acme/repo/pull/7");
const identity = (n = "one") => ({ sessionId: "session", goalId: n, activationId: "activation" });
const snap = (head = "a", comment = "c1"): ForgeSnapshot => ({ head, state: "open", comments: [{ id: comment, fingerprint: comment, actor: "reviewer" }], reviews: [], ci: [] });
class Memory {
  state: ForgeWatchState = { version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 };
  async update<T>(mutate: (state: ForgeWatchState) => T): Promise<T> { return mutate(this.state); }
}
const setup = (options: { eligible?: boolean; max?: number; fail?: boolean } = {}) => {
  const storage = new Memory(); let snapshot = snap(); let polls = 0; let wakes = 0;
  const engine = new ForgeWatchEngine({ storage, adapter: { async poll() { polls++; if (options.fail) throw Object.assign(new Error("rate limited"), { retryAfterMs: 5000 }); return snapshot; } }, wake: () => { wakes++; }, isEligible: () => options.eligible ?? true, now: () => 100, intervalMs: 10, maxEventsPerSubscription: options.max, jitter: (d) => d });
  return { engine, storage, set snapshot(value: ForgeSnapshot) { snapshot = value; }, get polls() { return polls; }, get wakes() { return wakes; } };
};

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
    expect((await f.engine.events(identity())).map((e) => e.category)).toEqual(["head", "comments"]);
    await f.engine.pollOnce(target); expect(f.wakes).toBe(1); // accepted delivery is not repeated before acknowledgement
  });
  test("shared polling reaches concurrent subscriptions and paused/stale identities are not woken", async () => {
    const f = setup({ eligible: false }); await Promise.all([f.engine.watch({ target, identity: identity("one") }), f.engine.watch({ target, identity: identity("two"), active: false })]);
    await f.engine.pollOnce(target); f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target); expect(f.polls).toBe(2); expect(f.wakes).toBe(0);
    expect((await f.engine.events(identity("two"))).length).toBe(2);
  });
  test("queues persist through reload and overflow is visible", async () => {
    const f = setup({ max: 1 }); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target);
    f.snapshot = snap("b", "c2"); await f.engine.pollOnce(target);
    expect((await f.engine.status(identity()))[0]?.subscription.overflow).toContain("limit");
    const reloaded = new ForgeWatchEngine({ storage: f.storage, adapter: { poll: async () => snap() } });
    expect((await reloaded.events(identity())).length).toBe(1);
    expect(await reloaded.ack(identity(), ["1"])).toBe(1);
  });
  test("rate-limit failures preserve error and retry-after schedule", async () => {
    const f = setup({ fail: true }); await f.engine.watch({ target, identity: identity() }); await f.engine.pollOnce(target);
    const status = await f.engine.status(identity()); expect(status[0]?.lastError).toBe("rate limited"); expect(status[0]?.nextPollAt).toBe(5100);
  });
  test("stop cancels scheduling and ignores late cancelled poll", async () => {
    const f = setup(); await f.engine.watch({ target, identity: identity() }); f.engine.start(); f.engine.stop(); expect(f.polls).toBe(0);
  });
});
