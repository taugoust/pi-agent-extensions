import { randomUUID } from "node:crypto";

export type Choice = "ignore" | "compact" | "cancel";
export type AdmissionDetails = { model: string; idleMinutes: number; contextPercent: number; title: string; origin: "submission" | "notification"; session: string };
export type PendingAdmission = AdmissionDetails & { id: string; state: "deciding" | "pending" | "compacting" };

/** A session-local decision lane. No model/provider access and no implicit consent.
 * Missing/disconnected ports leave the same request pending until explicit control
 * or cancellation. A second caller is refused, never allowed to replace the first.
 */
export class AdmissionLane {
  private current?: { value: PendingAdmission; controller: AbortController; resolve: (choice: Choice) => void; cleanup: () => void; answered: boolean };
  private readonly changed: (pending: PendingAdmission | undefined) => void;
  private readonly available = new Set<() => void>();
  async waitForIdle(signal: AbortSignal): Promise<void> {
    while (this.current && !signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { this.available.delete(finish); signal.removeEventListener("abort", finish); resolve(); };
      this.available.add(finish); signal.addEventListener("abort", finish, { once: true });
    });
  }
  private released(): void { for (const done of [...this.available]) done(); }
  constructor(changed: (pending: PendingAdmission | undefined) => void = () => {}) { this.changed = changed; }
  get pending(): PendingAdmission | undefined { return this.current ? { ...this.current.value } : undefined; }
  decide(id: string, choice: Choice): boolean {
    if (!["ignore", "compact", "cancel"].includes(choice) || this.current?.value.id !== id) return false;
    if (this.current.value.state === "compacting" && choice === "cancel") { this.invalidate(); return true; }
    if (this.current.value.state === "compacting" || this.current.answered) return false;
    const item = this.current;
    item.answered = true;
    item.resolve(choice);
    return true;
  }
  invalidate(): void {
    const item = this.current;
    if (!item) return;
    this.current = undefined;
    item.cleanup();
    item.controller.abort();
    item.resolve("cancel");
    this.changed(undefined);
    this.released();
  }
  async run(details: AdmissionDetails, port: ((signal: AbortSignal) => Promise<Choice>) | undefined,
    signal: AbortSignal, compact: (signal: AbortSignal) => Promise<boolean>): Promise<"continue" | "cancel"> {
    if (signal.aborted || this.current) return "cancel";
    const controller = new AbortController();
    const abort = () => this.invalidate();
    let resolve!: (choice: Choice) => void;
    const decision = new Promise<Choice>(done => { resolve = done; });
    const value: PendingAdmission = { ...details, id: randomUUID(), state: port ? "deciding" : "pending" };
    const item = { value, controller, resolve, cleanup: () => signal.removeEventListener("abort", abort), answered: false };
    this.current = item;
    signal.addEventListener("abort", abort, { once: true });
    this.changed(this.pending);
    if (port) void Promise.resolve().then(() => port(controller.signal)).then(choice => {
      if (this.current === item && !controller.signal.aborted) this.decide(value.id, choice);
    }, () => {
      // A lost decision channel is not a negative answer or approval.
      if (this.current === item && !controller.signal.aborted) { value.state = "pending"; this.changed(this.pending); }
    });
    try {
      const choice = await decision;
      if (this.current !== item || controller.signal.aborted || signal.aborted) return "cancel";
      if (choice !== "compact") return choice === "ignore" ? "continue" : "cancel";
      value.state = "compacting";
      this.changed(this.pending);
      return await compact(controller.signal) && this.current === item && !controller.signal.aborted && !signal.aborted ? "continue" : "cancel";
    } finally {
      if (this.current === item) { this.current = undefined; item.cleanup(); controller.abort(); this.changed(undefined); this.released(); }
    }
  }
}
