// Offline regression fixture for the additive Pi command-feedback API.
export default function commandFeedbackFixture(pi: any) {
  let slowExecutions = 0;
  let throwExecutions = 0;
  let networkCalls = 0;
  globalThis.fetch = (() => { networkCalls++; throw new Error("UNEXPECTED_NETWORK"); }) as any;
  pi.on("input", (event: any) => event.text === "admission-consumed" ? { action: "handled" } : undefined);

  pi.registerCommand("feedback_dialog", { handler: async (_args: string, ctx: any) => {
    const value = await ctx.ui.input("Feedback local input");
    ctx.ui.notify(`dialog-value:${value}`, "info");
  } });
  pi.registerCommand("feedback_admission", { handler: async (_args: string, ctx: any) => {
    const consumed = await pi.submitUserMessage("admission-consumed");
    ctx.ui.notify(`admission:${consumed.disposition}`, "info");
    try {
      await pi.submitUserMessage("admission-without-credentials");
      ctx.ui.notify("admission:FALSE_SUCCESS", "error");
    } catch (error: any) {
      ctx.ui.notify(`admission-rejected:${error.message}`, "info");
    }
    const blocked = await pi.dispatchExtensionCommand("feedback_dialog", "", { allowDialogs: false });
    ctx.ui.notify(`dialog-blocked:${blocked.status}:${blocked.error?.message}`, "info");
    const allowed = await pi.dispatchExtensionCommand("feedback_dialog");
    ctx.ui.notify(`dialog-allowed:${allowed.status}`, "info");
    ctx.ui.notify(`network-calls:${networkCalls}`, "info");
  } });

  let releaseModel = false;
  pi.registerCommand("feedback_release", { handler: async () => { releaseModel = true; } });
  pi.registerCommand("feedback_network", { handler: async (_args: string, ctx: any) => { ctx.ui.notify(`network-final:${networkCalls}`, "info"); } });
  pi.registerCommand("feedback_model_admission", { handler: async (_args: string, ctx: any) => {
    pi.registerProvider("offline-feedback-model", {
      api: "offline-feedback-model", apiKey: "not-a-credential-fixture", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "fixture", name: "Offline feedback", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model: any) {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "Offline completion" }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        return { async *[Symbol.asyncIterator]() {
          while (!releaseModel) await new Promise(resolve => setTimeout(resolve, 10));
          yield { type: "done", reason: "stop", message };
        }, async result() { return message; } };
      },
    });
    const model = ctx.modelRegistry.find("offline-feedback-model", "fixture");
    if (!model || !await pi.setModel(model)) throw new Error("Offline fixture model unavailable");
    ctx.ui.notify(`model-admission:${(await pi.submitUserMessage("model-start")).disposition}`, "info");
    ctx.ui.notify(`model-admission:${(await pi.submitUserMessage("model-queued", { deliverAs: "followUp" })).disposition}`, "info");
  } });

  pi.registerCommand("feedback_slow", {
    description: "Delayed command for dispatch feedback regression",
    handler: async (_args: string, ctx: any) => {
      slowExecutions++;
      setTimeout(() => ctx.ui.notify("late local notice", "info"), 260);
      await new Promise((resolve) => setTimeout(resolve, 180));
      ctx.ui.notify("literal delayed notice α", "warning");
    },
  });

  pi.registerCommand("feedback_throw", {
    description: "Throwing command for dispatch feedback regression",
    handler: async (_args: string, ctx: any) => {
      throwExecutions++;
      ctx.ui.notify("literal before throw", "error");
      throw new Error("expected dispatch failure");
    },
  });

  pi.registerCommand("feedback_probe", {
    description: "Run offline command dispatch and report its outcome",
    handler: async (_args: string, ctx: any) => {
      const streamed: string[] = [];
      const slow = await pi.dispatchExtensionCommand("feedback_slow", "", {
        onNotify: (message: string, type: string) => {
          streamed.push(`${message}:${type}`);
          ctx.ui.notify(`stream:${message}`, type);
        },
      });
      ctx.ui.notify(`receipt:${slow.status}:${slow.notifications.length}`, "info");

      const failed = await pi.dispatchExtensionCommand("feedback_throw", "", {
        onNotify: (message: string, type: string) => {
          streamed.push(`${message}:${type}`);
          ctx.ui.notify(`stream:${message}`, type);
        },
      });
      ctx.ui.notify(`failure:${failed.status}:${failed.error?.message}:${failed.notifications.length}`, "info");

      const missing = await pi.dispatchExtensionCommand("feedback_missing");
      ctx.ui.notify(`missing:${missing.status}:${missing.notifications.length}`, "info");
      ctx.ui.notify(`counts:${slowExecutions}:${throwExecutions}:${streamed.length}`, "info");
    },
  });
}
