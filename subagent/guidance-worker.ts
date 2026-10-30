import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { GUIDANCE_ENV, GUIDANCE_HUMAN_KEY, requestGuidance, type GuidanceBinding, type GuidanceInput, type GuidanceUpstream } from "./guidance.ts";

/** One physical worker runtime, shared by its tools and its descendant broker. */
const runtimeEpoch = randomBytes(16).toString("hex");
export function upstreamGuidance(): GuidanceUpstream | undefined {
  const raw = process.env[GUIDANCE_ENV];
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (parsed?.unavailable === true && Object.keys(parsed).length === 1) return async () => { throw new Error("Owning coordinator guidance unavailable; no child-to-human fallback or answer replay"); };
  const binding = parsed as GuidanceBinding;
  if (!binding?.socket || !binding.token || !binding.scope?.ownerRuntimeEpoch) throw new Error("Invalid trusted guidance launch binding");
  return Object.assign((input: GuidanceInput, signal?: AbortSignal, requestId?: string) => requestGuidance(binding, runtimeEpoch, input, signal, requestId), { scope: binding.scope });
}
export default function guidanceWorker(pi: ExtensionAPI) {
  const upstream = upstreamGuidance(); if (!upstream) return;
  let lifetime = new AbortController();
  const launchBinding = process.env[GUIDANCE_ENV];
  let session: { id: string; current(): string } | undefined;
  const isCurrentWorker = () => Boolean(session && !lifetime.signal.aborted && process.env[GUIDANCE_ENV] === launchBinding && session.current() === session.id);
  const capability = { protocol: 1, mode: "headless", workerEpoch: runtimeEpoch, supportedKinds: ["questionnaire"], isCurrentWorker,
    request: async (questionnaire: any, signal?: AbortSignal) => {
      if (!isCurrentWorker()) throw new Error("Stale or foreign guidance worker service");
      const answer = await upstream({ kind: "human", questionnaire }, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
      if (answer.kind !== "human") throw new Error("Invalid human guidance result");
      return answer.answer;
    } };
  pi.on("session_start", (_event, ctx) => { lifetime.abort(); lifetime = new AbortController(); session = { id: ctx.sessionManager.getSessionId(), current: () => ctx.sessionManager.getSessionId() }; (globalThis as any)[GUIDANCE_HUMAN_KEY] = capability; });
  pi.on("session_shutdown", () => { lifetime.abort(); session = undefined; if ((globalThis as any)[GUIDANCE_HUMAN_KEY] === capability) delete (globalThis as any)[GUIDANCE_HUMAN_KEY]; });
  pi.registerTool({ name: "request_guidance", label: "Ask coordinator", description: "Ask your direct owning coordinator an implementation/work question and WAIT for its structured reply. Use this, not questionnaire or notify_parent, for ordinary work decisions. The coordinator escalates outside its assignment. Only genuine human preferences use questionnaire (routed to the top-level human). This tool cannot grant permission consent or change your assignment authority.",
    promptGuidelines: ["Route ordinary implementation/work questions to your direct coordinator with request_guidance, not questionnaire. A nested coordinator uses guidance escalate when a decision exceeds its assignment. Only genuine human preferences use questionnaire, which routes to the top-level human. Neither guidance nor questionnaire grants permission consent; use the existing permission channel."],
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 4096 }), context: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })) }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      if (!isCurrentWorker()) throw new Error("Stale or foreign guidance worker service");
      const answer = await upstream({ kind: "guidance", ...params }, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
      if (answer.kind !== "guidance") throw new Error("Invalid coordinator guidance result");
      return { content: [{ type: "text", text: answer.guidance }], details: { guidance: true, authority: "coordinator-advice-only" } };
    } });
}
