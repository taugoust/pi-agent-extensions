#!/usr/bin/env node
/** Explicit GitLab MCP OAuth. No Pi configuration, model calls, or browser launching. */
import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export const GITLAB_MCP_URL = 'https://gitlab.com/api/v4/mcp/';
export const DEFAULT_REDIRECT_URL = 'http://127.0.0.1:8765/callback';
const RESOURCE_METADATA = 'https://gitlab.com/.well-known/oauth-protected-resource/api/v4/mcp';
const locks = new Map();
export class ForgeOAuthAuthRequiredError extends Error {
  constructor() { super('GitLab MCP authorization required; run forge-watch/auth.mjs login explicitly.'); this.name = 'ForgeOAuthAuthRequiredError'; }
}

/** Resolve only public package exports, relative to the installed public coding-agent entry. */
export async function loadOAuth(codingAgentEntry) {
  // Normal installs carry this standalone public dependency next to the extension.
  // The explicit entry is only an SDK/bootstrap fallback, never implicit host-layout discovery.
  if (!codingAgentEntry && !process.env.PI_CODING_AGENT_ENTRY) return import('@earendil-works/pi-mcp/oauth');
  const entry = codingAgentEntry ?? process.env.PI_CODING_AGENT_ENTRY;
  // pi-mcp exposes import-only conditions. Jiti (a public coding-agent dependency)
  // resolves these by package name without reaching into private dist paths.
  const { createJiti } = createRequire(entry)('jiti');
  return createJiti(entry, { moduleCache: true }).import('@earendil-works/pi-mcp/oauth');
}
export function oauthFile(agentDir) { return join(agentDir, 'forge-watch-oauth', 'gitlab.json'); }
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('OAuth endpoint must be credential-free HTTPS');
  return url.href;
}
function privateStat(stat, directory = false) {
  if (stat.uid !== process.getuid() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1)) {
    throw new Error('Unsafe OAuth credential ownership, type, or permissions (require directory 0700 / regular file 0600)');
  }
}
async function safeAncestors(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current);
    // A root-owned sticky directory (e.g. /tmp) cannot replace another user's entries.
    const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || ![0, process.getuid()].includes(stat.uid) || ((stat.mode & 0o022) && !trustedSticky)) {
      throw new Error('Unsafe OAuth credential ancestor directory');
    }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function secureDirectory(path) {
  await safeAncestors(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateStat(await lstat(path), true);
}

/** Durable McpOAuthStateStore with an endpoint-bound envelope and no symlink following. */
export class FileOAuthStateStore {
  constructor(file, serverUrl = GITLAB_MCP_URL) { this.file = resolve(file); this.serverUrl = endpoint(serverUrl); }
  async read() {
    let handle;
    try {
      // Check the directory even when the credential does not exist.
      await safeAncestors(dirname(dirname(this.file)));
      privateStat(await lstat(dirname(this.file)), true);
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat(); privateStat(stat);
      const maximum = 1024 * 1024;
      if (stat.size > maximum) throw new Error('OAuth credential file too large');
      const buffer = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break; size += bytesRead;
      }
      if (size > maximum) throw new Error('OAuth credential file too large');
      const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
      if (value.version !== 1 || value.serverUrl !== this.serverUrl || value.state?.serverUrl !== this.serverUrl) {
        throw new Error('OAuth credential endpoint or format mismatch');
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { await handle?.close(); }
  }
  async load() { return (await this.read())?.state; }
  async write(value) {
    await secureDirectory(dirname(this.file));
    await this.read(); // Never overwrite an unsafe existing credential.
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async save(state) {
    if (state.serverUrl !== this.serverUrl) throw new Error('OAuth state endpoint mismatch');
    const prior = await this.read();
    await this.write({ ...prior, version: 1, serverUrl: this.serverUrl, state });
  }
  async metadata(fields) {
    const prior = await this.read();
    await this.write({ ...prior, ...fields, version: 1, serverUrl: this.serverUrl, state: prior?.state ?? { serverUrl: this.serverUrl } });
  }
  /** Serialize whole grants/refreshes; fail closed if another process owns the file. No unsafe stale-lock recovery. */
  async exclusive(operation) {
    const previous = locks.get(this.file) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await secureDirectory(dirname(this.file));
      let lock;
      try { lock = await open(`${this.file}.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('OAuth credentials busy (or interrupted operation left .lock); do not remove a live lock'); throw error; }
      try { return await operation(); } finally { await lock.close(); await unlink(`${this.file}.lock`); }
    });
    locks.set(this.file, run);
    try { return await run; } finally { if (locks.get(this.file) === run) locks.delete(this.file); }
  }
}
function providerFor(oauth, store, redirectUrl, onRedirect) {
  return new oauth.McpOAuthProvider({ serverUrl: store.serverUrl, redirectUrl, store,
    clientMetadata: { client_name: 'forge-watch GitLab MCP', scope: 'mcp' }, onRedirect });
}
function flowOptions(store, options = {}) {
  return { serverUrl: store.serverUrl, scope: 'mcp',
    ...(store.serverUrl === GITLAB_MCP_URL ? { resourceMetadataUrl: new URL(RESOURCE_METADATA) } : {}),
    fetch: options.fetch, signal: options.signal ?? AbortSignal.timeout(30_000) };
}
export async function beginLogin({ file, serverUrl = GITLAB_MCP_URL, redirectUrl = DEFAULT_REDIRECT_URL, oauth, fetch, onAuthorization = () => {} }) {
  oauth ??= await loadOAuth();
  const redirect = new URL(redirectUrl);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error('Only HTTP 127.0.0.1 loopback redirects are supported');
  const store = new FileOAuthStateStore(file, serverUrl);
  return store.exclusive(async () => {
    const prior = await store.read();
    const registered = prior?.state.clientInformation?.redirect_uris;
    if (registered?.length && !registered.includes(redirect.href)) throw new Error('Redirect differs from durable client registration');
    await store.metadata({ redirectUrl: redirect.href, pendingUntil: Date.now() + 10 * 60_000 });
    const provider = providerFor(oauth, store, redirect.href, onAuthorization);
    // Fresh state for each explicit authorization; retain registration and existing refresh tokens.
    const state = await store.load(); delete state.oauthState; delete state.codeVerifier; await store.save(state);
    let authorizationUrl;
    const explicit = providerFor(oauth, store, redirect.href, async url => { authorizationUrl = url.href; await onAuthorization(url); });
    await oauth.authorizeMcp(explicit, { ...flowOptions(store, { fetch }), skipRefresh: true });
    return { authorizationUrl, redirectUrl: redirect.href, state: await provider.state() };
  });
}
export async function completeLogin({ file, response, serverUrl = GITLAB_MCP_URL, oauth, fetch }) {
  oauth ??= await loadOAuth();
  const store = new FileOAuthStateStore(file, serverUrl);
  return store.exclusive(async () => {
    const saved = await store.read();
    if (!saved?.pendingUntil || saved.pendingUntil < Date.now() || !saved.state.codeVerifier || !saved.state.oauthState) throw new Error('No unexpired pending OAuth login');
    let code = response.trim(), iss;
    if (URL.canParse(code)) {
      const callback = new URL(code), expected = new URL(saved.redirectUrl);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash || callback.searchParams.get('state') !== saved.state.oauthState) throw new Error('OAuth callback URL or state mismatch');
      if (callback.searchParams.has('error')) throw new Error('OAuth authorization declined');
      code = callback.searchParams.get('code') ?? ''; iss = callback.searchParams.get('iss') ?? undefined;
    }
    // A bare code is accepted only through this explicit manual completion entry point; PKCE still binds it.
    if (!code || /\s/.test(code)) throw new Error('Paste the complete redirect URL or authorization code');
    const provider = providerFor(oauth, store, saved.redirectUrl, () => { throw new ForgeOAuthAuthRequiredError(); });
    await oauth.authorizeMcp(provider, { ...flowOptions(store, { fetch }), authorizationCode: code, iss });
    await provider.invalidateCredentials('verifier');
    const state = await store.load(); delete state.oauthState; await store.save(state);
    await store.metadata({ pendingUntil: null });
    return { authorized: true, refreshable: Boolean((await provider.tokens())?.refresh_token) };
  });
}

/** No browser, registration, redirects or tool contexts. Refresh only a previously consented grant. */
export function createGitLabOAuth({ file, serverUrl = GITLAB_MCP_URL, oauth, fetch, refreshSkewMs = 60_000 } = {}) {
  if (!file) throw new Error('OAuth credential file is required');
  const store = new FileOAuthStateStore(file, serverUrl);
  const api = async () => oauth ??= await loadOAuth();
  const ensureToken = ({ forceRefresh = false, signal, rejectedToken } = {}) => store.exclusive(async () => {
    const saved = await store.read(), state = saved?.state;
    if (!state?.tokens?.access_token) throw new ForgeOAuthAuthRequiredError();
    const currentIsValid = state.tokensExpireAt === undefined || state.tokensExpireAt > Date.now() + refreshSkewMs;
    if (currentIsValid && (!forceRefresh || (rejectedToken !== undefined && rejectedToken !== state.tokens.access_token))) return state.tokens.access_token;
    if (!state.tokens.refresh_token || !state.clientInformation || !state.discovery?.authorizationServerMetadata) throw new ForgeOAuthAuthRequiredError();
    const publicOAuth = await api();
    const provider = providerFor(publicOAuth, store, saved.redirectUrl ?? DEFAULT_REDIRECT_URL, () => { throw new ForgeOAuthAuthRequiredError(); });
    try {
      const tokens = await publicOAuth.refreshAuthorization(state.discovery.authorizationServerUrl, {
        metadata: state.discovery.authorizationServerMetadata, clientInformation: state.clientInformation,
        resource: publicOAuth.selectResource(store.serverUrl, state.discovery.resourceMetadata),
        refreshToken: state.tokens.refresh_token, fetch, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      await provider.saveTokens({ ...tokens, scope: tokens.scope ?? state.tokens.scope });
      return tokens.access_token;
    } catch (error) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) {
        await provider.invalidateCredentials('tokens'); throw new ForgeOAuthAuthRequiredError();
      }
      // Never include a token endpoint's response body in an externally visible error.
      throw new Error('GitLab MCP OAuth refresh failed (network, timeout, or server error)');
    }
  });
  const getAccessToken = (options = {}) => ensureToken(options);
  return { getAccessToken, authProvider: {
    token: () => getAccessToken(),
    onUnauthorized: async context => {
      if (new Headers(context.response?.headers).get('www-authenticate')?.includes('insufficient_scope')) throw new ForgeOAuthAuthRequiredError();
      // Compare inside the same critical section as the refresh, so simultaneous 401s share rotation.
      await ensureToken({ forceRefresh: true, rejectedToken: context.token });
    },
  } };
}

async function main() {
  const args = process.argv.slice(2), command = args.shift() ?? 'help';
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const agentDir = option('--agent-dir') ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const file = option('--file') ?? oauthFile(agentDir);
  const redirectUrl = option('--redirect-url') ?? DEFAULT_REDIRECT_URL;
  if (!['begin', 'complete', 'login', 'check'].includes(command)) {
    console.log('Usage: node forge-watch/auth.mjs begin|complete|login|check [--agent-dir DIR] [--file FILE] [--redirect-url http://127.0.0.1:8765/callback] [--loopback]\nManual: begin prints a URL; complete reads a redirect URL/code from stdin. Login combines both. Set PI_CODING_AGENT_ENTRY to the public coding-agent entry when not resolvable by name.'); return;
  }
  if (command === 'check') { await createGitLabOAuth({ file }).getAccessToken(); console.log('GitLab MCP OAuth credentials available (no protocol/model call).'); return; }
  if (command === 'begin' || command === 'login') {
    let callback, result;
    try {
      if (args.includes('--loopback')) {
        if (command !== 'login') throw new Error('--loopback requires login');
        const url = new URL(redirectUrl);
        callback = await (await loadOAuth()).OAuthCallbackServer.listen({ port: Number(url.port), path: url.pathname, timeoutMs: 10 * 60_000 });
        if (callback.redirectUrl !== redirectUrl) throw new Error('Callback listener redirect does not match requested URL');
      }
      result = await beginLogin({ file, redirectUrl, onAuthorization: url => console.log(`Open this URL in your browser to explicitly consent to GitLab MCP access:\n${url.href}`) });
      if (command === 'begin') { console.log('Then run complete and paste the entire redirect URL (even if the browser cannot connect to localhost). Pending login expires in 10 minutes.'); return; }
      let response;
      if (callback) {
        const value = await callback.waitForCallback(result.state, new URL(result.redirectUrl).pathname);
        const url = new URL(result.redirectUrl); url.searchParams.set('code', value.code); url.searchParams.set('state', result.state); if (value.iss) url.searchParams.set('iss', value.iss); response = url.href;
      } else { response = await readResponse(); }
      const done = await completeLogin({ file, response });
      console.log(`GitLab MCP OAuth saved securely. Refresh token: ${done.refreshable ? 'available' : 'not issued'}.`);
    } finally { await callback?.close(); }
  } else {
    const done = await completeLogin({ file, response: await readResponse() });
    console.log(`GitLab MCP OAuth saved securely. Refresh token: ${done.refreshable ? 'available' : 'not issued'}.`);
  }
}
async function readResponse() {
  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const timer = setTimeout(() => input.close(), 10 * 60_000);
  try { process.stderr.write('Paste full redirect URL or code (use redirected stdin to avoid terminal echo):\n'); for await (const line of input) return line; throw new Error('No OAuth completion received'); }
  finally { clearTimeout(timer); input.close(); }
}
/** Deliberately allowlisted diagnostics: never expose server bodies, URLs, codes or token values. */
export function safeOAuthFailure(error) {
  const codes = ['EACCES', 'EPERM', 'ELOOP', 'ENOENT', 'EEXIST', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'invalid_grant', 'invalid_client', 'unauthorized_client', 'server_error'];
  if (codes.includes(error?.code)) return error.code;
  const names = ['OAuthRegistrationError', 'OAuthIssuerMismatchError', 'OAuthInsecureEndpointError', 'ForgeOAuthAuthRequiredError', 'AbortError', 'TimeoutError'];
  if (names.includes(error?.name)) return error.name + (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? ` HTTP ${error.status}` : '');
  const local = new Map([
    ['Unsafe OAuth credential ancestor directory', 'UNSAFE_ANCESTOR'],
    ['Unsafe OAuth credential ownership, type, or permissions (require directory 0700 / regular file 0600)', 'UNSAFE_CREDENTIAL_FILE'],
    ['OAuth credential endpoint or format mismatch', 'ENDPOINT_OR_FORMAT_MISMATCH'],
    ['OAuth credentials busy (or interrupted operation left .lock); do not remove a live lock', 'CREDENTIALS_BUSY'],
    ['No unexpired pending OAuth login', 'PENDING_LOGIN_EXPIRED_OR_MISSING'],
    ['OAuth callback URL or state mismatch', 'CALLBACK_MISMATCH'],
    ['fetch failed', 'NETWORK_FAILURE'],
  ]);
  return local.get(error?.message) ?? 'OAUTH_FAILED';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`GitLab MCP OAuth failed [${safeOAuthFailure(error)}]; no credentials or server response bodies are printed. Check file permissions, pending login, callback state, package resolution, and network availability.`); process.exitCode = 1; });
}
