import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Private routing metadata only. Never put credentials or provider headers here. */
export interface RoutingProfile {
  version: 1;
  ownerSessionId: string;
  providerId: string;
  accountId: string | null;
  revision: number;
}
export interface RoutingContext {
  model?: { provider: string; id: string; api?: string };
  modelRegistry?: { find(provider: string, id: string): { provider: string; id: string; api?: string } | undefined };
  sessionManager: { getSessionId(): string };
}
interface Registration {
  file: string;
  getProfile(): RoutingProfile | undefined;
  prepareRequest?(): Promise<RoutingProfile | undefined>;
}
interface Registry {
  owners: WeakMap<object, Registration>;
  listeners: WeakMap<object, Set<() => void>>;
  seen: WeakMap<object, RoutingProfile>;
  modelReferences: WeakMap<object, () => { provider: string; id: string } | undefined>;
}
const key = Symbol.for("pi-agent-extensions.session-routing.v1");
const globals = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry = globals[key] ??= { owners: new WeakMap(), listeners: new WeakMap(), seen: new WeakMap(), modelReferences: new WeakMap() };
registry.modelReferences ??= new WeakMap();
export const SESSION_ROUTING_FILE_ENV = "PI_SESSION_ROUTING_FILE";
export const SESSION_ROUTING_OWNER_ENV = "PI_SESSION_ROUTING_OWNER_SESSION";
export const SESSION_MODEL_REFERENCE_EVENT = "session-routing:configured-model-reference";
const requestProfileKey = Symbol.for("pi-agent-extensions.session-routing.request.v1");

/** Symbols survive internal model copies but are never serialized to a provider or transcript. */
export function bindSessionModelRequest<T extends object>(model: T, profile: RoutingProfile): T {
  return { ...model, [requestProfileKey]: validateRoutingProfile(profile) };
}
export function getSessionModelRequestProfile(model: object): RoutingProfile | undefined {
  const value = (model as Record<symbol, unknown>)[requestProfileKey];
  return value === undefined ? undefined : validateRoutingProfile(value);
}
type Environment = Record<string, string | undefined>;
const virtualProviders = new Set(["idle-guard", "idle-guard-proxy", "session-follow", "unknown"]);

export function validateRoutingProfile(value: unknown, expectedOwner?: string): RoutingProfile {
  const p = value as Partial<RoutingProfile> | null;
  if (!p || typeof p !== "object" || Array.isArray(p) || p.version !== 1 ||
    typeof p.ownerSessionId !== "string" || !p.ownerSessionId || p.ownerSessionId.length > 512 ||
    (expectedOwner !== undefined && p.ownerSessionId !== expectedOwner) ||
    typeof p.providerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(p.providerId) || virtualProviders.has(p.providerId) ||
    !(p.accountId === null || (typeof p.accountId === "string" && p.accountId.length > 0 && p.accountId.length <= 256 && !/[\x00-\x1f]/.test(p.accountId))) ||
    !Number.isSafeInteger(p.revision) || p.revision! < 0) {
    throw new Error("Invalid or mismatched session routing profile; no provider/account fallback is allowed");
  }
  return { version: 1, ownerSessionId: p.ownerSessionId, providerId: p.providerId, accountId: p.accountId, revision: p.revision! };
}

export function routingProfilePath(agentDir: string, sessionId: string): string {
  if (!isAbsolute(agentDir) || !sessionId) throw new Error("Session routing requires an absolute agent directory and session identity");
  return join(agentDir, "state", "session-routing-v1", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function writePrivateRoutingDocument(file: string, data: unknown): void {
  if (!isAbsolute(file)) throw new Error("Session routing descriptor must use an absolute path");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function writeSessionRoutingProfile(file: string, profile: RoutingProfile): void {
  writePrivateRoutingDocument(file, validateRoutingProfile(profile));
}

function readPrivateRoutingDocument(file: string): unknown {
  if (!isAbsolute(file)) throw new Error("Invalid inherited session routing path");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Session routing descriptor must be a private owner-controlled file");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function readSessionRoutingProfile(file: string, expectedOwner: string): RoutingProfile {
  if (!expectedOwner) throw new Error("Invalid inherited session routing owner");
  return validateRoutingProfile(readPrivateRoutingDocument(file), expectedOwner);
}

function agentSHBindingPath(agentDir: string, requestId: string): string {
  if (!isAbsolute(agentDir) || !/^pi-route-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error("Invalid private AgentSH routing request identity");
  return join(agentDir, "state", "session-routing-v1", "requests", `${createHash("sha256").update(requestId).digest("hex")}.json`);
}

/** AgentSH already forwards its request ID and shares the caller's agent dir.
 * Bind that existing channel privately, without new tool/wire fields or daemon changes. */
export function publishAgentSHRoutingBinding(agentDir: string, requestId: string, environment: Record<string, string>): void {
  const file = environment[SESSION_ROUTING_FILE_ENV], owner = environment[SESSION_ROUTING_OWNER_ENV];
  if (!file || !owner) throw new Error("Missing owning session binding for AgentSH delegation");
  readSessionRoutingProfile(file, owner);
  const destination = agentSHBindingPath(agentDir, requestId);
  writePrivateRoutingDocument(destination, { version: 1, ownerSessionId: owner, file });
}

export function releaseAgentSHRoutingBinding(agentDir: string, requestId: string): void {
  try { unlinkSync(agentSHBindingPath(agentDir, requestId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write("[session-routing] Completed request binding cleanup failed\n");
  }
}

function inheritedIdentity(env: Environment): { file: string; owner: string } | undefined {
  const file = env[SESSION_ROUTING_FILE_ENV], owner = env[SESSION_ROUTING_OWNER_ENV];
  if (file === undefined && owner === undefined) {
    const requestId = env.AGENTSH_SUBAGENT_REQUEST_ID;
    if (!env.AGENTSH_SUBAGENT_ID || !requestId?.startsWith("pi-route-")) return undefined;
    const agentDir = env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("Bound AgentSH helper has no shared agent directory; refusing fallback");
    const binding = readPrivateRoutingDocument(agentSHBindingPath(agentDir, requestId)) as { version?: number; ownerSessionId?: string; file?: string } | null;
    if (!binding || binding.version !== 1 || typeof binding.ownerSessionId !== "string" || !binding.ownerSessionId || typeof binding.file !== "string" || !isAbsolute(binding.file)) throw new Error("Invalid AgentSH owning-session binding");
    return { file: binding.file, owner: binding.ownerSessionId };
  }
  if (!file || !isAbsolute(file) || !owner) throw new Error("Incomplete inherited session routing identity; refusing fallback");
  return { file, owner };
}

export function isInheritedSessionRouting(ctx: RoutingContext, env: Environment = process.env): boolean {
  const identity = inheritedIdentity(env);
  return identity !== undefined && identity.owner !== ctx.sessionManager.getSessionId();
}

/** Bypasses the local registry so an inherited owner's callback cannot recurse. */
export function readInheritedSessionRoutingProfile(ctx: RoutingContext, env: Environment = process.env): RoutingProfile | undefined {
  const identity = inheritedIdentity(env);
  if (!identity || identity.owner === ctx.sessionManager.getSessionId()) return undefined;
  const profile = readSessionRoutingProfile(identity.file, identity.owner);
  const previous = registry.seen.get(ctx.sessionManager);
  if (previous?.ownerSessionId === profile.ownerSessionId && (profile.revision < previous.revision ||
    (profile.revision === previous.revision && (profile.providerId !== previous.providerId || profile.accountId !== previous.accountId)))) {
    throw new Error("Session routing revision regressed or changed without a new revision; refusing fallback");
  }
  registry.seen.set(ctx.sessionManager, profile);
  return profile;
}

export function registerSessionRouting(ctx: RoutingContext, registration: Registration): () => void {
  if (!isAbsolute(registration.file)) throw new Error("Session routing registration requires an absolute descriptor path");
  registry.owners.set(ctx.sessionManager, registration);
  return () => { if (registry.owners.get(ctx.sessionManager) === registration) registry.owners.delete(ctx.sessionManager); };
}

export function getSessionRoutingProfile(ctx: RoutingContext, env: Environment = process.env): RoutingProfile | undefined {
  const owner = registry.owners.get(ctx.sessionManager);
  if (owner) {
    const profile = owner.getProfile();
    return profile === undefined ? undefined : validateRoutingProfile(profile);
  }
  return readInheritedSessionRoutingProfile(ctx, env);
}

export async function prepareSessionRoutingRequest(ctx: RoutingContext): Promise<RoutingProfile | undefined> {
  const owner = registry.owners.get(ctx.sessionManager);
  const profile = owner?.prepareRequest ? await owner.prepareRequest() : getSessionRoutingProfile(ctx);
  if (owner && profile === undefined) throw new Error("Session routing is not ready or failed; request blocked without provider/account fallback");
  return profile === undefined ? undefined : validateRoutingProfile(profile);
}

export function sessionRoutingEnvironment(ctx: RoutingContext, env: Environment = process.env): Record<string, string> {
  // Descendants keep their original owning session, not an intermediate worker.
  const inherited = inheritedIdentity(env);
  if (inherited && inherited.owner !== ctx.sessionManager.getSessionId()) {
    readSessionRoutingProfile(inherited.file, inherited.owner);
    return { [SESSION_ROUTING_FILE_ENV]: inherited.file, [SESSION_ROUTING_OWNER_ENV]: inherited.owner };
  }
  const registration = registry.owners.get(ctx.sessionManager);
  if (!registration) return {};
  const profile = getSessionRoutingProfile(ctx, env);
  if (!profile) throw new Error("Session routing is not ready; refusing an unbound helper launch");
  return { [SESSION_ROUTING_FILE_ENV]: registration.file, [SESSION_ROUTING_OWNER_ENV]: profile.ownerSessionId };
}

export function resolveSessionProvider(ctx: RoutingContext, fallbackProvider?: string): string {
  const profile = getSessionRoutingProfile(ctx);
  if (registry.owners.has(ctx.sessionManager) && !profile) throw new Error("Session routing is unavailable; refusing provider fallback");
  if (isInheritedSessionRouting(ctx) && profile) return profile.providerId;
  if (ctx.model && ctx.model.api !== "pi-virtual" && !virtualProviders.has(ctx.model.provider)) return ctx.model.provider;
  if (profile) return profile.providerId;
  if (fallbackProvider && !virtualProviders.has(fallbackProvider)) return fallbackProvider;
  throw new Error("No effective physical session provider; select a provider/model before starting helper work");
}

/** A virtual owner supplies its configured physical role, without dispatching it. */
export function registerSessionModelReference(ctx: RoutingContext, resolver: () => { provider: string; id: string } | undefined): () => void {
  registry.modelReferences.set(ctx.sessionManager, resolver);
  return () => { if (registry.modelReferences.get(ctx.sessionManager) === resolver) registry.modelReferences.delete(ctx.sessionManager); };
}

/** Bootstrap only: the configured virtual target before a routing profile exists. */
export function getConfiguredSessionModelReference(ctx: RoutingContext): { provider: string; id: string } | undefined {
  if (ctx.model && ctx.model.api !== "pi-virtual" && !virtualProviders.has(ctx.model.provider)) return { provider: ctx.model.provider, id: ctx.model.id };
  return registry.modelReferences.get(ctx.sessionManager)?.();
}

export function resolveSessionPhysicalModelReference(ctx: RoutingContext, snapshot?: RoutingProfile): { provider: string; id: string } {
  const reference = getConfiguredSessionModelReference(ctx);
  if (!reference) throw new Error("The selected virtual model has no physical session role; refusing helper fallback");
  return { provider: snapshot ? validateRoutingProfile(snapshot).providerId : resolveSessionProvider(ctx, reference.provider), id: reference.id };
}

export function resolveSessionModelSelector(ctx: RoutingContext, selector: string, snapshot?: RoutingProfile): string {
  if (typeof selector !== "string" || !selector || /\s/.test(selector)) throw new Error("Invalid helper model selector");
  const slash = selector.indexOf("/");
  const legacyProvider = slash > 0 ? selector.slice(0, slash) : undefined;
  const model = slash > 0 ? selector.slice(slash + 1) : selector;
  if (!model) throw new Error("Helper model ID is required");
  return `${snapshot ? validateRoutingProfile(snapshot).providerId : resolveSessionProvider(ctx, legacyProvider)}/${model}`;
}

export function onSessionRoutingChanged(ctx: RoutingContext, callback: () => void): () => void {
  let listeners = registry.listeners.get(ctx.sessionManager);
  if (!listeners) registry.listeners.set(ctx.sessionManager, listeners = new Set());
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function notifySessionRoutingChanged(ctx: RoutingContext): void {
  for (const callback of [...(registry.listeners.get(ctx.sessionManager) ?? [])]) callback();
}

// Optional in-process extension contract, not a client/wire API. Separately
// packaged integrations can use the same routing boundary without importing
// another package's filesystem layout or handling any credentials themselves.
(globalThis as unknown as Record<string, unknown>).__paeSessionRoutingV1 = Object.freeze({
  protocol: 1,
  prepareRequest: prepareSessionRoutingRequest,
  physicalModelReference: resolveSessionPhysicalModelReference,
  bindModelRequest: bindSessionModelRequest,
});
