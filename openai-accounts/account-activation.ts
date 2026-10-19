import { type AccountStore, getOwnCredential, parseAccountName } from "./account-store.js";
import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./accounts.js";
import type {
  AccountActivationErrorCode,
  AccountActivationResult,
  AccountsActivationRequest,
} from "./accounts-protocol.js";
import type { AccountProviderId } from "./oauth.js";
import type { EnsureActiveProviderAuthResult } from "./runtime-auth.js";

// A replacement sync belongs to the session, not the requesting consumer. Stop waiting on
// cancellation without aborting that shared work, and release the listener on settlement.
async function waitForActivation<T>(task: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createAccountActivation(
  store: AccountStore,
  adapters: ReadonlyMap<AccountProviderId, unknown>,
  getOwner: (session: object) => SessionSelectionOwner | undefined,
  isOwnerCurrent: (owner: SessionSelectionOwner) => boolean,
  persistSelection: PersistSelection,
  syncProvider: SyncProvider,
): (request: AccountsActivationRequest) => Promise<AccountActivationResult> {
  return async (request) => {
    const error = (code: AccountActivationErrorCode): AccountActivationResult => ({
      status: "error",
      providerId: request.provider,
      accountName: request.account,
      code,
    });
    const providerId = request.provider as AccountProviderId;
    if (!adapters.has(providerId)) return error("provider_unsupported");
    const owner = getOwner(request.session);
    if (!owner || !isOwnerCurrent(owner)) return error("session_unavailable");
    if (request.signal?.aborted) return error("cancelled");
    const canSwitchNow = () => owner.context.isIdle() && owner.switchReserved === 0 && owner.openAIRequestCount === 0 && !owner.pendingSyncTasks.has(providerId);
    if (!canSwitchNow()) return error("activation_failed");
    const initialSelectionRevision = owner.selectionRevisions.get(providerId) ?? 0;
    if (request.account !== null) {
      const parsed = parseAccountName(request.account);
      if (!parsed.ok || parsed.name !== request.account) return error("account_not_found");
    }
    // Reads can wait behind refreshes; only the newest explicit request may publish its selection.
    const generation = (owner.activationRequests.get(providerId) ?? 0) + 1;
    owner.activationRequests.set(providerId, generation);
    let selectionRevision = owner.selectionRevisions.get(providerId) ?? 0;
    const isRequestCurrent = () =>
      owner.activationRequests.get(providerId) === generation &&
      (owner.selectionRevisions.get(providerId) ?? 0) === selectionRevision;
    const unavailable = (): AccountActivationResult | undefined => {
      if (!isOwnerCurrent(owner) || owner.sessionId !== owner.sessionManager.getSessionId())
        return error("session_unavailable");
      if (request.signal?.aborted) return error("cancelled");
      if (!isRequestCurrent()) return error("activation_superseded");
    };
    const activationSignal = AbortSignal.any([owner.signal, ...(request.signal ? [request.signal] : [])]);
    await waitForActivation(owner.ready, activationSignal);
    const staleAfterStartup = unavailable();
    if (staleAfterStartup) return staleAfterStartup;
    if (request.account !== null) {
      try {
        const data = await store.readAsync(
          AbortSignal.any([owner.signal, ...(request.signal ? [request.signal] : [])]),
        );
        const staleAfterRead = unavailable();
        if (staleAfterRead) return staleAfterRead;
        if (!getOwnCredential(data.providers[providerId]?.accounts ?? {}, request.account))
          return error("account_not_found");
      } catch {
        return unavailable() ?? error("store_unavailable");
      }
    }
    if (!canSwitchNow() || (owner.selectionRevisions.get(providerId) ?? 0) !== initialSelectionRevision) return error("activation_superseded");
    try {
      if (!persistSelection(owner, providerId, request.account, isRequestCurrent))
        return unavailable() ?? error("session_unavailable");
    } catch {
      return unavailable() ?? error("store_unavailable");
    }
    selectionRevision = owner.selectionRevisions.get(providerId) ?? 0;
    let task = syncProvider(providerId, owner.context, owner, request.signal);
    let result: EnsureActiveProviderAuthResult;
    try {
      // Routine model/turn syncs may replace this task without changing the selection.
      while (true) {
        const settled = await waitForActivation(task, activationSignal);
        const staleAfterSync = unavailable();
        if (staleAfterSync) return staleAfterSync;
        if (!settled) return error("activation_failed");
        result = settled;
        const latest = owner.syncTasks.get(providerId);
        if (!latest || latest === task) break;
        task = latest;
      }
    } catch {
      return unavailable() ?? error("activation_failed");
    }

    if (result.status === "error") return error(result.code ?? "activation_failed");
    if (result.status === "inactive") {
      return request.account === null
        ? { status: "inactive", providerId, accountName: null }
        : error("activation_failed");
    }
    if (result.accountName !== request.account) return error("activation_superseded");
    if (request.model && !owner.coordinators.get(providerId)?.isModelAvailable(request.model))
      return error("model_unavailable");
    return { status: "active", providerId, accountName: result.accountName };
  };
}
