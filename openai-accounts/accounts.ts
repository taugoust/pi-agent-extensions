import { randomUUID } from "node:crypto";
import { lazyStream } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAccountControlsSnapshot } from "./account-controls.js";
import {
	ACCOUNT_CONTROLS_KEY,
	ACCOUNT_CONTROLS_PROTOCOL,
	type AccountControlsService,
	type AccountManagementRequest,
	type AccountControlsSnapshot,
	type AccountSwitchRequest,
	type AccountSwitchResult,
} from "../shared/account-controls.js";
import { createAccountActivation } from "./account-activation.js";
import {
	AccountStore,
	defineOwn,
	defineOwnMap,
	getOwnCredential,
	normalizeApiKeyCredential,
	normalizeStoredCredential,
	parseAccountName,
	type StoredCredential,
} from "./account-store.js";
import { registerAccountsProtocol } from "./accounts-protocol.js";
import {
	type AccountProviderAdapter,
	type AccountProviderId,
	createBuiltinProviderAdapters,
	loginWithOAuthUI,
	SUPPORTED_PROVIDER_IDS,
} from "./oauth.js";
import {
	parseCredentialReadinessRequest,
	parseCredentialRequest,
	registerOAuthCredentialReadiness,
	registerOAuthCredentialSource,
} from "./oauth-credential-source.js";
import {
	type EnsureActiveProviderAuthResult,
	RUNTIME_FAIL_CLOSED_API_KEY,
	RuntimeAuthCoordinator,
	redactTokenText,
} from "./runtime-auth.js";
import {
	ACCOUNT_SELECTION_ENTRY_TYPE,
	cloneAccountSelections,
	createAccountSelectionEntryData,
	type ProviderAccountSelections,
	restoreAccountSelections,
	setAccountSelection,
} from "./session-selection.js";

export {
	ACCOUNTS_FILE,
	AccountStore,
	type AccountsData,
	InMemoryAccountStorageBackend,
	type ProviderAccountsData,
	parseAccountName,
	parseAccountsData,
	type StoredApiKeyCredential,
	type StoredCredential,
	type StoredOAuthCredential,
} from "./account-store.js";

export const ACCOUNTS_STATUS_KEY = "accounts";
export const FAIL_CLOSED_API_KEY = RUNTIME_FAIL_CLOSED_API_KEY;
export const DEFAULT_PI_LOGIN_LABEL = "(default pi login)";

function loginKey(providerId: AccountProviderId, accountName: string): string {
	return `${providerId}:${accountName}`;
}

export type AccountsDependencies = {
	store?: AccountStore;
	providers?: readonly AccountProviderAdapter[];
};

type SessionEntryWriter = {
	appendCustomEntry(customType: string, data?: unknown): string;
};

export type SessionSelectionOwner = {
	context: ExtensionContext;
	sessionManager: ExtensionContext["sessionManager"] & SessionEntryWriter;
	sessionId: string;
	/** Covers queued account-control operations; UI state only, also checked by admission. */
	switchReserved: number;
	openAIRequestCount: number;
	selections: ProviderAccountSelections;
	selectionRevisions: Map<AccountProviderId, number>;
	activationRequests: Map<AccountProviderId, number>;
	error?: string;
	controller: AbortController;
	signal: AbortSignal;
	ready: Promise<void>;
	coordinators: Map<AccountProviderId, RuntimeAuthCoordinator>;
	results: Map<AccountProviderId, EnsureActiveProviderAuthResult>;
	appliedIdentities: Map<AccountProviderId, string>;
	abortProviders: Set<AccountProviderId>;
	syncTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
	pendingSyncTasks: Map<
		AccountProviderId,
		Promise<EnsureActiveProviderAuthResult>
	>;
	startupTask: Promise<void>;
	startupTasks: Map<AccountProviderId, Promise<EnsureActiveProviderAuthResult>>;
	startupCompletedProviders: Set<AccountProviderId>;
};

export type SyncProvider = (
	providerId: AccountProviderId,
	ctx: ExtensionContext,
	owner: SessionSelectionOwner,
	ownerSignal?: AbortSignal,
	model?: ExtensionContext["model"],
) => Promise<EnsureActiveProviderAuthResult>;

export type PersistSelection = (
	owner: SessionSelectionOwner,
	providerId: AccountProviderId,
	accountName: string | null,
	isCurrent: () => boolean,
) => boolean;

export default function accountsExtension(
	pi: ExtensionAPI,
	dependencies: AccountsDependencies = {},
): void {
	const store = dependencies.store ?? new AccountStore();
	const providers = [
		...(dependencies.providers ?? createBuiltinProviderAdapters()),
	];
	validateProviderSet(providers, dependencies.providers === undefined);
	const adapters = new Map(
		providers.map((provider) => [provider.id, provider]),
	);
	const sessionOwners = new WeakMap<
		ExtensionContext["sessionManager"],
		SessionSelectionOwner
	>();
	const openAIGates = new WeakMap<
		object,
		{
			previous: ReturnType<
				ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]
			>;
			applied: ReturnType<
				ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]
			>;
		}
	>();
	const serviceEpoch = randomUUID();
	const completedRequests = new Map<
		string,
		{ fingerprint: string; result: AccountSwitchResult }
	>();
	const inFlightRequests = new Map<
		string,
		{ fingerprint: string; result: Promise<AccountSwitchResult> }
	>();
	const paseoLoginInFlight = new Map<string, AbortController>();
	let switchTail: Promise<void> = Promise.resolve();
	let activeOwner: SessionSelectionOwner | undefined;
	const accountControlsService: AccountControlsService = {
		protocol: ACCOUNT_CONTROLS_PROTOCOL,
		sessionId: "",
		serviceEpoch,
		getSnapshot: async ({ sessionId, providerId = "openai" }) => {
			if (
				(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] !==
				accountControlsService
			)
				throw new Error("stale-service");
			const owner = activeOwner;
			if (!owner || owner.sessionId !== sessionId || !isOwnerCurrent(owner))
				throw new Error("stale-session");
			const snapshot = await snapshotFor(owner, providerId);
			if (
				!isOwnerCurrent(owner) ||
				activeOwner !== owner ||
				owner.sessionId !== sessionId
			)
				throw new Error("stale-session");
			return snapshot;
		},
		switchAccount: async (request) => switchViaService(request),
		manageAccount: async (request) => manageViaService(request),
	};
	(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] =
		accountControlsService;

	const manageViaService = async (request: AccountManagementRequest) => {
		if (
			(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] !==
			accountControlsService
		)
			throw new Error("stale-service");
		const owner = activeOwner;
		if (
			!owner ||
			request.sessionId !== owner.sessionId ||
			!isOwnerCurrent(owner)
		)
			throw new Error("stale-session");
		await owner.ready;
		if (!isOwnerCurrent(owner) || activeOwner !== owner)
			throw new Error("stale-session");
		const providerId = request.providerId ?? "openai";
		if (request.operation === "cancel-login") {
			paseoLoginInFlight.get(loginKey(providerId, request.accountName))?.abort(new DOMException("Pi account sign-in cancelled", "AbortError"));
			return { ok: true as const, sessionId: owner.sessionId };
		}
		if (!canMutateAccountState(owner.context, owner, providerId))
			throw new Error("Pi must be idle before managing accounts.");
		const adapter = adapters.get(providerId);
		if (!adapter)
			throw new Error(`Native ${providerId} account management is unavailable.`);
		const ensureManagementCurrent = () => {
			if (
				!isOwnerCurrent(owner) ||
				activeOwner !== owner ||
				!canMutateAccountState(owner.context, owner, providerId)
			)
				throw new Error(
					"Pi became busy or its account session changed; refresh and retry.",
				);
		};
		if (request.operation === "add") {
			let name = request.accountName?.trim() ?? "";
			if (!name)
				name =
					(
						await (owner.context as ExtensionCommandContext).ui.input(
							`${adapter.displayName} account name`,
							"e.g. personal",
							{ signal: owner.signal },
						)
					)?.trim() ?? "";
			if (!name) throw new Error("Account creation was cancelled.");
			const key = loginKey(providerId, name);
			if (paseoLoginInFlight.has(key))
				throw new Error("Sign-in for this Pi account is already in progress.");
			const loginController = new AbortController();
			paseoLoginInFlight.set(key, loginController);
			const loginSignal = AbortSignal.any([
				owner.signal,
				loginController.signal,
			]);
			void loginAccount(
				owner.context as ExtensionCommandContext,
				store,
				adapter,
				name,
				loginSignal,
				syncProvider,
				persistSelection,
				owner,
				() => isOwnerCurrent(owner) && activeOwner === owner,
				request.method,
				false,
			)
				.catch(() => undefined)
				.finally(() => paseoLoginInFlight.delete(key));
			return { ok: true as const, sessionId: owner.sessionId, accountId: name };
		}
		if (request.operation === "default") {
			if (request.accountId !== null) {
				const state = await store.readProviderAsync(providerId, owner.signal);
				if (!Object.hasOwn(state.accounts, request.accountId))
					throw new Error("That Pi account no longer exists.");
			}
			ensureManagementCurrent();
			await store.updateProvider(providerId, (state) => {
				ensureManagementCurrent();
				return { ...state, active: request.accountId ?? undefined };
			});
			ensureManagementCurrent();
		} else if (request.operation === "rename") {
			if (
				!/^[A-Za-z0-9._-]{1,64}$/.test(request.accountId) ||
				!request.label.trim() ||
				request.label.trim().length > 40
			)
				throw new Error("Invalid Pi account name or label.");
			ensureManagementCurrent();
			await store.updateProvider(providerId, (state) => {
				ensureManagementCurrent();
				const credential = state.accounts[request.accountId];
				if (!credential) throw new Error("That Pi account no longer exists.");
				return {
					...state,
					accounts: defineOwn(state.accounts, request.accountId, {
						...credential,
						label: request.label.trim(),
					}),
				};
			});
			ensureManagementCurrent();
		} else {
			if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.accountId))
				throw new Error("Invalid Pi account name.");
			if (owner.selections[providerId] === request.accountId)
				throw new Error(
					"Switch this session away from the account before removing it.",
				);
			ensureManagementCurrent();
			await store.updateProvider(providerId, (state) => {
				ensureManagementCurrent();
				if (!Object.hasOwn(state.accounts, request.accountId))
					throw new Error("That Pi account no longer exists.");
				const accounts = defineOwnMap(state.accounts);
				delete accounts[request.accountId];
				return {
					...state,
					active: state.active === request.accountId ? undefined : state.active,
					accounts,
				};
			});
			ensureManagementCurrent();
		}
		owner.selectionRevisions.set(
			providerId,
			(owner.selectionRevisions.get(providerId) ?? 0) + 1,
		);
		return {
			ok: true as const,
			sessionId: owner.sessionId,
			...(request.operation === "rename"
				? { accountId: request.accountId }
				: {}),
		};
	};

	const snapshotFor = async (
		owner: SessionSelectionOwner,
		providerId: AccountProviderId = "openai",
	): Promise<AccountControlsSnapshot> => {
		try {
			const prefix = `${providerId}:`;
			return await createAccountControlsSnapshot(owner, store, serviceEpoch,
				[...paseoLoginInFlight.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => key.slice(prefix.length)),
				providerId,
			);
		} catch {
			return {
				protocol: ACCOUNT_CONTROLS_PROTOCOL,
				serviceEpoch,
				providerId,
				supportedProviders: SUPPORTED_PROVIDER_IDS,
				selectionRevision: owner.selectionRevisions.get(providerId) ?? 0,
				sessionId: owner.sessionId,
				accounts: [],
				currentAccountId: owner.selections[providerId] ?? null,
				defaultSelected: (owner.selections[providerId] ?? null) === null,
				activationStatus: "activation-failed",
				busy: true,
				canSwitch: false,
				usage: {
					effectiveCredential: "unknown",
					status: "unknown",
					remoteEntitlement: "not-queried",
					settingsUrl: null,
				},
			};
		}
	};

	const switchViaService = async (
		request: AccountSwitchRequest,
	): Promise<AccountSwitchResult> => {
		if (
			(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] !==
			accountControlsService
		)
			throw new Error("stale-service");
		const raw = (request ?? {}) as unknown as Record<string, unknown>;
		const providerId = raw.providerId === undefined ? "openai" : raw.providerId;
		if (providerId !== "openai" && providerId !== "openai-codex") throw new Error("unsupported-provider");
		const requestId =
			typeof raw?.requestId === "string" &&
			raw.requestId.length <= 128 &&
			!/[\p{Cc}]/u.test(raw.requestId)
				? raw.requestId
				: "";
		const owner = activeOwner;
		if (!owner) throw new Error("stale-session");
		if (!requestId)
			return {
				ok: false,
				requestId: "",
				reason: "invalid-request",
				snapshot: await snapshotFor(owner, providerId),
			};
		const bounded = (value: unknown, maximum: number): string | null =>
			typeof value === "string" && value.length <= maximum ? value : null;
		const scopedRequestId = `${providerId}:${requestId}`;
		const fingerprint = JSON.stringify([
			providerId,
			raw.accountId === null ||
			(typeof raw.accountId === "string" && raw.accountId.length <= 64)
				? raw.accountId
				: "<invalid-account>",
			bounded(raw.expectedSessionId, 256),
			bounded(raw.expectedServiceEpoch, 256),
			Number.isSafeInteger(raw.expectedSelectionRevision) &&
			(raw.expectedSelectionRevision as number) >= 0
				? raw.expectedSelectionRevision
				: "<invalid-revision>",
			raw.protocol === ACCOUNT_CONTROLS_PROTOCOL
				? raw.protocol
				: "<invalid-protocol>",
		]);
		const requestValid =
			raw.protocol === ACCOUNT_CONTROLS_PROTOCOL &&
			typeof raw.expectedSessionId === "string" &&
			raw.expectedSessionId.length <= 256 &&
			typeof raw.expectedServiceEpoch === "string" &&
			raw.expectedServiceEpoch.length <= 256 &&
			Number.isSafeInteger(raw.expectedSelectionRevision) &&
			(raw.expectedSelectionRevision as number) >= 0 &&
			(raw.accountId === null ||
				(typeof raw.accountId === "string" && raw.accountId.length <= 64));
		if (!requestValid) {
			const result: AccountSwitchResult = {
				ok: false,
				requestId,
				reason: "invalid-request",
				snapshot: await snapshotFor(owner, providerId),
			};
			completedRequests.set(scopedRequestId, { fingerprint, result });
			return result;
		}
		if (raw.expectedServiceEpoch !== serviceEpoch)
			return {
				ok: false,
				requestId,
				reason: "stale-service",
				snapshot: await snapshotFor(owner, providerId),
			};
		if (
			raw.expectedSessionId !== accountControlsService.sessionId ||
			raw.expectedSessionId !== owner.sessionId
		) {
			return {
				ok: false,
				requestId,
				reason: "stale-session",
				snapshot: await snapshotFor(owner, providerId),
			};
		}
		const completed = completedRequests.get(scopedRequestId);
		if (completed) {
			if (completed.fingerprint === fingerprint) return completed.result;
			return {
				ok: false,
				requestId,
				reason: "request-id-conflict",
				snapshot: await snapshotFor(owner, providerId),
			};
		}
		const running = inFlightRequests.get(scopedRequestId);
		if (running) {
			if (running.fingerprint === fingerprint) return running.result;
			return {
				ok: false,
				requestId,
				reason: "request-id-conflict",
				snapshot: await snapshotFor(owner, providerId),
			};
		}
		if (inFlightRequests.size + completedRequests.size >= 4096) {
			return {
				ok: false,
				requestId,
				reason: "busy",
				snapshot: await snapshotFor(owner, providerId),
			};
		}
		const previous = switchTail;
		let release!: () => void;
		const slot = new Promise<void>((resolve) => {
			release = resolve;
		});
		switchTail = previous.then(
			() => slot,
			() => slot,
		);
		const operation = previous.then(async () => {
			const owner = activeOwner;
			if (owner) owner.switchReserved += 1;
			try {
				const rawResult = await performServiceSwitch({ ...request, providerId });
				const settledSnapshot = await snapshotFor(owner ?? activeOwner!, providerId);
				const ownerNow = owner ?? activeOwner!;
				const busy =
					!ownerNow.context.isIdle() ||
					ownerNow.openAIRequestCount > 0 ||
					ownerNow.pendingSyncTasks.has(providerId) ||
					ownerNow.switchReserved > 1;
				const result = {
					...rawResult,
					snapshot: { ...settledSnapshot, busy, canSwitch: !busy },
				} as AccountSwitchResult;
				completedRequests.set(scopedRequestId, { fingerprint, result });
				return result;
			} finally {
				if (owner) owner.switchReserved = Math.max(0, owner.switchReserved - 1);
				release();
			}
		});
		inFlightRequests.set(scopedRequestId, { fingerprint, result: operation });
		try {
			return await operation;
		} finally {
			if (inFlightRequests.get(scopedRequestId)?.result === operation)
				inFlightRequests.delete(scopedRequestId);
		}
	};

	const performServiceSwitch = async (
		request: AccountSwitchRequest,
	): Promise<AccountSwitchResult> => {
		const providerId = request.providerId ?? "openai";
		const owner = activeOwner;
		if (!owner || !isOwnerCurrent(owner)) throw new Error("stale-session");
		const failure = async (
			reason: Extract<AccountSwitchResult, { ok: false }>["reason"],
		): Promise<AccountSwitchResult> => ({
			ok: false,
			requestId: request.requestId,
			reason,
			snapshot: await snapshotFor(owner, providerId),
		});
		if (
			request.protocol !== ACCOUNT_CONTROLS_PROTOCOL ||
			request.expectedSessionId !== owner.sessionId
		)
			return failure("stale-session");
		if (request.expectedServiceEpoch !== serviceEpoch)
			return failure("stale-service");
		if (
			request.expectedSelectionRevision !==
			(owner.selectionRevisions.get(providerId) ?? 0)
		)
			return failure("stale-selection");
		if (!owner.context.isIdle() || owner.pendingSyncTasks.has(providerId))
			return failure("busy");
		const deadline = AbortSignal.timeout(30_000);
		const signal = AbortSignal.any([owner.signal, deadline]);
		const run = async (): Promise<AccountSwitchResult> => {
			await owner.ready;
			signal.throwIfAborted();
			if (!isOwnerCurrent(owner) || activeOwner !== owner)
				return failure("stale-session");
			const accountId = request.accountId;
			if (accountId !== null) {
				const parsed = parseAccountName(accountId);
				if (!parsed.ok) return failure("unknown-account");
				const stored = await store.readProviderAsync(providerId, signal);
				signal.throwIfAborted();
				if (!Object.hasOwn(stored.accounts, parsed.name))
					return failure("unknown-account");
			}
			signal.throwIfAborted();
			// Final synchronous admission check: no await may intervene before persistence.
			if (
				!isOwnerCurrent(owner) ||
				activeOwner !== owner ||
				accountControlsService.sessionId !== owner.sessionId
			)
				return failure("stale-session");
			if (request.expectedServiceEpoch !== serviceEpoch)
				return failure("stale-service");
			if (
				request.expectedSelectionRevision !==
				(owner.selectionRevisions.get(providerId) ?? 0)
			)
				return failure("stale-selection");
			if (
				!owner.context.isIdle() ||
				owner.pendingSyncTasks.has(providerId) ||
				owner.openAIRequestCount > 0 ||
				owner.switchReserved !== 1
			)
				return failure("busy");
			if (
				!persistSelection(
					owner,
					providerId,
					accountId,
					() =>
						isOwnerCurrent(owner) &&
						activeOwner === owner &&
						owner.context.isIdle(),
				)
			)
				return failure("busy");
			const activated = await syncProvider(
				providerId,
				owner.context,
				owner,
				signal,
			);
			if (!isOwnerCurrent(owner) || activeOwner !== owner)
				return failure("stale-session");
			if (signal.aborted || activated.status === "error")
				return failure("activation-failed");
			return {
				ok: true,
				requestId: request.requestId,
				snapshot: await snapshotFor(owner, providerId),
			};
		};
		const timedOut = new Promise<"timeout">((resolve) =>
			deadline.addEventListener("abort", () => resolve("timeout"), {
				once: true,
			}),
		);
		try {
			const outcome = await Promise.race([run(), timedOut]);
			return outcome === "timeout" ? failure("activation-failed") : outcome;
		} catch {
			return failure(
				signal.aborted ? "activation-failed" : "activation-failed",
			);
		} finally {
			// A timed-out owner.ready cannot be cancelled, but run() checks the aborted signal before mutation.
		}
	};
	registerOAuthCredentialSource(pi, [
		{
			offerCredential(data) {
				const request = parseCredentialRequest(data);
				if (!request) return;
				const owner = sessionOwners.get(
					request.session as ExtensionContext["sessionManager"],
				);
				const providerId = toProviderId(request.provider);
				if (!owner || !providerId) return;
				owner.coordinators.get(providerId)?.offerCredential(data);
			},
		},
	]);

	const isOwnerCurrent = (owner: SessionSelectionOwner): boolean =>
		sessionOwners.get(owner.sessionManager) === owner && !owner.signal.aborted;

	const initializeOwner = async (
		owner: SessionSelectionOwner,
		ctx: ExtensionContext,
	): Promise<void> => {
		const restored = restoreAccountSelections(
			ctx.sessionManager.getEntries(),
			owner.sessionId,
		);
		if (restored.status === "invalid") {
			owner.error = restored.message;
			ctx.ui.notify(restored.message, "error");
			return;
		}
		let selections =
			restored.status === "loaded"
				? restored.selections
				: cloneAccountSelections(
						Object.create(null) as ProviderAccountSelections,
					);
		const missingProviders = providers.filter(
			(provider) => !Object.hasOwn(selections, provider.id),
		);
		if (restored.status === "loaded" && missingProviders.length === 0) {
			owner.selections = selections;
			return;
		}
		try {
			const data = await store.readAsync(owner.signal);
			if (!isOwnerCurrent(owner)) return;
			for (const provider of missingProviders) {
				selections = setAccountSelection(
					selections,
					provider.id,
					data.providers[provider.id]?.active ?? null,
				);
			}
			owner.sessionManager.appendCustomEntry(
				ACCOUNT_SELECTION_ENTRY_TYPE,
				createAccountSelectionEntryData(owner.sessionId, selections),
			);
			if (!isOwnerCurrent(owner)) return;
			owner.selections = selections;
		} catch {
			if (!isOwnerCurrent(owner)) return;
			owner.error =
				"Could not persist this Pi session's account selection. Choose an account or default from /accounts to retry.";
			ctx.ui.notify(owner.error, "error");
		}
	};

	const startSessionOwner = (ctx: ExtensionContext): SessionSelectionOwner => {
		installOpenAIGate(ctx);
		const previous = sessionOwners.get(ctx.sessionManager);
		if (previous) {
			previous.controller.abort(
				new DOMException("Accounts session replaced", "AbortError"),
			);
			previous.results.clear();
			previous.selectionRevisions.clear();
			previous.activationRequests.clear();
			previous.appliedIdentities.clear();
			previous.abortProviders.clear();
			previous.syncTasks.clear();
			previous.pendingSyncTasks.clear();
			previous.startupTasks.clear();
			previous.startupCompletedProviders.clear();
			for (const coordinator of previous.coordinators.values())
				coordinator.invalidate(ctx);
		}
		const controller = new AbortController();
		const owner: SessionSelectionOwner = {
			context: ctx,
			// Pi exposes this as read-only to extensions, but the runtime context contains the concrete
			// session manager. Factory-bound pi.appendEntry() cannot target concurrent session owners.
			sessionManager: ctx.sessionManager as ExtensionContext["sessionManager"] &
				SessionEntryWriter,
			sessionId: ctx.sessionManager.getSessionId(),
			switchReserved: 0,
			openAIRequestCount: 0,
			selections: cloneAccountSelections(
				Object.create(null) as ProviderAccountSelections,
			),
			selectionRevisions: new Map(),
			activationRequests: new Map(),
			controller,
			signal: controller.signal,
			ready: Promise.resolve(),
			coordinators: new Map(
				providers.map((provider) => [
					provider.id,
					new RuntimeAuthCoordinator(pi, provider),
				]),
			),
			results: new Map(),
			appliedIdentities: new Map(),
			abortProviders: new Set(),
			syncTasks: new Map(),
			pendingSyncTasks: new Map(),
			startupTask: Promise.resolve(),
			startupTasks: new Map(),
			startupCompletedProviders: new Set(),
		};
		sessionOwners.set(ctx.sessionManager, owner);
		owner.ready = initializeOwner(owner, ctx);
		return owner;
	};

	const ensureSessionOwner = async (
		ctx: ExtensionContext,
	): Promise<SessionSelectionOwner> => {
		let owner = sessionOwners.get(ctx.sessionManager);
		if (!owner || owner.sessionId !== ctx.sessionManager.getSessionId()) {
			owner = startSessionOwner(ctx);
		}
		await owner.ready;
		activeOwner = owner;
		accountControlsService.sessionId = owner.sessionId;
		return owner;
	};

	const persistSelection: PersistSelection = (
		owner,
		providerId,
		accountName,
		isCurrent,
	) => {
		if (!isOwnerCurrent(owner) || !isCurrent()) {
			return false;
		}
		let selections = owner.error
			? providers.reduce<ProviderAccountSelections>(
					(current, provider) =>
						setAccountSelection(current, provider.id, null),
					cloneAccountSelections(
						Object.create(null) as ProviderAccountSelections,
					),
				)
			: owner.selections;
		selections = setAccountSelection(selections, providerId, accountName);
		owner.sessionManager.appendCustomEntry(
			ACCOUNT_SELECTION_ENTRY_TYPE,
			createAccountSelectionEntryData(owner.sessionId, selections),
		);
		if (!isOwnerCurrent(owner) || !isCurrent()) return false;
		owner.selections = selections;
		owner.selectionRevisions.set(
			providerId,
			(owner.selectionRevisions.get(providerId) ?? 0) + 1,
		);
		owner.error = undefined;
		return true;
	};

	const staleResult = (
		providerId: AccountProviderId,
	): EnsureActiveProviderAuthResult => ({
		status: "inactive",
		providerId,
	});

	const syncProvider: SyncProvider = (
		providerId,
		ctx,
		owner,
		ownerSignal,
		model = ctx.model,
	) => {
		let task!: Promise<EnsureActiveProviderAuthResult>;
		task = (async () => {
			const adapter = requireAdapter(adapters, providerId);
			const coordinator = owner.coordinators.get(providerId);
			if (!coordinator)
				throw new Error(`Missing runtime coordinator for ${providerId}.`);
			if (!isOwnerCurrent(owner)) return staleResult(providerId);
			const timeout = AbortSignal.timeout(30_000);
			const signal = AbortSignal.any(
				ownerSignal
					? [owner.signal, ownerSignal, timeout]
					: [owner.signal, timeout],
			);
			const selectionError = owner.error;
			let result = selectionError
				? await coordinator.forceFailClosed(
						ctx,
						"unknown",
						new Error(selectionError),
					)
				: await coordinator.ensureActive(
						ctx,
						store,
						owner.selections[providerId] ?? null,
						Date.now(),
						signal,
					);
			let identity: string | undefined;
			let latest = owner.syncTasks.get(providerId);
			if (!isOwnerCurrent(owner))
				return latest && latest !== task ? latest : staleResult(providerId);
			if (latest && latest !== task) return latest;
			try {
				identity = coordinator.getAppliedAuthIdentity(ctx, result);
				const previousIdentity = owner.appliedIdentities.get(providerId);
				const shouldInvalidate =
					previousIdentity !== identity &&
					!(previousIdentity === undefined && identity === "default");
				if (shouldInvalidate) {
					await adapter.invalidateConnections?.(owner.sessionId);
					latest = owner.syncTasks.get(providerId);
					if (!isOwnerCurrent(owner))
						return latest && latest !== task ? latest : staleResult(providerId);
					if (latest && latest !== task) return latest;
				}
				owner.appliedIdentities.set(providerId, identity);
			} catch (error) {
				latest = owner.syncTasks.get(providerId);
				if (!isOwnerCurrent(owner))
					return latest && latest !== task ? latest : staleResult(providerId);
				if (latest && latest !== task) return latest;
				const credential = await selectedCredential(
					store,
					providerId,
					result,
					signal,
				);
				latest = owner.syncTasks.get(providerId);
				if (!isOwnerCurrent(owner))
					return latest && latest !== task ? latest : staleResult(providerId);
				if (latest && latest !== task) return latest;
				result = await coordinator.forceFailClosed(
					ctx,
					result.status === "inactive" ? "unknown" : result.accountName,
					error,
					credential,
				);
			}
			latest = owner.syncTasks.get(providerId);
			if (!isOwnerCurrent(owner))
				return latest && latest !== task ? latest : staleResult(providerId);
			if (latest && latest !== task) return latest;
			coordinator.publishCredentialOffer(ctx, result, identity ?? "");
			owner.results.set(providerId, result);
			updateStatus(ctx, owner.results, model);
			return result;
		})();
		owner.syncTasks.set(providerId, task);
		owner.pendingSyncTasks.set(providerId, task);
		const clearPending = () => {
			if (
				!isOwnerCurrent(owner) ||
				owner.pendingSyncTasks.get(providerId) !== task
			)
				return;
			owner.pendingSyncTasks.delete(providerId);
		};
		void task.then(clearPending, clearPending);
		return task;
	};

	const installOpenAIGate = (ctx: ExtensionContext): void => {
		const registry = ctx.modelRegistry;
		if (openAIGates.has(registry as object)) return;
		const previous = registry.getRegisteredProviderConfig("openai");
		if (registry.getRegisteredNativeProvider("openai")) {
			throw new Error(
				"Named accounts do not support a separately registered native OpenAI provider; its registration was left untouched.",
			);
		}
		const effectiveProvider = registry.getProvider("openai");
		if (!effectiveProvider)
			throw new Error(
				"Native OpenAI provider is unavailable; OpenAI request gate was not installed.",
			);
		const api = effectiveProvider
			.getModels()
			.find((model) => model.api === "openai-responses")?.api;
		if (!api || (previous?.streamSimple && previous.api !== api)) {
			throw new Error(
				"OpenAI provider has an incompatible stream override; request gate was not installed.",
			);
		}
		const nativeProvider = registry.getRegisteredNativeProvider("openai");
		const delegateProvider = previous?.streamSimple
			? effectiveProvider
			: (nativeProvider ?? effectiveProvider);
		const delegate = delegateProvider.streamSimple.bind(delegateProvider);
		const gateStreamSimple = (
			model: Parameters<typeof effectiveProvider.streamSimple>[0],
			context: Parameters<typeof effectiveProvider.streamSimple>[1],
			options: Parameters<typeof effectiveProvider.streamSimple>[2],
		) =>
			lazyStream(model, async () => {
				const owner = activeOwner;
				if (
					!owner ||
					owner.context.modelRegistry !== registry ||
					!isOwnerCurrent(owner) ||
					owner.sessionId !== owner.sessionManager.getSessionId()
				) {
					throw new Error("OpenAI account session is stale; request blocked.");
				}
				owner.openAIRequestCount += 1;
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					owner.openAIRequestCount = Math.max(0, owner.openAIRequestCount - 1);
				};
				try {
					const revision = owner.selectionRevisions.get("openai") ?? 0;
					const selection = owner.selections.openai ?? null;
					const activation = await syncProvider(
						"openai",
						owner.context,
						owner,
						options?.signal,
						model,
					);
					if (
						!isOwnerCurrent(owner) ||
						activeOwner !== owner ||
						owner.sessionId !== owner.sessionManager.getSessionId()
					) {
						throw new Error("OpenAI account session changed; request blocked.");
					}
					if (
						activation.status === "error" ||
						(selection !== null && activation.status !== "active")
					) {
						owner.abortProviders.add("openai");
						throw new Error(
							"OpenAI account authentication failed; request blocked.",
						);
					}
					if (
						(owner.selectionRevisions.get("openai") ?? 0) !== revision ||
						(owner.selections.openai ?? null) !== selection
					) {
						throw new Error(
							"OpenAI account selection changed; request blocked.",
						);
					}
					let resolved: Awaited<
						ReturnType<typeof registry.getApiKeyAndHeaders>
					>;
					try {
						resolved = await registry.getApiKeyAndHeaders(model);
					} catch {
						throw new Error(
							"OpenAI account authentication could not be verified; request blocked.",
						);
					}
					if (
						!isOwnerCurrent(owner) ||
						activeOwner !== owner ||
						(owner.selectionRevisions.get("openai") ?? 0) !== revision
					) {
						throw new Error(
							"OpenAI account selection changed; request blocked.",
						);
					}
					if (
						resolved.ok === false ||
						(!resolved.apiKey &&
							!Object.keys(resolved.headers ?? {}).some(
								(key) => key.toLowerCase() === "authorization",
							))
					) {
						if (selection !== null)
							throw new Error(
								"OpenAI account authentication could not be verified; request blocked.",
							);
					}
					const identity = owner.appliedIdentities.get("openai");
					const userOnPayload = options?.onPayload;
					const finalOptions = {
						...options,
						...(resolved.ok
							? {
									apiKey: resolved.apiKey,
									headers: resolved.headers,
									env: resolved.env,
								}
							: {}),
						onPayload: async (payload: unknown, payloadModel: typeof model) => {
							let latestAuth: Awaited<
								ReturnType<typeof registry.getApiKeyAndHeaders>
							>;
							try {
								latestAuth = await registry.getApiKeyAndHeaders(model);
							} catch {
								throw new Error(
									"OpenAI account authentication changed before dispatch; request blocked.",
								);
							}
							const authStillCurrent =
								latestAuth.ok &&
								resolved.ok &&
								latestAuth.apiKey === resolved.apiKey &&
								latestAuth.baseUrl === resolved.baseUrl &&
								JSON.stringify(latestAuth.env ?? {}) ===
									JSON.stringify(resolved.env ?? {}) &&
								headersEqual(latestAuth.headers, resolved.headers);
							if (!authStillCurrent)
								throw new Error(
									"OpenAI account authentication changed before dispatch; request blocked.",
								);
							if (selection !== null) {
								let saved;
								try {
									const signal = AbortSignal.any([
										owner.signal,
										...(options?.signal ? [options.signal] : []),
										AbortSignal.timeout(5_000),
									]);
									saved = await store.readProviderAsync("openai", signal);
								} catch {
									throw new Error(
										"OpenAI account store could not verify the selected credential; request blocked.",
									);
								}
								const credential = getOwnCredential(saved.accounts, selection);
								const storedIdentity = credential
									? `${selection}:${credential.type === "api_key" ? credential.key : credential.access}`
									: undefined;
								if (!storedIdentity || storedIdentity !== identity) {
									throw new Error(
										"OpenAI account credential changed before dispatch; request blocked.",
									);
								}
							}
							let transformed: unknown;
							try {
								transformed = userOnPayload
									? await userOnPayload(payload, payloadModel)
									: undefined;
							} catch {
								throw new Error(
									"OpenAI request payload validation failed; request blocked.",
								);
							}
							// The user callback can await the idle-guard's final check. Nothing asynchronous
							// may follow it: those checks are the last condition before the provider sends.
							const stillCurrent =
								isOwnerCurrent(owner) &&
								activeOwner === owner &&
								owner.sessionId === owner.sessionManager.getSessionId() &&
								(owner.selectionRevisions.get("openai") ?? 0) === revision &&
								(owner.selections.openai ?? null) === selection &&
								owner.switchReserved === 0 &&
								owner.appliedIdentities.get("openai") === identity;
							if (!stillCurrent)
								throw new Error(
									"OpenAI account selection changed before dispatch; request blocked.",
								);
							return transformed;
						},
					};
					const requestModel =
						resolved.ok && resolved.baseUrl
							? { ...model, baseUrl: resolved.baseUrl }
							: model;
					const stream = delegate(requestModel, context, finalOptions);
					return trackStreamLifecycle(stream, release, options?.signal);
				} catch (error) {
					release();
					throw error;
				}
			});
		const applied = { ...previous, api, streamSimple: gateStreamSimple };
		registry.registerProvider("openai", applied);
		openAIGates.set(registry as object, { previous, applied });
	};

	const restoreOpenAIGate = (ctx: ExtensionContext): void => {
		const registry = ctx.modelRegistry;
		const installed = openAIGates.get(registry as object);
		if (!installed) return;
		const current = registry.getRegisteredProviderConfig("openai");
		if (current?.streamSimple !== installed.applied?.streamSimple) {
			openAIGates.delete(registry as object);
			return;
		}
		const restored = { ...current };
		if (installed.previous?.api === undefined) delete restored.api;
		else restored.api = installed.previous.api;
		if (installed.previous?.streamSimple === undefined)
			delete restored.streamSimple;
		else restored.streamSimple = installed.previous.streamSimple;
		registry.unregisterProvider("openai");
		if (Object.keys(restored).length > 0)
			registry.registerProvider("openai", restored);
		openAIGates.delete(registry as object);
	};

	const startupProvider = (
		providerId: AccountProviderId,
		ctx: ExtensionContext,
		owner: SessionSelectionOwner,
	): Promise<EnsureActiveProviderAuthResult> => {
		if (owner.startupCompletedProviders.has(providerId)) {
			return Promise.resolve(
				owner.results.get(providerId) ?? staleResult(providerId),
			);
		}
		const existing = owner.startupTasks.get(providerId);
		if (existing) return existing;
		let task!: Promise<EnsureActiveProviderAuthResult>;
		task = syncProvider(providerId, ctx, owner).finally(() => {
			if (!isOwnerCurrent(owner) || owner.startupTasks.get(providerId) !== task)
				return;
			owner.startupTasks.delete(providerId);
			owner.startupCompletedProviders.add(providerId);
		});
		owner.startupTasks.set(providerId, task);
		return task;
	};

	const syncAll = async (
		ctx: ExtensionContext,
		owner: SessionSelectionOwner,
	): Promise<void> => {
		for (const provider of providers) {
			if (!isOwnerCurrent(owner)) return;
			const result = await startupProvider(provider.id, ctx, owner);
			if (!isOwnerCurrent(owner)) return;
			if (result.status === "error") {
				ctx.ui.notify(
					`${provider.displayName} account "${result.accountName}" failed closed: ${result.message}`,
					"error",
				);
			}
		}
		if (isOwnerCurrent(owner)) updateStatus(ctx, owner.results, ctx.model);
	};

	const waitForCurrentProvider = async (
		providerId: AccountProviderId,
		owner: SessionSelectionOwner,
	): Promise<void> => {
		await owner.ready;
		if (!isOwnerCurrent(owner)) return;
		let pending = owner.pendingSyncTasks.get(providerId);
		if (!pending) {
			pending = owner.startupCompletedProviders.has(providerId)
				? syncProvider(providerId, owner.context, owner)
				: startupProvider(providerId, owner.context, owner);
		}
		while (true) {
			let rejected = false;
			let failure: unknown;
			try {
				await pending;
			} catch (error) {
				rejected = true;
				failure = error;
			}
			if (!isOwnerCurrent(owner)) return;
			const latest = owner.syncTasks.get(providerId);
			if (latest && latest !== pending) {
				pending = latest;
				continue;
			}
			if (rejected) throw failure;
			return;
		}
	};

	const startBackgroundSync = (
		ctx: ExtensionContext,
		owner: SessionSelectionOwner,
	): void => {
		owner.startupTask = (async () => {
			try {
				await owner.ready;
				if (!isOwnerCurrent(owner)) return;
				await syncAll(ctx, owner);
			} catch (error) {
				if (!isOwnerCurrent(owner)) return;
				try {
					ctx.ui.notify(
						`Account startup activation failed: ${redactTokenText(errorMessage(error))}`,
						"error",
					);
				} catch {
					// Detached startup must stay handled if the UI disappears during replacement or reload.
				}
			}
		})();
	};

	registerOAuthCredentialReadiness(pi, [
		{
			waitForCredential(data) {
				const request = parseCredentialReadinessRequest(data);
				if (!request) return;
				const owner = sessionOwners.get(
					request.session as ExtensionContext["sessionManager"],
				);
				const providerId = toProviderId(request.provider);
				if (!owner || !providerId) return;
				const pending = waitForCurrentProvider(providerId, owner);
				try {
					request.waitUntil(pending);
				} catch {
					void pending.catch(() => undefined);
				}
			},
		},
	]);

	registerAccountsProtocol(
		pi,
		async () => {
			const data = await store.readAsync();
			return {
				providers: providers.map((adapter) => {
					const state = data.providers[adapter.id];
					return {
						providerId: adapter.id,
						displayName: adapter.displayName,
						accounts: Object.entries(state?.accounts ?? {}).map(
							([name, credential]) => ({
								name,
								kind:
									credential.type === "api_key"
										? ("api-key" as const)
										: ("oauth" as const),
							}),
						),
						...(state?.active ? { defaultAccount: state.active } : {}),
					};
				}),
			};
		},
		createAccountActivation(
			store,
			adapters,
			(session) =>
				sessionOwners.get(session as ExtensionContext["sessionManager"]),
			isOwnerCurrent,
			persistSelection,
			syncProvider,
		),
	);

	pi.registerCommand(
		"accounts",
		createAccountCommand(
			store,
			adapters,
			syncProvider,
			persistSelection,
			ensureSessionOwner,
			(owner) => ({
				signal: owner.signal,
				isCurrent: () => isOwnerCurrent(owner),
			}),
		),
	);

	pi.on("session_start", (_event, ctx) => {
		const owner = startSessionOwner(ctx);
		activeOwner = owner;
		accountControlsService.sessionId = owner.sessionId;
		startBackgroundSync(ctx, owner);
	});

	pi.on("model_select", async (event, ctx) => {
		const owner = await ensureSessionOwner(ctx);
		if (!isOwnerCurrent(owner)) return;
		const providerId = toProviderId(event.model.provider);
		if (providerId) {
			const result = await syncProvider(
				providerId,
				ctx,
				owner,
				undefined,
				event.model,
			);
			if (isOwnerCurrent(owner) && result.status === "error") {
				ctx.ui.notify(
					`${requireAdapter(adapters, providerId).displayName} account "${result.accountName}" failed closed: ${result.message}`,
					"error",
				);
			}
		} else updateStatus(ctx, owner.results, event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const owner = await ensureSessionOwner(ctx);
		owner.abortProviders.clear();
		if (!isOwnerCurrent(owner)) return;
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId) return;
		try {
			const result = owner.startupCompletedProviders.has(providerId)
				? await syncProvider(providerId, ctx, owner)
				: await startupProvider(providerId, ctx, owner);
			if (!isOwnerCurrent(owner)) return;
			const coordinator = owner.coordinators.get(providerId);
			if (result.status === "error") owner.abortProviders.add(providerId);
			if (
				result.status === "active" &&
				ctx.model &&
				coordinator &&
				!coordinator.isModelAvailable(ctx.model.id)
			) {
				owner.abortProviders.add(providerId);
				ctx.ui.notify(
					`${requireAdapter(adapters, providerId).displayName} model ${ctx.model.id} is not available to account "${result.accountName}".`,
					"error",
				);
			}
		} catch (error) {
			owner.abortProviders.add(providerId);
			throw error;
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		const owner = sessionOwners.get(ctx.sessionManager);
		if (!owner || !isOwnerCurrent(owner)) return;
		const providerId = toProviderId(ctx.model?.provider);
		if (!providerId || !owner.abortProviders.has(providerId)) return;
		owner.abortProviders.delete(providerId);
		ctx.abort();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const owner = sessionOwners.get(ctx.sessionManager);
		if (!owner) {
			setStatus(ctx, undefined);
			if (
				(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] ===
				accountControlsService
			) {
				accountControlsService.sessionId = "";
				delete (globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY];
			}
			return;
		}
		sessionOwners.delete(ctx.sessionManager);
		if (activeOwner === owner) {
			activeOwner = undefined;
			accountControlsService.sessionId = "";
		}
		owner.controller.abort(
			new DOMException("Accounts session shut down", "AbortError"),
		);
		owner.results.clear();
		owner.selectionRevisions.clear();
		owner.activationRequests.clear();
		owner.appliedIdentities.clear();
		owner.abortProviders.clear();
		owner.syncTasks.clear();
		owner.pendingSyncTasks.clear();
		owner.startupTasks.clear();
		owner.startupCompletedProviders.clear();
		await Promise.allSettled(
			[...owner.coordinators.values()].map(async (coordinator) => {
				coordinator.invalidate(ctx, false);
				await coordinator.clear(ctx, true);
			}),
		);
		restoreOpenAIGate(ctx);
		setStatus(ctx, undefined);
		if (
			(globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY] ===
			accountControlsService
		) {
			delete (globalThis as Record<string, unknown>)[ACCOUNT_CONTROLS_KEY];
		}
	});
}

function createAccountCommand(
	store: AccountStore,
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	syncProvider: SyncProvider,
	persistSelection: PersistSelection,
	ensureSessionOwner: (ctx: ExtensionContext) => Promise<SessionSelectionOwner>,
	getMenuOwner: (owner: SessionSelectionOwner) => {
		signal: AbortSignal;
		isCurrent(): boolean;
	},
) {
	return {
		description: "Open the interactive OAuth and API key account manager",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"/accounts credential management is available only in the native Pi TUI.",
					"warning",
				);
				return;
			}
			const owner = await ensureSessionOwner(ctx);
			const menuOwner = getMenuOwner(owner);
			if (!menuOwner.isCurrent()) return;
			const providerChoice = await ctx.ui.select("Account provider", ["OpenAI", "OpenAI Codex"], { signal: menuOwner.signal });
			if (!providerChoice || !menuOwner.isCurrent()) return;
			const providerId: AccountProviderId = providerChoice === "OpenAI Codex" ? "openai-codex" : "openai";
			const adapter = adapters.get(providerId);
			if (!adapter)
				return ctx.ui.notify(`${providerId} accounts are unavailable.`, "error");
			while (menuOwner.isCurrent() && !menuOwner.signal.aborted) {
				const state = await store.readProviderAsync(providerId, menuOwner.signal);
				if (!menuOwner.isCurrent()) return;
				const names = Object.keys(state.accounts);
				const current = owner.selections[providerId] ?? null;
				const options = [
					...(current
						? [`Current: ${current}`]
						: ["Current: default Pi login"]),
					"Add account",
					...(names.length ? ["Switch account", "Remove account"] : []),
					"Restore default Pi login",
					"Close",
				];
				const action = await ctx.ui.select(`${adapter.displayName} accounts`, options, {
					signal: menuOwner.signal,
				});
				if (!action || action === "Close" || !menuOwner.isCurrent()) return;
				if (action === "Add account") {
					const name = await ctx.ui.input("Account name", "e.g. personal", {
						signal: menuOwner.signal,
					});
					if (!name || !menuOwner.isCurrent()) continue;
					const method = await ctx.ui.select(
						`Add ${adapter.displayName} account`,
						["ChatGPT sign-in (OAuth)", "API key", "Cancel"],
						{ signal: menuOwner.signal },
					);
					if (!method || method === "Cancel" || !menuOwner.isCurrent())
						continue;
					await loginAccount(
						ctx,
						store,
						adapter,
						name,
						menuOwner.signal,
						syncProvider,
						persistSelection,
						owner,
						menuOwner.isCurrent,
						method === "API key" ? "api_key" : "oauth",
					);
					continue;
				}
				if (action === "Restore default Pi login") {
					await switchAccount(
						ctx,
						store,
						adapter,
						DEFAULT_PI_LOGIN_LABEL,
						menuOwner.signal,
						syncProvider,
						persistSelection,
						owner,
						menuOwner.isCurrent,
					);
					continue;
				}
				if (action === "Switch account" || action === "Remove account") {
					const name = await ctx.ui.select(action, names, {
						signal: menuOwner.signal,
					});
					if (!name || !menuOwner.isCurrent()) continue;
					if (action === "Switch account")
						await switchAccount(
							ctx,
							store,
							adapter,
							name,
							menuOwner.signal,
							syncProvider,
							persistSelection,
							owner,
							menuOwner.isCurrent,
						);
					else
						await removeAccount(
							ctx,
							store,
							adapter,
							name,
							menuOwner.signal,
							syncProvider,
							persistSelection,
							owner,
							menuOwner.isCurrent,
						);
				}
			}
		},
	};
}

function canMutateAccountState(
	ctx: ExtensionContext,
	session: SessionSelectionOwner,
	providerId: AccountProviderId,
): boolean {
	return (
		ctx.isIdle() &&
		session.switchReserved === 0 &&
		session.openAIRequestCount === 0 &&
		!session.pendingSyncTasks.has(providerId)
	);
}

async function loginAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	signal: AbortSignal,
	syncProvider: SyncProvider,
	persistSelection: PersistSelection,
	session: SessionSelectionOwner,
	isCurrent: () => boolean,
	method: "oauth" | "api_key" = "oauth",
	selectAfterLogin = true,
): Promise<void> {
	if (!canMutateAccountState(ctx, session, adapter.id)) {
		ctx.ui.notify(
			"Account management is available only while the session is idle.",
			"warning",
		);
		return;
	}
	const selectionRevision = session.selectionRevisions.get(adapter.id) ?? 0;
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	if (isDefaultPiLoginArg(parsed.name)) {
		ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
		return;
	}
	// Callers are the native TUI menu or the capability-authenticated Paseo
	// manager; both are allowed to invoke Pi's UI prompts.
	const state = await store.readProviderAsync(adapter.id, session.signal);
	if (!isCurrent() || !canMutateAccountState(ctx, session, adapter.id)) return;
	if (getOwnCredential(state.accounts, parsed.name)) {
		const confirmed = await ctx.ui.confirm(
			"Replace account",
			`${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
		);
		if (!confirmed || !isCurrent()) return;
	}
	ctx.ui.notify(
		`Starting ${adapter.displayName} login for "${parsed.name}".`,
		"info",
	);
	let credentialSaved = false;
	let enteredKey: string | undefined;
	try {
		let credential: StoredCredential;
		if (method === "api_key") {
			if (!adapter.supportsApiKey)
				throw new Error(`${adapter.displayName} does not support API keys.`);
			enteredKey = await ctx.ui.input(
				`${adapter.displayName} API key (visible input):`,
				"",
				{ signal },
			);
			if (enteredKey === undefined || !isCurrent() || signal.aborted) return;
			credential = normalizeApiKeyCredential(enteredKey);
		} else {
			credential = normalizeStoredCredential(
				await loginWithOAuthUI(ctx, adapter, signal),
				parsed.name,
			);
		}
		if (
			!isCurrent() ||
			!canMutateAccountState(ctx, session, adapter.id) ||
			(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
		) {
			ctx.ui.notify(
				"The session became active or changed; the account was not saved.",
				"warning",
			);
			return;
		}
		let saved = false;
		await store.updateProvider(adapter.id, (state) => {
			if (
				!isCurrent() ||
				!canMutateAccountState(ctx, session, adapter.id) ||
				(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
			)
				return state;
			saved = true;
			return {
				...state,
				accounts: defineOwn(state.accounts, parsed.name, credential),
			};
		});
		if (!isCurrent()) return;
		if (!saved) {
			ctx.ui.notify(
				"The session became active or changed; the account was not saved.",
				"warning",
			);
			return;
		}
		credentialSaved = true;
		if (!selectAfterLogin) {
			ctx.ui.notify(
				`${adapter.displayName} account "${parsed.name}" was saved.`,
				"info",
			);
			return;
		}
		if (
			!canMutateAccountState(ctx, session, adapter.id) ||
			(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
		) {
			ctx.ui.notify(
				`Saved ${adapter.displayName} account "${parsed.name}"; choose it later while the session is idle.`,
				"info",
			);
			return;
		}
		if (
			!persistSelection(
				session,
				adapter.id,
				parsed.name,
				() =>
					isCurrent() &&
					canMutateAccountState(ctx, session, adapter.id) &&
					(session.selectionRevisions.get(adapter.id) ?? 0) ===
						selectionRevision,
			)
		)
			return;
		const result = await syncProvider(adapter.id, ctx, session, signal);
		if (!isCurrent()) return;
		ctx.ui.notify(
			formatActivationMessage("Logged in", adapter, parsed.name, result),
			result.status === "error" ? "error" : "info",
		);
	} catch (error) {
		if (!isCurrent()) return;
		const message = redactTokenText(
			errorMessage(error),
			enteredKey ? [enteredKey] : [],
		);
		ctx.ui.notify(
			credentialSaved
				? `${adapter.displayName} account "${parsed.name}" was saved, but this session could not select it: ${message}`
				: `${adapter.displayName} login failed: ${message}`,
			"error",
		);
	}
}

async function switchAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	signal: AbortSignal,
	syncProvider: SyncProvider,
	persistSelection: PersistSelection,
	session: SessionSelectionOwner,
	isCurrent: () => boolean,
): Promise<void> {
	if (!isCurrent()) return;
	if (
		!ctx.isIdle() ||
		session.switchReserved > 0 ||
		session.openAIRequestCount > 0
	) {
		ctx.ui.notify(
			"Account switching is available only while the session is idle.",
			"warning",
		);
		return;
	}
	const selectionRevision = session.selectionRevisions.get(adapter.id) ?? 0;
	const name = nameArg.trim();
	if (!name) {
		ctx.ui.notify(
			`Select a ${adapter.displayName} account from /accounts.`,
			"warning",
		);
		return;
	}
	if (isDefaultPiLoginArg(name)) {
		try {
			if (
				!ctx.isIdle() ||
				session.openAIRequestCount > 0 ||
				session.switchReserved > 0 ||
				(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
			) {
				ctx.ui.notify(
					"Account selection changed or the session became active; retry /accounts.",
					"warning",
				);
				return;
			}
			if (!persistSelection(session, adapter.id, null, isCurrent)) return;
		} catch (error) {
			if (!isCurrent()) return;
			ctx.ui.notify(
				`Could not save the default ${adapter.displayName} selection for this session: ${redactTokenText(errorMessage(error))}`,
				"error",
			);
			return;
		}
		const result = await syncProvider(adapter.id, ctx, session, signal);
		if (!isCurrent()) return;
		if (result.status === "error") {
			ctx.ui.notify(
				`Could not restore default Pi ${adapter.displayName} login; requests will fail closed: ${result.message}`,
				"error",
			);
			return;
		}
		ctx.ui.notify(`Using default Pi ${adapter.displayName} login.`, "info");
		return;
	}
	const parsed = parseAccountName(name);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	const state = await store.readProviderAsync(adapter.id, session.signal);
	if (!isCurrent()) return;
	if (!getOwnCredential(state.accounts, parsed.name)) {
		ctx.ui.notify(
			`${adapter.displayName} account "${parsed.name}" was not found.`,
			"warning",
		);
		return;
	}
	try {
		if (
			!ctx.isIdle() ||
			session.openAIRequestCount > 0 ||
			session.switchReserved > 0 ||
			(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
		) {
			ctx.ui.notify(
				"Account selection changed or the session became active; retry /accounts.",
				"warning",
			);
			return;
		}
		if (!persistSelection(session, adapter.id, parsed.name, isCurrent)) return;
	} catch (error) {
		if (!isCurrent()) return;
		ctx.ui.notify(
			`Could not save ${adapter.displayName} account "${parsed.name}" for this session: ${redactTokenText(errorMessage(error))}`,
			"error",
		);
		return;
	}
	const result = await syncProvider(adapter.id, ctx, session, signal);
	if (!isCurrent()) return;
	ctx.ui.notify(
		formatActivationMessage("Activated", adapter, parsed.name, result),
		result.status === "active" ? "info" : "error",
	);
}

async function removeAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapter: AccountProviderAdapter,
	nameArg: string,
	signal: AbortSignal,
	syncProvider: SyncProvider,
	persistSelection: PersistSelection,
	session: SessionSelectionOwner,
	isCurrent: () => boolean,
): Promise<void> {
	if (!isCurrent()) return;
	if (!canMutateAccountState(ctx, session, adapter.id)) {
		ctx.ui.notify(
			"Account management is available only while the session is idle.",
			"warning",
		);
		return;
	}
	const selectionRevision = session.selectionRevisions.get(adapter.id) ?? 0;
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) return ctx.ui.notify(parsed.error, "warning");
	let removed = false;
	await store.updateProvider(adapter.id, (state) => {
		if (
			!isCurrent() ||
			!canMutateAccountState(ctx, session, adapter.id) ||
			(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision ||
			!getOwnCredential(state.accounts, parsed.name)
		)
			return state;
		removed = true;
		const accounts = defineOwnMap(state.accounts);
		delete accounts[parsed.name];
		return {
			...state,
			active: state.active === parsed.name ? undefined : state.active,
			accounts,
		};
	});
	if (!isCurrent()) return;
	if (!removed) {
		ctx.ui.notify(
			canMutateAccountState(ctx, session, adapter.id)
				? `${adapter.displayName} account "${parsed.name}" was not found.`
				: "The session became active or changed; retry account management while idle.",
			"warning",
		);
		return;
	}
	const removedSelection =
		!session.error && session.selections[adapter.id] === parsed.name;
	if (removedSelection) {
		try {
			if (
				!canMutateAccountState(ctx, session, adapter.id) ||
				(session.selectionRevisions.get(adapter.id) ?? 0) !== selectionRevision
			) {
				ctx.ui.notify(
					`Removed ${adapter.displayName} account "${parsed.name}", but this session became active; it remains fail-closed until you restore an account while idle.`,
					"warning",
				);
				return;
			}
			if (!persistSelection(session, adapter.id, null, isCurrent)) return;
		} catch (error) {
			if (!isCurrent()) return;
			const result = await syncProvider(adapter.id, ctx, session, signal);
			if (!isCurrent()) return;
			ctx.ui.notify(
				`Removed ${adapter.displayName} account "${parsed.name}", but this session could not save its default selection and will fail closed: ${redactTokenText(errorMessage(error))}${result.status === "error" ? ` (${result.message})` : ""}`,
				"error",
			);
			return;
		}
		const result = await syncProvider(adapter.id, ctx, session, signal);
		if (!isCurrent()) return;
		if (result.status === "error") {
			ctx.ui.notify(
				`Removed ${adapter.displayName} account "${parsed.name}", but default auth restoration failed closed: ${result.message}`,
				"error",
			);
			return;
		}
	}
	ctx.ui.notify(
		`Removed ${adapter.displayName} account "${parsed.name}".`,
		"info",
	);
}

function headersEqual(
	left: Record<string, string | null> | undefined,
	right: Record<string, string | null> | undefined,
): boolean {
	const normalize = (headers: Record<string, string | null> | undefined) =>
		Object.entries(headers ?? {})
			.map(([name, value]) => [name.toLowerCase(), value] as const)
			.sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function trackStreamLifecycle<T>(
	source: AsyncIterable<T>,
	release: () => void,
	signal?: AbortSignal,
): AsyncIterable<T> & { result?: () => Promise<unknown> } {
	const onAbort = () => release();
	signal?.addEventListener("abort", onAbort, { once: true });
	const finish = () => {
		signal?.removeEventListener("abort", onAbort);
		release();
	};
	const tracked: AsyncIterable<T> & { result?: () => Promise<unknown> } = {
		[Symbol.asyncIterator]() {
			const iterator = source[Symbol.asyncIterator]();
			return {
				async next(): Promise<IteratorResult<T>> {
					try {
						const next = await iterator.next();
						if (next.done) finish();
						return next;
					} catch (error) {
						finish();
						throw error;
					}
				},
				async return(value?: unknown): Promise<IteratorResult<T>> {
					try {
						if (iterator.return) return await iterator.return(value as never);
						return { done: true, value: value as T };
					} finally {
						finish();
					}
				},
				async throw(error?: unknown): Promise<IteratorResult<T>> {
					try {
						if (iterator.throw) return await iterator.throw(error);
						throw error;
					} finally {
						finish();
					}
				},
			};
		},
	};
	const result = (
		source as AsyncIterable<T> & { result?: () => Promise<unknown> }
	).result;
	if (typeof result === "function") tracked.result = () => result.call(source);
	return tracked;
}

function validateProviderSet(
	providers: readonly AccountProviderAdapter[],
	requireAll: boolean,
): void {
	const ids = new Set<AccountProviderId>();
	for (const provider of providers) {
		if (ids.has(provider.id))
			throw new Error(`Duplicate account provider: ${provider.id}`);
		ids.add(provider.id);
	}
	if (!requireAll) return;
	for (const id of SUPPORTED_PROVIDER_IDS) {
		if (!ids.has(id))
			throw new Error(`Missing required account provider: ${id}`);
	}
}

function requireAdapter(
	adapters: Map<AccountProviderId, AccountProviderAdapter>,
	providerId: AccountProviderId,
): AccountProviderAdapter {
	const adapter = adapters.get(providerId);
	if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
	return adapter;
}

function toProviderId(
	value: string | undefined,
): AccountProviderId | undefined {
	return value && isAccountProviderId(value) ? value : undefined;
}

function isAccountProviderId(value: string): value is AccountProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(value);
}

function isDefaultPiLoginArg(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "default" ||
		normalized === "--default" ||
		normalized === DEFAULT_PI_LOGIN_LABEL
	);
}

function formatActivationMessage(
	action: "Logged in" | "Activated",
	adapter: AccountProviderAdapter,
	name: string,
	result: EnsureActiveProviderAuthResult,
): string {
	if (
		result.status !== "inactive" &&
		result.accountName !== "unknown" &&
		result.accountName !== name
	) {
		return `${action} ${adapter.displayName} account "${name}" was superseded by "${result.accountName}" before activation.`;
	}
	if (result.status === "error") {
		return `${action} ${adapter.displayName} account "${name}", but authentication failed; requests will fail closed: ${result.message}`;
	}
	if (result.status === "inactive") {
		return `${action} ${adapter.displayName} account "${name}" was superseded before activation.`;
	}
	return `${action} ${adapter.displayName} account "${name}".`;
}

async function selectedCredential(
	store: AccountStore,
	providerId: AccountProviderId,
	result: EnsureActiveProviderAuthResult,
	signal?: AbortSignal,
): Promise<StoredCredential | undefined> {
	if (result.status === "inactive") return undefined;
	try {
		const state = await store.readProviderAsync(providerId, signal);
		return getOwnCredential(state.accounts, result.accountName);
	} catch {
		return undefined;
	}
}

function updateStatus(
	ctx: ExtensionContext,
	results: Map<AccountProviderId, EnsureActiveProviderAuthResult>,
	model = ctx.model,
): void {
	const providerId = toProviderId(model?.provider);
	const result = providerId ? results.get(providerId) : undefined;
	if (!result || result.status === "inactive") {
		setStatus(ctx, undefined);
		return;
	}
	if (result.status === "active") {
		setStatus(ctx, `account:${result.accountName}`);
		return;
	}
	setStatus(ctx, `account:${result.accountName} auth error`);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	try {
		ctx.ui.setStatus(ACCOUNTS_STATUS_KEY, value);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes(
			"This extension ctx is stale after session replacement or reload",
		)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
