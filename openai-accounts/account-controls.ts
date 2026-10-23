import { createHash } from "node:crypto";
import {
	constants,
	openSync,
	closeSync,
	fstatSync,
	readSync,
	readFileSync,
} from "node:fs";
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
	providerId: "openai" | "openai-codex" = "openai",
): Promise<AccountControlsSnapshot> {
	const readTimeout = AbortSignal.timeout(5_000);
	const data = await store.readAsync(
		AbortSignal.any([owner.signal, readTimeout]),
	);
	const state = data.providers.openai;
	const accounts: SafeAccountLabel[] = Object.entries(
		state?.accounts ?? {},
	).map(([name, credential]) => ({
		id: name,
		label: safeLabel(
			typeof (credential as { label?: unknown }).label === "string"
				? (credential as { label: string }).label
				: name,
		),
		authKind: credential.type === "api_key" ? "api-key" : "oauth",
	}));
	const currentAccountId = owner.selections.openai ?? null;
	const selected = currentAccountId
		? state?.accounts[currentAccountId]
		: undefined;
	const result = owner.results.get("openai");
	const pending = owner.pendingSyncTasks.has("openai");
	const busy =
		!owner.context.isIdle() ||
		owner.switchReserved > 0 ||
		owner.openAIRequestCount > 0 ||
		pending;
	const bindingMatchesStore = Boolean(
		currentAccountId &&
			selected &&
			owner.appliedIdentities.get("openai") ===
				`${currentAccountId}:${selected.type === "api_key" ? selected.key : selected.access}`,
	);
	// A deleted/replaced named profile must never appear as the built-in login.
	// This is a snapshot of the last verified binding, not an activation side effect.
	const usage =
		currentAccountId !== null && (!selected || !bindingMatchesStore)
			? {
					effectiveCredential: "unavailable" as const,
					status: "unavailable" as const,
					remoteEntitlement: "not-queried" as const,
					settingsUrl: null,
				}
			: effectiveOpenAIUsage(
					owner.context,
					selected,
					result?.status === "active",
				);
	const snapshotRevision = owner.selectionRevisions.get("openai") ?? 0;
	let nativeRegistrationKey: string | undefined;
	if (
		currentAccountId !== null &&
		selected?.type === "oauth" &&
		bindingMatchesStore &&
		result?.status === "active" &&
		!pending
	) {
		if (
			officialOrigin(
				owner.context.model?.baseUrl ??
					owner.context.modelRegistry.getProvider("openai")?.baseUrl,
			) &&
			owner.context.model?.api === "openai-responses" &&
			!hasAuthHeaders(owner.context.model?.headers) &&
			!hasAuthHeaders(
				owner.context.modelRegistry.getProvider("openai")?.headers,
			)
		)
			nativeRegistrationKey = nativeKey(selected);
		if (
			!isOwnerCurrent(owner) ||
			owner.selections.openai !== currentAccountId ||
			(owner.selectionRevisions.get("openai") ?? 0) !== snapshotRevision ||
			owner.appliedIdentities.get("openai") !==
				`${currentAccountId}:${selected.access}`
		)
			nativeRegistrationKey = undefined;
	} else if (
		currentAccountId === null &&
		usage.effectiveCredential === "chatgpt-grant-configured" &&
		usage.status === "local-binding-confirmed"
	) {
		nativeRegistrationKey = defaultNativeKey(owner.context);
		if (
			!isOwnerCurrent(owner) ||
			(owner.selections.openai ?? null) !== null ||
			(owner.selectionRevisions.get("openai") ?? 0) !== snapshotRevision
		)
			nativeRegistrationKey = undefined;
	}
	return {
		protocol: 1,
		providerId,
		supportedProviders: ["openai", "openai-codex"],
		serviceEpoch,
		selectionRevision: owner.selectionRevisions.get("openai") ?? 0,
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
			nativeRegistrationVersion: 1,
			...(bindingMatchesStore &&
			result?.status === "active" &&
			!pending &&
			selected?.type === "oauth"
				? verifiedAccountKey(selected)
				: {}),
			...(nativeRegistrationKey ? { nativeRegistrationKey } : {}),
		},
	};
}

function nativeKey(credential: StoredCredential): string | undefined {
	try {
		if (
			credential.type !== "oauth" ||
			typeof credential.access !== "string" ||
			!validIdentity(credential.clientId) ||
			!Array.isArray(credential.scopes) ||
			!credential.scopes.includes("chatgpt.tokens.use.direct")
		)
			return undefined;
		const sub = jwtSubject(credential.access);
		return sub
			? createHash("sha256")
					.update(JSON.stringify(["openai-native", credential.clientId, sub]))
					.digest("hex")
			: undefined;
	} catch {
		return undefined;
	}
}

function jwtSubject(token: string): string | undefined {
	try {
		const segments = token.split(".");
		if (segments.length !== 3) return undefined;
		const claims = JSON.parse(
			Buffer.from(segments[1]!, "base64url").toString("utf8"),
		);
		return validIdentity(claims?.sub) ? claims.sub : undefined;
	} catch {
		return undefined;
	}
}

function validIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
	);
}

function isOwnerCurrent(owner: SessionSelectionOwner): boolean {
	return (
		!owner.signal.aborted &&
		owner.sessionManager.getSessionId() === owner.sessionId
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
function officialOrigin(url: unknown): boolean {
	try {
		return (
			typeof url === "string" &&
			new URL(url).origin === "https://api.openai.com"
		);
	} catch {
		return false;
	}
}
function defaultNativeKey(ctx: ExtensionContext): string | undefined {
	try {
		const provider = ctx.modelRegistry.getProvider("openai");
		const registered = ctx.modelRegistry.getRegisteredProviderConfig("openai");
		if (ctx.modelRegistry.getRegisteredNativeProvider("openai"))
			return undefined;
		const model = ctx.model;
		if (
			!provider ||
			!model ||
			!["openai", "idle-guard"].includes(model.provider) ||
			model.api !== "openai-responses" ||
			!officialOrigin(model.baseUrl ?? provider.baseUrl) ||
			!officialOrigin(provider.baseUrl) ||
			hasAuthHeaders(model.headers) ||
			hasAuthHeaders(provider.headers)
		)
			return undefined;
		if (
			registered &&
			(registered.apiKey ||
				registered.oauth ||
				registered.authHeader === false ||
				hasAuthHeaders(registered.headers) ||
				(registered.baseUrl && !officialOrigin(registered.baseUrl)))
		)
			return undefined;
		// Stored OAuth must win; do not execute auth resolvers, commands or refreshes.
		const auth = ctx.modelRegistry.getProviderAuthStatus("openai");
		const nativeModel = provider.getModels()[0];
		if (
			!auth.configured ||
			auth.source !== "stored" ||
			!nativeModel ||
			!ctx.modelRegistry.isUsingOAuth(nativeModel)
		)
			return undefined;
		try {
			const config = JSON.parse(
				readFileSync(join(getAgentDir(), "models.json"), "utf8"),
			)?.providers?.openai;
			if (
				config &&
				(config.authHeader === false ||
					hasAuthHeaders(config.headers) ||
					(config.baseUrl && !officialOrigin(config.baseUrl)) ||
					(Array.isArray(config.models) &&
						config.models.some((m: any) => hasAuthHeaders(m?.headers))))
			)
				return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		const path = join(getAgentDir(), "auth.json");
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = fstatSync(fd);
			const max = 1024 * 1024;
			if (
				!stat.isFile() ||
				(stat.mode & 0o077) !== 0 ||
				stat.size > max ||
				(process.getuid && stat.uid !== process.getuid())
			)
				return undefined;
			const buffer = Buffer.alloc(max + 1);
			let size = 0;
			while (size < buffer.length) {
				const n = readSync(fd, buffer, size, buffer.length - size, size);
				if (!n) break;
				size += n;
			}
			if (size > max) return undefined;
			const authFile = JSON.parse(buffer.subarray(0, size).toString("utf8"));
			const entry = authFile?.openai;
			if (
				!entry ||
				entry.type !== "oauth" ||
				typeof entry.access !== "string" ||
				typeof entry.clientId !== "string" ||
				!Array.isArray(entry.scopes) ||
				!entry.scopes.includes("chatgpt.tokens.use.direct")
			)
				return undefined;
			return nativeKey(entry as StoredCredential);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
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
						.update(JSON.stringify(["openai", accountId, subject]))
						.digest("hex"),
				}
			: {};
	} catch {
		return {};
	}
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
			effectiveCredential: active
				? "chatgpt-grant-matched-refreshed"
				: "unavailable",
			status: active ? "local-binding-confirmed" : "unavailable",
			remoteEntitlement: "not-queried",
			settingsUrl: "https://chatgpt.com/settings/usage",
		};
	}
	try {
		const provider = ctx.modelRegistry.getProvider("openai");
		const model = provider?.getModels()[0];
		const authStatus = ctx.modelRegistry.getProviderAuthStatus("openai");
		if (!authStatus.configured)
			return {
				effectiveCredential: "unavailable",
				status: "unavailable",
				remoteEntitlement: "not-queried",
				settingsUrl: null,
			};
		if (!model)
			return {
				effectiveCredential: "unknown",
				status: "unknown",
				remoteEntitlement: "not-queried",
				settingsUrl: null,
			};
		if (ctx.modelRegistry.isUsingOAuth(model)) {
			return {
				effectiveCredential: "chatgpt-grant-configured",
				status: "local-binding-confirmed",
				remoteEntitlement: "not-queried",
				settingsUrl: "https://chatgpt.com/settings/usage",
			};
		}
		return {
			effectiveCredential: "api-key-configured",
			status: "local-binding-confirmed",
			remoteEntitlement: "not-queried",
			settingsUrl: "https://platform.openai.com/settings/organization/usage",
		};
	} catch {
		return {
			effectiveCredential: "unknown",
			status: "unknown",
			remoteEntitlement: "not-queried",
			settingsUrl: null,
		};
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
