import { describe, expect, it } from "bun:test";
import { lastModelActivity, shouldWarn } from "./index.ts";

const settings = { idleMinutes: 30, contextPercent: 20 };
describe("idle context warning thresholds", () => {
  it("uses the latest model response on the active branch, ignoring user/tool activity", () => {
    const branch = [
      { type: "message", timestamp: new Date(0).toISOString(), message: { role: "assistant", model: "m", timestamp: 1000 } },
      { type: "message", timestamp: new Date(10_000).toISOString(), message: { role: "user", timestamp: 10_000 } },
      { type: "message", timestamp: new Date(20_000).toISOString(), message: { role: "assistant", model: "m", timestamp: 20_000 } },
    ];
    expect(lastModelActivity(branch)).toBe(20_000);
    expect(lastModelActivity(branch.slice(0, 2))).toBe(1_000);
  });
  it("warns at the exact idle and context thresholds, not below either", () => {
    const start = 1_000;
    expect(shouldWarn(start, start + 30 * 60_000, 20, settings)).toBe(true);
    expect(shouldWarn(start, start + 30 * 60_000 - 1, 20, settings)).toBe(false);
    expect(shouldWarn(start, start + 30 * 60_000, 19.99, settings)).toBe(false);
    expect(shouldWarn(undefined, start + 60 * 60_000, 50, settings)).toBe(false);
    expect(shouldWarn(start, start + 60 * 60_000, null, settings)).toBe(false);
  });
  it("honors configurable thresholds", () => {
    expect(shouldWarn(0, 5 * 60_000, 50, { idleMinutes: 5, contextPercent: 50 })).toBe(true);
    expect(shouldWarn(0, 5 * 60_000, 49, { idleMinutes: 5, contextPercent: 50 })).toBe(false);
  });
});
