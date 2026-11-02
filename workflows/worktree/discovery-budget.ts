import { setImmediate } from "node:timers/promises";

/** A read-only discovery deadline, including adapters that ignore cancellation.
 * The underlying operation still receives the signal and must not publish late
 * results. Rejection handlers stay attached after expiry.
 */
export function withinDiscoveryBudget<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve().then(() => {
			signal.throwIfAborted();
			return read();
		}).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function yieldDiscovery(signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	await setImmediate(undefined, { signal });
}
