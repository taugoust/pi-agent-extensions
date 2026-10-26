import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInheritedSessionRouting, prepareSessionRoutingRequest } from "../shared/session-routing.ts";

/** Native provider stream gates route requests; never replace the session's role identity. */
export async function installSessionFollower(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<() => void> {
  if (!isInheritedSessionRouting(ctx)) return () => {};
  if (!ctx.model || ctx.model.api === "pi-virtual") throw new Error("Inherited worker requires a native physical role model; no fallback is allowed");
  const profile = await prepareSessionRoutingRequest(ctx);
  const physical = profile && ctx.modelRegistry.find(profile.providerId, ctx.model.id);
  if (!physical || physical.api === "pi-virtual") throw new Error("Inherited physical role model is unavailable; request blocked");
  return () => {};
}
