import { GUIDANCE_ENV, type GuidanceBinding, type GuidanceScope } from "./guidance.ts";

/** The trusted binding lives in process.env so every extension instance sees a rebind. */
export function readBinding(): GuidanceBinding | "unavailable" | undefined {
  const raw = process.env[GUIDANCE_ENV];
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (parsed?.unavailable === true && Object.keys(parsed).length === 1) return "unavailable";
  const binding = parsed as GuidanceBinding;
  if (!binding?.socket || !binding.token || !binding.scope?.ownerRuntimeEpoch)
    throw new Error("Invalid trusted guidance launch binding");
  return binding;
}

export function sameWorker(a: GuidanceScope, b: GuidanceScope): boolean {
  const keys = ["ownerSessionId", "taskId", "childId", "attempt", "workerEpoch", "goalId"] as const;
  return keys.every((key) => a[key] === b[key]);
}

/** Public scope of the current binding, reported to the owner in worker status. */
export function currentGuidanceScope(): GuidanceScope | undefined {
  const binding = readBinding();
  return typeof binding === "object" ? binding.scope : undefined;
}

/**
 * Replace a binding that names an earlier owner runtime. Only the owner runtime,
 * socket and token may change: the worker identity stays the launch identity.
 */
export function rebindGuidance(next: GuidanceBinding): void {
  const current = readBinding();
  if (typeof current !== "object") throw new Error("Worker has no guidance binding to replace");
  const valid =
    typeof next?.socket === "string" &&
    /^[a-f0-9]{64}$/.test(String(next.token)) &&
    typeof next.scope?.ownerRuntimeEpoch === "string" &&
    sameWorker(current.scope, next.scope);
  if (!valid) throw new Error("Guidance rebinding does not match this worker");
  process.env[GUIDANCE_ENV] = JSON.stringify(next);
}
