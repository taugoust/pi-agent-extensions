// Test-only extension: deterministic provider/tool, no credentials or network.
// Loaded only by pi-run-cancellation-native.test.mjs in its disposable RPC process.
export default function cancellationFixture(pi: any) {
  globalThis.fetch = (() => { throw new Error("Native cancellation fixture forbids network"); }) as typeof fetch;
  const signals = new WeakMap<AbortSignal, number>();
  let nextSignal = 0;
  let dispatches = 0;
  function signalId(signal?: AbortSignal) {
    if (!signal) return null;
    if (!signals.has(signal)) signals.set(signal, ++nextSignal);
    return signals.get(signal);
  }
  function report(event: Record<string, unknown>) {
    process.stderr.write(`PI_CANCELLATION_FIXTURE ${JSON.stringify(event)}\n`);
  }
  pi.registerProvider("offline-cancellation-fixture", {
    api: "offline-cancellation-fixture",
    apiKey: "not-a-credential-offline-fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "fixture", name: "Offline cancellation fixture", reasoning: false,
      input: ["text"], contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model: any, context: any, options: any) {
      dispatches++;
      const userTexts = context.messages.filter((m: any) => m.role === "user").flatMap((m: any) =>
        typeof m.content === "string" ? [m.content] : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text));
      report({ event: "model_dispatch", dispatch: dispatches, signalId: signalId(options.signal), aborted: options.signal?.aborted, userTexts });
      // Ignore cancellation deliberately: only the CORE may prevent another
      // dispatch/admission. A provider-side early abort would hide the regression.
      const content = dispatches <= 2
        ? [{ type: "toolCall", id: `fixture-call-${dispatches}`, name: "cancel_fixture_wait", arguments: { hold: dispatches === 1 } }]
        : [{ type: "text", text: "Offline fixture complete" }];
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content, stopReason: dispatches <= 2 ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } };
    },
  });
  pi.registerTool({
    name: "cancel_fixture_wait", label: "Offline wait", description: "Waits only for fixture cancellation; otherwise returns offline success.",
    parameters: { type: "object", properties: { hold: { type: "boolean" } }, required: ["hold"], additionalProperties: false },
    async execute(_callId: string, args: { hold: boolean }, signal?: AbortSignal) {
      report({ event: "tool_execute", hold: args.hold, signalId: signalId(signal), aborted: signal?.aborted });
      if (args.hold) {
        await new Promise<void>((_resolve, reject) => {
          const aborted = () => {
            report({ event: "wait_cancelled", signalId: signalId(signal) });
            reject(new Error("Wait cancelled"));
          };
          if (signal?.aborted) aborted();
          else signal?.addEventListener("abort", aborted, { once: true });
        });
      }
      return { content: [{ type: "text", text: "Fresh fixture tool succeeded" }] };
    },
  });
  pi.on("session_start", () => pi.setActiveTools(["cancel_fixture_wait"]));
}
