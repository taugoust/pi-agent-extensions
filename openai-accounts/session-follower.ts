import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindSessionModelRequest, isInheritedSessionRouting, prepareSessionRoutingRequest, registerSessionModelReference } from "../shared/session-routing.ts";

const FOLLOW_PROVIDER = "session-follow";

/** Install only after Accounts owner.ready has settled: setModel emits model_select. */
export async function installSessionFollower(pi: ExtensionAPI, ctx: ExtensionContext): Promise<() => void> {
  if (!isInheritedSessionRouting(ctx)) return () => {};
  const selected = ctx.model;
  if (!selected || (selected.api === "pi-virtual" && selected.provider !== FOLLOW_PROVIDER)) {
    throw new Error("Inherited worker requires a physical role model; no model/provider fallback is allowed");
  }
  // Our virtual ID is exactly the original physical role ID, including slashes.
  // It therefore remains recoverable after extension reload and worker resume.
  const roleId = selected.id;
  const initial = await prepareSessionRoutingRequest(ctx);
  if (!initial) throw new Error("Inherited worker has no owning-session routing profile");
  const reference = { provider: initial.providerId, id: roleId };
  const removeReference = registerSessionModelReference(ctx, () => reference);
  pi.registerVirtualModel({
    provider: FOLLOW_PROVIDER,
    id: roleId,
    name: `Session provider: ${roleId}`,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    input: selected.input,
    contextWindow: selected.contextWindow,
    maxTokens: selected.maxTokens,
    async route(request, routeCtx) {
      const profile = await prepareSessionRoutingRequest(routeCtx);
      if (!profile) throw new Error("Owning-session routing unavailable; helper request blocked");
      const physical = routeCtx.modelRegistry.find(profile.providerId, roleId);
      if (!physical || physical.api === "pi-virtual" || physical.provider === FOLLOW_PROVIDER) {
        throw new Error(`Unavailable inherited role model: ${profile.providerId}/${roleId}; no fallback`);
      }
      return { model: bindSessionModelRequest(physical, profile), thinkingLevel: request.thinkingLevel };
    },
  });
  const follower = ctx.modelRegistry.find(FOLLOW_PROVIDER, roleId);
  try {
    if (!follower || !(await pi.setModel(follower))) throw new Error("Could not activate inherited session provider routing");
  } catch (error) {
    removeReference();
    try { pi.unregisterVirtualModel(FOLLOW_PROVIDER, roleId); } catch { /* old runtime may already be disposed */ }
    throw error;
  }
  return () => { removeReference(); try { pi.unregisterVirtualModel(FOLLOW_PROVIDER, roleId); } catch { /* idempotent runtime teardown */ } };
}
