import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountProviderAdapter } from "./oauth.js";

export class EffectiveAuthConflictError extends Error {}

/** Verify request-effective auth without rewriting provider or model configuration. */
export async function verifyModelApiKeyAuth(
  ctx: ExtensionContext,
  provider: AccountProviderAdapter,
  apiKey: string,
  signal: AbortSignal,
  availableModelIds?: readonly string[],
): Promise<void> {
  const allowed = availableModelIds ? new Set(availableModelIds) : undefined;
  const models = ctx.modelRegistry
    .getAll()
    .filter((model) => model.provider === provider.id && (!allowed || allowed.has(model.id)));
  for (const model of models) {
    signal.throwIfAborted();
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    signal.throwIfAborted();
    if (!resolved.ok || resolved.apiKey !== apiKey) {
      throw new EffectiveAuthConflictError(
        `Pi could not verify the runtime ${provider.displayName} model authentication.`,
      );
    }
    // Never treat Codex credentials as a verified account binding on a custom origin.
    // Unlike the OpenAI SDK path, Codex's native request path emits generated auth after
    // configuration, but we still verify resolved headers below so model overrides cannot
    // be mistaken for the selected named/default grant.
    if (model.api === "openai-codex-responses") {
      let origin: string | undefined;
      const baseUrl = resolved.baseUrl ?? model.baseUrl;
      try { if (typeof baseUrl === "string") origin = new URL(baseUrl).origin; } catch { /* fail closed below */ }
      if (origin !== "https://chatgpt.com") {
        throw new EffectiveAuthConflictError("OpenAI Codex account authentication requires the official ChatGPT origin.");
      }
    }
    const openai = model.api === "openai-responses" || model.api === "openai-completions";
    const keyHeader = model.api === "anthropic-messages" ? "x-api-key" : openai ? "api-key" : undefined;
    const headers = new Map<string, { name: string; value: string | null }>();
    for (const [name, value] of Object.entries(resolved.headers ?? {})) {
      const normalized = name.toLowerCase();
      // SDK object keys are case-insensitive and last-wins. Anthropic and pi-messages drop
      // nulls before constructing requests; OpenAI retains them to unset generated headers.
      headers.delete(normalized);
      if (value !== null || openai) headers.set(normalized, { name, value });
    }
    for (const [header, { name, value }] of headers) {
      if (header !== "authorization" && header !== keyHeader) continue;
      const text = value?.trim();
      const matches =
        text !== undefined &&
        (header === "authorization"
          ? /^Bearer\s+/iu.test(text) && text.replace(/^Bearer\s+/iu, "") === apiKey
          : text === apiKey);
      // pi-messages passes a plain object to fetch: a differently cased key would coexist
      // with its generated lowercase header and be combined by the HTTP Headers parser.
      const duplicate = model.api === "pi-messages" && header === "authorization" && name !== header;
      if (!matches || duplicate) {
        throw new EffectiveAuthConflictError(
          `${provider.displayName} has a conflicting authentication header. Remove the configured authentication header or select default from /accounts.`,
        );
      }
    }
  }
}
