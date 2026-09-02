export type ForegroundDecision<TResult, TDetached> =
  | { kind: "completed"; result: TResult }
  | { kind: "detached"; value: TDetached };

export type ForegroundAdoption<TUpdate, TResult> = {
  completion: Promise<TResult>;
  abort(reason?: unknown): void;
  subscribe(listener: (update: TUpdate) => void): () => void;
};

type ExecutionState = "active" | "detaching" | "detached" | "completed";
type Settled<TResult> = { ok: true; result: TResult } | { ok: false; error: unknown };

/**
 * Owns one foreground execution from launch so it can be adopted without
 * restarting it. Completion is withheld while adoption is in progress: a fast
 * child can therefore never be returned both as foreground and background work.
 */
export class DetachableForegroundExecution<TUpdate, TResult, TDetached> {
  private readonly controller = new AbortController();
  private readonly completionPromise: Promise<TResult>;
  private readonly decisionPromise: Promise<ForegroundDecision<TResult, TDetached>>;
  private readonly backgroundListeners = new Set<(update: TUpdate) => void>();
  private resolveDecision!: (decision: ForegroundDecision<TResult, TDetached>) => void;
  private rejectDecision!: (error: unknown) => void;
  private state: ExecutionState = "active";
  private settled?: Settled<TResult>;
  private latest?: TUpdate;
  private detachedValue?: TDetached;
  private detachAttempt?: Promise<TDetached | undefined>;

  constructor(
    run: (signal: AbortSignal, update: (value: TUpdate) => void) => Promise<TResult>,
    private readonly foregroundUpdate?: (value: TUpdate) => void,
  ) {
    this.decisionPromise = new Promise((resolve, reject) => {
      this.resolveDecision = resolve;
      this.rejectDecision = reject;
    });
    this.completionPromise = Promise.resolve().then(() => run(this.controller.signal, (value) => this.emit(value)));
    this.completionPromise.then(
      (result) => this.onSettled({ ok: true, result }),
      (error) => this.onSettled({ ok: false, error }),
    );
  }

  get detachable(): boolean {
    return this.state === "active";
  }

  get completion(): Promise<TResult> {
    return this.completionPromise;
  }

  waitForDecision(): Promise<ForegroundDecision<TResult, TDetached>> {
    return this.decisionPromise;
  }

  abort(reason?: unknown): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Foreground subagent cancelled"));
  }

  detach(adopt: (execution: ForegroundAdoption<TUpdate, TResult>) => Promise<TDetached>): Promise<TDetached | undefined> {
    if (this.state === "completed") return Promise.resolve(undefined);
    if (this.state === "detached") return Promise.resolve(this.detachedValue);
    if (this.detachAttempt) return this.detachAttempt;
    if (this.state !== "active") return Promise.resolve(undefined);

    this.state = "detaching";
    const attempt = (async () => {
      try {
        const value = await adopt({
          completion: this.completionPromise,
          abort: (reason) => this.abort(reason),
          subscribe: (listener) => this.subscribe(listener),
        });
        this.detachedValue = value;
        this.state = "detached";
        this.resolveDecision({ kind: "detached", value });
        return value;
      } catch (error) {
        this.state = "active";
        if (this.settled) this.deliverForegroundCompletion(this.settled);
        throw error;
      } finally {
        this.detachAttempt = undefined;
      }
    })();
    this.detachAttempt = attempt;
    return attempt;
  }

  private emit(value: TUpdate): void {
    this.latest = value;
    if (this.state === "active") {
      try { this.foregroundUpdate?.(value); } catch { /* Rendering failures must not stop execution. */ }
    }
    for (const listener of this.backgroundListeners) {
      try { listener(value); } catch { /* Persistence failures are handled by the adopter. */ }
    }
  }

  private subscribe(listener: (update: TUpdate) => void): () => void {
    this.backgroundListeners.add(listener);
    if (this.latest !== undefined) {
      try { listener(this.latest); } catch { /* The next update can retry. */ }
    }
    return () => this.backgroundListeners.delete(listener);
  }

  private onSettled(settled: Settled<TResult>): void {
    this.settled = settled;
    if (this.state !== "active") return;
    this.deliverForegroundCompletion(settled);
  }

  private deliverForegroundCompletion(settled: Settled<TResult>): void {
    if (this.state !== "active") return;
    this.state = "completed";
    if (settled.ok) this.resolveDecision({ kind: "completed", result: settled.result });
    else this.rejectDecision(settled.error);
  }
}
