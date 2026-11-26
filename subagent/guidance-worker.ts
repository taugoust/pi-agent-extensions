import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { currentGuidanceScope, readBinding, sameWorker } from "./guidance-binding.ts";
import {
  GUIDANCE_HUMAN_KEY,
  requestGuidance,
  type GuidanceInput,
  type GuidanceScope,
  type GuidanceUpstream,
} from "./guidance.ts";

/** One physical worker runtime, shared by its tools and its descendant broker. */
const runtimeEpoch = randomBytes(16).toString("hex");
const UNAVAILABLE =
  "Owning coordinator guidance unavailable; no child-to-human fallback or answer replay";

/** A rebind keeps the worker identity. Any other change makes the service stale. */
function sameBinding(launchScope: GuidanceScope | undefined): boolean {
  try {
    const current = readBinding();
    if (!launchScope) return current === "unavailable";
    return typeof current === "object" && sameWorker(launchScope, current.scope);
  } catch {
    return false;
  }
}

export function upstreamGuidance(): GuidanceUpstream | undefined {
  const launch = readBinding();
  if (!launch) return undefined;
  if (launch === "unavailable")
    return async () => {
      throw new Error(UNAVAILABLE);
    };
  const request = (input: GuidanceInput, signal?: AbortSignal, requestId?: string) => {
    const binding = readBinding();
    if (typeof binding !== "object" || !sameWorker(launch.scope, binding.scope))
      throw new Error("Stale or foreign guidance binding");
    return requestGuidance(binding, runtimeEpoch, input, signal, requestId);
  };
  return Object.defineProperty(request, "scope", {
    enumerable: true,
    get: () => currentGuidanceScope() ?? launch.scope,
  }) as GuidanceUpstream;
}
export default function guidanceWorker(pi: ExtensionAPI) {
  const upstream = upstreamGuidance();
  if (!upstream) return;
  let lifetime = new AbortController();
  const launchScope = currentGuidanceScope();
  let session: { id: string; current(): string } | undefined;
  const isCurrentWorker = () =>
    Boolean(
      session &&
      !lifetime.signal.aborted &&
      sameBinding(launchScope) &&
      session.current() === session.id,
    );
  const capability = {
    protocol: 1,
    mode: "headless",
    workerEpoch: runtimeEpoch,
    supportedKinds: ["questionnaire"],
    isCurrentWorker,
    request: async (questionnaire: any, signal?: AbortSignal) => {
      if (!isCurrentWorker()) throw new Error("Stale or foreign guidance worker service");
      const answer = await upstream(
        { kind: "human", questionnaire },
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      );
      if (answer.kind !== "human") throw new Error("Invalid human guidance result");
      return answer.answer;
    },
  };
  pi.on("session_start", (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    session = {
      id: ctx.sessionManager.getSessionId(),
      current: () => ctx.sessionManager.getSessionId(),
    };
    (globalThis as any)[GUIDANCE_HUMAN_KEY] = capability;
  });
  pi.on("session_shutdown", () => {
    lifetime.abort();
    session = undefined;
    if ((globalThis as any)[GUIDANCE_HUMAN_KEY] === capability)
      delete (globalThis as any)[GUIDANCE_HUMAN_KEY];
  });
  pi.registerTool({
    name: "request_guidance",
    label: "Ask coordinator",
    description:
      "Ask your direct owning coordinator an implementation/work question and WAIT for its structured reply. Use this, not questionnaire or notify_parent, for ordinary work decisions. The coordinator escalates outside its assignment. Only genuine human preferences use questionnaire (routed to the top-level human). This tool cannot grant permission consent or change your assignment authority.",
    promptGuidelines: [
      "Route ordinary implementation/work questions to your direct coordinator with request_guidance, not questionnaire. A nested coordinator uses guidance escalate when a decision exceeds its assignment. Only genuine human preferences use questionnaire, which routes to the top-level human. Neither guidance nor questionnaire grants permission consent; use the existing permission channel.",
    ],
    parameters: Type.Object(
      {
        prompt: Type.String({ minLength: 1, maxLength: 4096 }),
        context: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      if (!isCurrentWorker()) throw new Error("Stale or foreign guidance worker service");
      const answer = await upstream(
        { kind: "guidance", ...params },
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      );
      if (answer.kind !== "guidance") throw new Error("Invalid coordinator guidance result");
      return {
        content: [{ type: "text", text: answer.guidance }],
        details: { guidance: true, authority: "coordinator-advice-only" },
      };
    },
  });
}
