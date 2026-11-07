export type ForgeProvider = "github" | "gitlab";
export type ForgeCategory = "head" | "state" | "comments" | "reviews" | "ci";

export interface ForgeTarget {
  provider: ForgeProvider;
  host: string;
  project: string;
  number: number;
  url: string;
}

export interface ForgeItem {
  id: string;
  fingerprint: string;
  actor?: string;
}

export interface ForgeSnapshot {
  head: string;
  state: string;
  comments: ForgeItem[];
  reviews: ForgeItem[];
  ci: ForgeItem[];
}

export interface ForgeAdapter {
  poll(target: ForgeTarget, signal: AbortSignal): Promise<ForgeSnapshot>;
}

export interface ForgeIdentity {
  sessionId: string;
  goalId: string;
  activationId: string;
}

export interface ForgeEvent {
  id: string;
  target: ForgeTarget;
  category: ForgeCategory;
  fingerprint: string;
  at: number;
}

export interface ForgeSubscription {
  id: string;
  identity: ForgeIdentity;
  target: ForgeTarget;
  categories: ForgeCategory[];
  ignoreActors: string[];
  active: boolean;
  deliveryNotified?: boolean;
  overflow?: string;
}

export interface ForgeWatchState {
  version: 1;
  targets: Record<string, { target: ForgeTarget; baseline?: ForgeSnapshot; retryCount: number; nextPollAt: number; lastError?: string }>;
  subscriptions: Record<string, ForgeSubscription>;
  queues: Record<string, ForgeEvent[]>;
  nextEvent: number;
}

export interface ForgeWatchStorage {
  update<T>(mutate: (state: ForgeWatchState) => T): Promise<T>;
}

export interface ForgeWatchOptions {
  adapter: ForgeAdapter;
  storage: ForgeWatchStorage;
  wake?: (identity: ForgeIdentity, events: ForgeEvent[]) => Promise<void> | void;
  isEligible?: (identity: ForgeIdentity) => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  intervalMs?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxEventsPerSubscription?: number;
  maxBackoffMs?: number;
  jitter?: (delayMs: number) => number;
}

export interface ForgeWatchStatus {
  subscription: ForgeSubscription;
  pending: number;
  lastError?: string;
  nextPollAt?: number;
}

export function parseTarget(value: string, configuredHosts: string[] = []): ForgeTarget {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Target must be a fully qualified forge URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Target must be a clean HTTPS URL");
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/\/$/, "");
  const allowed = new Set(["github.com", "gitlab.com", ...configuredHosts.map((h) => h.toLowerCase())]);
  if (!allowed.has(host)) throw new Error(`Unconfigured forge host: ${host}`);
  const gh = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (gh) return target("github", host, `${gh[1]}/${gh[2]}`, gh[3]);
  const gl = path.match(/^\/(.+)\/\-\/merge_requests\/(\d+)$/);
  if (gl) return target("gitlab", host, gl[1], gl[2]);
  const selfGitlab = path.match(/^\/(.+)\/merge_requests\/(\d+)$/);
  if (selfGitlab && host !== "github.com") return target("gitlab", host, selfGitlab[1], selfGitlab[2]);
  throw new Error("URL is not a supported GitHub pull request or GitLab merge request");
}

function target(provider: ForgeProvider, host: string, project: string, raw: string): ForgeTarget {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || project.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid forge target");
  const base = `https://${host}/${project}`;
  return { provider, host, project, number, url: provider === "github" ? `${base}/pull/${number}` : `${base}/-/merge_requests/${number}` };
}
