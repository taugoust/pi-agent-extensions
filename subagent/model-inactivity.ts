export const MODEL_INACTIVITY_MS = 5 * 60_000;

/** Observes an awaited model stream only; it never aborts or retries work. */
export class ModelInactivityWatch {
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private warned = false;
  private readonly onStall: () => void;
  private readonly timeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly onClear: () => void;
  constructor(onStall: () => void, timeoutMs = MODEL_INACTIVITY_MS,
    setTimer: typeof setTimeout = setTimeout, clearTimer: typeof clearTimeout = clearTimeout, onClear: () => void = () => {}) {
    this.onStall = onStall;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onClear = onClear;
  }
  start(): void { this.onClear(); this.active = true; this.warned = false; this.resetTimer(); }
  progress(): void { if (this.active) { this.onClear(); this.warned = false; this.resetTimer(); } }
  end(): void { this.active = false; this.clear(); this.onClear(); }
  shutdown(): void { this.end(); }
  private clear(): void { if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; }
  private resetTimer(): void {
    this.clear();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this.active || this.warned) return;
      this.warned = true;
      this.onStall();
    }, this.timeoutMs);
    this.timer.unref?.();
  }
}
