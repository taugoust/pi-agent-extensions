/** Typed adapter facade. The standalone bootstrap and durable state format live in auth.mjs. */
import { createGitLabOAuth as createOAuth } from "./auth.mjs";

export {
  beginLogin,
  completeLogin,
  DEFAULT_REDIRECT_URL,
  FileOAuthStateStore,
  ForgeOAuthAuthRequiredError,
  GITLAB_MCP_URL,
  loadOAuth,
  oauthFile,
} from "./auth.mjs";

export interface GitLabOAuthOptions {
  /** `${agentDir}/forge-watch-oauth/gitlab.json`; never a shared global Pi OAuth file. */
  file: string;
  serverUrl?: string;
  fetch?: typeof globalThis.fetch;
  refreshSkewMs?: number;
  /** Public @earendil-works/pi-mcp/oauth module, loaded alongside the adapter client. */
  oauth?: Awaited<ReturnType<typeof import("./auth.mjs")["loadOAuth"]>>;
}
export interface GitLabOAuthHelper {
  /** Refreshes a previously authorized grant only. Never starts registration or redirects. */
  getAccessToken(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<string>;
  authProvider: {
    token(): Promise<string>;
    onUnauthorized(context: { token?: string; response: Response }): Promise<void>;
  };
}

export const createGitLabOAuth: (options: GitLabOAuthOptions) => GitLabOAuthHelper = createOAuth;
