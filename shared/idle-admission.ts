import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WakeAdmission = { check(signal: AbortSignal, origin: "notification" | "autonomous"): Promise<"continue" | "cancel"> };
const KEY = "__paeIdleAdmissionBySessionV1";
function registry(): Map<string, WakeAdmission> { return ((globalThis as any)[KEY] ??= new Map()); }
export function installWakeAdmission(session: string, service: WakeAdmission): () => void {
  registry().set(session, service);
  return () => { if (registry().get(session) === service) registry().delete(session); };
}
/** Absence means the optional extension is disabled, not that a disconnected
 * user/parent approved: a loaded extension installs a service before readiness. */
export async function admitHarnessWake(ctx: ExtensionContext, signal: AbortSignal, trustedAutonomous = false): Promise<"continue" | "cancel"> {
  if (signal.aborted) return "cancel";
  const service = registry().get(ctx.sessionManager.getSessionId());
  return service ? service.check(signal, trustedAutonomous ? "autonomous" : "notification") : "continue";
}
