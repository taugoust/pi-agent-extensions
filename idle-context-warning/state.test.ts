import { describe, expect, it } from "bun:test";
import { lastModelActivity, shouldWarn, warningTitle } from "./policy.ts";

const settings = { idleMinutes: 30, contextPercent: 20 };
describe("idle context warning thresholds", () => {
  it("preserves warning presentation without deciding admission or registering a provider", () => {
    const usage = { tokens: 1234.6, contextWindow: 10000, percent: 20.5 };
    const title = warningTitle("physical/model", 1000, 1000 + 30 * 60_000 + 59999, usage);
    expect(title).toBe(`Model: physical/model\nLast model response: 30 minutes ago\nContext: ${(1235).toLocaleString()} / ${(10000).toLocaleString()} tokens (21%). The model cache may have expired.`);
    expect(warningTitle("unknown model", 0, 0, { ...usage, tokens: null })).toContain("Context: unknown /");
    expect(usage).toEqual({ tokens: 1234.6, contextWindow: 10000, percent: 20.5 });
  });
  it("uses the latest model response on the active branch, ignoring user/tool activity", () => {
    const branch = [
      { type: "message", timestamp: new Date(0).toISOString(), message: { role: "assistant", model: "m", timestamp: 1000 } },
      { type: "message", timestamp: new Date(10_000).toISOString(), message: { role: "user", timestamp: 10_000 } },
      { type: "message", timestamp: new Date(20_000).toISOString(), message: { role: "assistant", model: "m", timestamp: 20_000 } },
    ];
    expect(lastModelActivity(branch)).toBe(20_000);
    expect(lastModelActivity(branch.slice(0, 2))).toBe(1_000);
  });
  it("does not reset idle activity on routing/provider errors or aborted requests", () => {
    const success = { type: "message", message: { role: "assistant", model: "physical", timestamp: 1000, stopReason: "stop" } };
    const failures = [
      { type: "message", message: { role: "assistant", model: "guarded", timestamp: 2000, stopReason: "error" } },
      { type: "message", message: { role: "assistant", model: "physical", timestamp: 3000, stopReason: "error" } },
      { type: "message", message: { role: "assistant", model: "physical", timestamp: 4000, stopReason: "aborted" } },
    ];
    expect(lastModelActivity([success, ...failures])).toBe(1000);
    expect(lastModelActivity(failures)).toBeUndefined();
    expect(shouldWarn(lastModelActivity([success, ...failures]), 1000 + 30 * 60_000, 20, settings)).toBe(true);
  });
  it("warns at the exact idle and context thresholds, not below either", () => {
    const start = 1_000;
    expect(shouldWarn(start, start + 30 * 60_000, 20, settings)).toBe(true);
    expect(shouldWarn(start, start + 30 * 60_000 - 1, 20, settings)).toBe(false);
    expect(shouldWarn(start, start + 30 * 60_000, 19.99, settings)).toBe(false);
    expect(shouldWarn(undefined, start + 60 * 60_000, 50, settings)).toBe(false);
    expect(shouldWarn(start, start + 60 * 60_000, null, settings)).toBe(false);
  });
  it("uses persisted ISO timestamps when message timestamps are absent and skips invalid entries", () => {
    const branch = [
      { type: "message", timestamp: new Date(1000).toISOString(), message: { role: "assistant", model: "m" } },
      { type: "message", timestamp: "invalid", message: { role: "assistant", model: "m", timestamp: "invalid" } },
      { type: "message", timestamp: new Date(2000).toISOString(), message: { role: "assistant" } },
    ];
    expect(lastModelActivity(branch)).toBe(1000);
    expect(shouldWarn(1000, 999, 100, settings)).toBe(false);
  });
  it("honors configurable thresholds", () => {
    expect(shouldWarn(0, 5 * 60_000, 50, { idleMinutes: 5, contextPercent: 50 })).toBe(true);
    expect(shouldWarn(0, 5 * 60_000, 49, { idleMinutes: 5, contextPercent: 50 })).toBe(false);
  });
});
