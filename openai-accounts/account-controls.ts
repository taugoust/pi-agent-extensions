import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readPrivateAuthJson } from "./private-auth-json.js";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	AccountControlsSnapshot,
	SafeAccountLabel,
} from "../shared/account-controls.js";
import type { AccountStore, StoredCredential } from "./account-store.js";
import type { SessionSelectionOwner } from "./accounts.js";

export async function createAccountControlsSnapshot(
	owner: SessionSelectionOwner,
	store: AccountStore,
	serviceEpoch: string,
	pendingAccountNames: readonly string[] = [],
): Promise<AccountControlsSnapshot> {
	const providerId = "openai-codex" as const;
	const readTimeout = AbortSignal.timeout(5_000);
	const data = await store.readAsync(
		AbortSignal.any([owner.signal, readTimeout]),
	);
	const state = data.providers[providerId];
	const accounts: SafeAccountLabel[] = Object.entries(
		state?.accounts ?? {},
	).map(([name, credential]) => ({
		id: name,
		label: safeLabel(
			typeof (credential as { label?: unknown }).label === "string"
				? (credential as unknown as { label: string }).label
				: name,
		),
		authKind: credential.type === "api_key" ? "api-key" : "oauth",
	}));
	const currentAccountId = owner.selections[providerId] ?? null;
	const selected = currentAccountId
		? state?.accounts[currentAccountId]
		: undefined;
	const result = owner.results.get(providerId);
	const pending = owner.pendingSyncTasks.has(providerId);
	const busy =
		!owner.context.isIdle() ||
		owner.switchReserved > 0 ||
		owner.openAIRequestCount > 0 ||
		pending;
	const bindingMatchesStore = Boolean(
		currentAccountId &&
			selected &&
			owner.appliedIdentities.get(providerId) ===
				`${currentAccountId}:${selected.type === "api_key" ? selected.key : selected.access}`,
	);
	// A deleted/replaced named profile must never appear as the built-in login.
	// This is a snapshot of the last verified binding, not an activation side effect.
	const codexBindingEligible = officialCodexBinding(owner.context);
	const defaultCodexKey = currentAccountId === null && codexBindingEligible
		? defaultCodexAccountKey(owner.context)
		: undefined;
	const unavailable = currentAccountId !== null &&
		(!selected || !bindingMatchesStore || !codexBindingEligible);
	const usage: AccountControlsSnapshot["usage"] = unavailable
		? {
				effectiveCredential: "unavailable",
				status: "unavailable",
				remoteEntitlement: "not-queried",
				settingsUrl: null,
			}
		: selected
			? {
					effectiveCredential: selected.type === "api_key"
						? "api-key-configured"
						: "chatgpt-grant-matched-refreshed",
					status: result?.status === "active" && codexBindingEligible
						? "local-binding-confirmed"
						: "unavailable",
					remoteEntitlement: "not-queried",
					settingsUrl: null,
				}
			: defaultCodexKey
				? {
						effectiveCredential: "chatgpt-grant-configured",
						status: "local-binding-confirmed",
						remoteEntitlement: "not-queried",
						settingsUrl: null,
					}
				: {
						effectiveCredential: "unknown",
						status: "unknown",
						remoteEntitlement: "not-queried",
						settingsUrl: null,
					};
	return {
		protocol: 1,
		providerId,
		serviceEpoch,
		selectionRevision: owner.selectionRevisions.get(providerId) ?? 0,
		sessionId: owner.sessionId,
		accounts,
		currentAccountId,
		defaultSelected: currentAccountId === null,
		activationStatus:
			result?.status === "error" || (currentAccountId !== null && !selected)
				? "activation-failed"
				: pending
					? "activation-pending"
					: result?.status === "active" && bindingMatchesStore
						? "active"
						: "inactive",
		busy,
		canSwitch: !busy && !pending,
		...(pendingAccountNames.length
			? { pendingAccountNames: pendingAccountNames.slice(0, 20) }
			: {}),
		usage: {
			...usage,
			...(defaultCodexKey ? { accountKey: defaultCodexKey } : {}),
			...(bindingMatchesStore &&
			codexBindingEligible &&
			result?.status === "active" &&
			!pending &&
			selected?.type === "oauth"
				? verifiedAccountKey(selected)
				: {}),
		},
	};
}

function validIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
	);
}

function hasAuthHeaders(headers: unknown): boolean {
	if (headers === undefined) return false;
	if (!headers || typeof headers !== "object" || Array.isArray(headers))
		return true;
	return Object.keys(headers).some((key) =>
		/^(authorization|x-api-key|chatgpt-account-id|openai-organization|openai-project)$/i.test(
			key,
		),
	);
}
function officialCodexBinding(ctx: ExtensionContext): boolean {
	const provider = ctx.modelRegistry.getProvider("openai-codex");
	if (!provider || !officialCodexOrigin(provider.baseUrl) || hasAuthHeaders(provider.headers)) return false;
	const models = ctx.modelRegistry.getAll().filter((model) => model.provider === "openai-codex");
	if (ctx.model?.provider === "openai-codex" && !models.some((model) => model.id === ctx.model!.id)) models.push(ctx.model);
	return models.length > 0 && models.every((model) => model.api === "openai-codex-responses" && officialCodexOrigin(model.baseUrl ?? provider.baseUrl) && !hasAuthHeaders(model.headers));
}
function officialCodexOrigin(url: unknown): boolean {
	try { return typeof url === "string" && new URL(url).origin === "https://chatgpt.com"; } catch { return false; }
}
function defaultCodexAccountKey(ctx: ExtensionContext): string | undefined {
	try {
		const provider = ctx.modelRegistry.getProvider("openai-codex");
		const registered = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
		if (!provider || ctx.modelRegistry.getRegisteredNativeProvider("openai-codex") || !officialCodexBinding(ctx)) return undefined;
		if (registered && (registered.apiKey || registered.oauth || registered.authHeader === false || hasAuthHeaders(registered.headers) || (registered.baseUrl && !officialCodexOrigin(registered.baseUrl)))) return undefined;
		const auth = ctx.modelRegistry.getProviderAuthStatus("openai-codex");
		const nativeModel = provider.getModels()[0];
		if (!auth.configured || auth.source !== "stored" || !nativeModel || !ctx.modelRegistry.isUsingOAuth(nativeModel)) return undefined;
		const config = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8"))?.providers?.["openai-codex"];
		const unsafeModels = Array.isArray(config?.models) && config.models.some((model: any) => hasAuthHeaders(model?.headers) || (model?.baseUrl && !officialCodexOrigin(model.baseUrl)));
		const unsafeProvider = config && (config.apiKey || config.oauth || config.authHeader === false || hasAuthHeaders(config.headers) || (config.baseUrl && !officialCodexOrigin(config.baseUrl)));
		if (unsafeProvider || unsafeModels) return undefined;
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
	try {
		const entry = readPrivateAuthJson(getAgentDir())?.["openai-codex"];
		if (!entry || entry.type !== "oauth" || typeof entry.access !== "string") return undefined;
		return verifiedAccountKey(entry as StoredCredential).accountKey;
	} catch { return undefined; }
}

/** Publish only a noncredential identity for the exact locally applied named grant. */
function verifiedAccountKey(credential: StoredCredential): {
	accountKey?: string;
} {
	try {
		if (credential.type !== "oauth" || typeof credential.access !== "string")
			return {};
		const claims = JSON.parse(
			Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		);
		const valid = validIdentity;
		const claimId =
			claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
			claims?.chatgpt_account_id;
		const storedId = credential.accountId;
		if (valid(claimId) && valid(storedId) && claimId !== storedId) return {};
		const accountId = valid(claimId)
			? claimId
			: valid(storedId)
				? storedId
				: undefined;
		const subject =
			claims?.sub ?? claims?.["https://api.openai.com/auth"]?.chatgpt_user_id;
		// Team account IDs can be shared by different people; bind the user as well.
		return accountId && valid(subject)
			? {
					accountKey: createHash("sha256")
						.update(JSON.stringify(["openai-codex", accountId, subject]))
						.digest("hex"),
				}
			: {};
	} catch {
		return {};
	}
}

function safeLabel(value: string): string {
	return (
		[...value]
			.filter((character) => !/[\p{Cc}\p{Cf}\u001b]/u.test(character))
			.join("")
			.slice(0, 64) || "Account"
	);
}
