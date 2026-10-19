import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountControlsSnapshot, SafeAccountLabel } from "../shared/account-controls.js";
import type { AccountStore, StoredCredential } from "./account-store.js";
import type { SessionSelectionOwner } from "./accounts.js";

export async function createAccountControlsSnapshot(
  owner: SessionSelectionOwner,
  store: AccountStore,
  serviceEpoch: string,
): Promise<AccountControlsSnapshot> {
  const readTimeout = AbortSignal.timeout(5_000);
  const data = await store.readAsync(AbortSignal.any([owner.signal, readTimeout]));
  const state = data.providers.openai;
  const accounts: SafeAccountLabel[] = Object.entries(state?.accounts ?? {}).map(([name, credential]) => ({
    id: name,
    label: safeLabel(name),
    authKind: credential.type === "api_key" ? "api-key" : "oauth",
  }));
  const currentAccountId = owner.selections.openai ?? null;
  const selected = currentAccountId ? state?.accounts[currentAccountId] : undefined;
  const result = owner.results.get("openai");
  const pending = owner.pendingSyncTasks.has("openai");
  const busy = !owner.context.isIdle() || owner.switchReserved > 0 || owner.openAIRequestCount > 0 || pending;
  const bindingMatchesStore = Boolean(currentAccountId && selected &&
    owner.appliedIdentities.get('openai') === `${currentAccountId}:${selected.type === 'api_key' ? selected.key : selected.access}`);
  // A deleted/replaced named profile must never appear as the built-in login.
  // This is a snapshot of the last verified binding, not an activation side effect.
  const usage = currentAccountId !== null && (!selected || !bindingMatchesStore)
    ? { effectiveCredential: 'unavailable' as const, status: 'unavailable' as const, remoteEntitlement: 'not-queried' as const, settingsUrl: null }
    : effectiveOpenAIUsage(owner.context, selected, result?.status === "active");
  return {
    protocol: 1,
    serviceEpoch,
    selectionRevision: owner.selectionRevisions.get("openai") ?? 0,
    sessionId: owner.sessionId,
    accounts,
    currentAccountId,
    defaultSelected: currentAccountId === null,
    activationStatus: result?.status === "error" || (currentAccountId !== null && !selected) ? "activation-failed" : pending ? "activation-pending" : result?.status === "active" && bindingMatchesStore ? "active" : "inactive",
    busy,
    canSwitch: !busy && !pending,
    usage,
  };
}

function effectiveOpenAIUsage(
  ctx: ExtensionContext,
  selected: StoredCredential | undefined,
  active: boolean,
): AccountControlsSnapshot["usage"] {
  if (selected?.type === "api_key") {
    return {
      effectiveCredential: active ? "api-key-configured" : "unavailable",
      status: active ? "local-binding-confirmed" : "unavailable",
      remoteEntitlement: "not-queried",
      settingsUrl: "https://platform.openai.com/settings/organization/usage",
    };
  }
  if (selected?.type === "oauth") {
    return {
      effectiveCredential: active ? "chatgpt-grant-matched-refreshed" : "unavailable",
      status: active ? "local-binding-confirmed" : "unavailable",
      remoteEntitlement: "not-queried",
      settingsUrl: "https://chatgpt.com/settings/usage",
    };
  }
  try {
    const provider = ctx.modelRegistry.getProvider("openai");
    const model = provider?.getModels()[0];
    const authStatus = ctx.modelRegistry.getProviderAuthStatus("openai");
    if (!authStatus.configured) return { effectiveCredential: "unavailable", status: "unavailable", remoteEntitlement: "not-queried", settingsUrl: null };
    if (!model) return { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: null };
    if (ctx.modelRegistry.isUsingOAuth(model)) {
      return { effectiveCredential: "chatgpt-grant-configured", status: "local-binding-confirmed", remoteEntitlement: "not-queried", settingsUrl: "https://chatgpt.com/settings/usage" };
    }
    return { effectiveCredential: "api-key-configured", status: "local-binding-confirmed", remoteEntitlement: "not-queried", settingsUrl: "https://platform.openai.com/settings/organization/usage" };
  } catch {
    return { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: null };
  }
}

function safeLabel(value: string): string {
  return [...value].filter((character) => !/[\p{Cc}\p{Cf}\u001b]/u.test(character)).join("").slice(0, 64) || "Account";
}
