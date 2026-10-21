/** Paseo-safe account controls protocol. Contains identifiers/status only; never secrets. */
export const ACCOUNT_CONTROLS_PROTOCOL = 1 as const;
export const ACCOUNT_CONTROLS_KEY = "__paeAccountControlsV1" as const;
/** Lifetime-owned service on globalThis[ACCOUNT_CONTROLS_KEY], like the existing foreground service. */
export interface AccountControlsService {
  protocol: typeof ACCOUNT_CONTROLS_PROTOCOL;
  sessionId: string;
  serviceEpoch: string;
  getSnapshot(request: {sessionId: string}): Promise<AccountControlsSnapshot>;
  switchAccount(request: AccountSwitchRequest): Promise<AccountSwitchResult>;
}

export type AccountAuthKind = "oauth" | "api-key" | "default";
export type AccountActivationStatus = "active" | "inactive" | "activation-pending" | "activation-failed";
export interface SafeAccountLabel {
  /** Stable opaque identifier, not a credential or provider account ID. */
  id: string;
  label: string;
  authKind: Exclude<AccountAuthKind, "default">;
}
export interface AccountControlsSnapshot {
  protocol: typeof ACCOUNT_CONTROLS_PROTOCOL;
  serviceEpoch: string;
  /** Monotonic per-session selection revision; incremented on every accepted selection change. */
  selectionRevision: number;
  sessionId: string;
  accounts: SafeAccountLabel[];
  currentAccountId: string | null;
  defaultSelected: boolean;
  activationStatus: AccountActivationStatus;
  /** Advisory UI state only; switchAccount must independently enforce idleness. */
  busy: boolean;
  canSwitch: boolean;
  /** Local credential binding only; never implies remote quota/entitlement verification. */
  usage: {
    effectiveCredential: "api-key-configured" | "chatgpt-grant-configured" | "chatgpt-grant-matched-refreshed" | "unavailable" | "unknown";
    /** Local binding only; never remote validity or quota status. */
    status: "local-binding-confirmed" | "unavailable" | "unknown";
    remoteEntitlement: "not-queried";
    /** Hash of the verified OAuth account/user identity, not of a credential. Absent when unverified. */
    accountKey?: string;
    /** Noncredential key linking a verified native OpenAI OAuth registration; absent when unverified. */
    nativeRegistrationKey?: string;
    /** Distinguishes an unsupported older service from a rejected current binding. */
    nativeRegistrationVersion?: 1;
    settingsUrl: "https://platform.openai.com/settings/organization/usage" | "https://chatgpt.com/settings/usage" | null;
  };
}
export interface AccountSwitchRequest {
  protocol: typeof ACCOUNT_CONTROLS_PROTOCOL;
  requestId: string;
  expectedSessionId: string;
  expectedServiceEpoch: string;
  /** Rejects stale concurrent-client selections within the same service/session lifetime. */
  expectedSelectionRevision: number;
  /** null explicitly restores Pi's built-in default authentication. */
  accountId: string | null;
}
export type AccountSwitchResult =
  | { ok: true; requestId: string; snapshot: AccountControlsSnapshot }
  | { ok: false; requestId: string; reason: "stale-session" | "stale-service" | "stale-selection" | "busy" | "unknown-account" | "activation-failed" | "request-id-conflict" | "invalid-request"; snapshot: AccountControlsSnapshot };

/**
 * Implementations must resolve a completed requestId before checking expectedSelectionRevision.
 * Replay only when accountId, expectedSessionId, expectedServiceEpoch, and
 * expectedSelectionRevision all match the original request; otherwise return request-id-conflict.
 */
export const ACCOUNT_SWITCH_IDEMPOTENCY_ORDER = "exact-intent-replay-before-selection-revision" as const;
/** Public errors must not include raw provider or credential-store exception values. */
export const ACCOUNT_CONTROLS_ERROR_POLICY = "redacted-safe-codes-only" as const;
/** Runtime integrations should use ModelRegistry public provider/auth APIs. Any private compatibility access must be explicit and tested against installed Pi 1.0.0. */
export const ACCOUNT_CONTROLS_REGISTRY_POLICY = "public-provider-auth-api-preferred" as const;
/** Restoring built-in default must restore the complete provider configuration snapshot, not only its API key. */
export const ACCOUNT_CONTROLS_RESTORE_POLICY = "preserve-complete-provider-configuration" as const;
