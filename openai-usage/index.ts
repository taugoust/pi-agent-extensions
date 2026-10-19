import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_CONTROLS_KEY, ACCOUNT_CONTROLS_PROTOCOL, type AccountControlsService, type AccountControlsSnapshot } from "../shared/account-controls.js";

const service = (): AccountControlsService | undefined => {
  const value = (globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] as AccountControlsService | undefined;
  return value?.protocol === ACCOUNT_CONTROLS_PROTOCOL && typeof value.getSnapshot === "function" ? value : undefined;
};

export default function openaiUsage(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description: "Show effective OpenAI credential status and official settings link",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const current = service();
        if (current && current.sessionId !== sessionId) throw new Error('Account service belongs to a different session');
        const snapshot = current
          ? await current.getSnapshot({ sessionId })
          : undefined;
        if (ctx.sessionManager.getSessionId() !== sessionId || (current && (service() !== current || current.sessionId !== sessionId || snapshot?.sessionId !== sessionId))) return;
        const effective = snapshot?.usage.effectiveCredential ?? credentialFromRegistry(ctx);
        const link = snapshot?.usage.settingsUrl ?? settingsUrl(effective);
        const status = effective === "api-key-configured"
          ? "API key configured"
          : effective === "chatgpt-grant-matched-refreshed"
            ? "ChatGPT grant active"
            : effective === "chatgpt-grant-configured"
              ? "ChatGPT grant configured"
              : effective === "unavailable"
              ? "No effective OpenAI credential"
              : "Credential status unknown";
        ctx.ui.notify(link ? `${status}\n${link}` : status, effective === "unavailable" ? "warning" : "info");
      } catch {
        if (ctx.sessionManager.getSessionId() !== sessionId) return;
        ctx.ui.notify("OpenAI credential status unavailable.", "warning");
      }
    },
  });
}

function credentialFromRegistry(ctx: ExtensionContext): AccountControlsSnapshot["usage"]["effectiveCredential"] {
  try {
    const provider = ctx.modelRegistry.getProvider("openai");
    const model = provider?.getModels()[0];
    const status = ctx.modelRegistry.getProviderAuthStatus("openai");
    if (!status.configured) return "unavailable";
    if (!model) return "unknown";
    return ctx.modelRegistry.isUsingOAuth(model) ? "chatgpt-grant-configured" : "api-key-configured";
  } catch {
    return "unknown";
  }
}

function settingsUrl(credential: AccountControlsSnapshot["usage"]["effectiveCredential"]): string | null {
  if (credential === "chatgpt-grant-matched-refreshed" || credential === "chatgpt-grant-configured") return "https://chatgpt.com/settings/usage";
  if (credential === "api-key-configured") return "https://platform.openai.com/settings/organization/usage";
  return null;
}
