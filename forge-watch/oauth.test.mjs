import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, lstat, readFile, writeFile, symlink, link, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileOAuthStateStore, ForgeOAuthAuthRequiredError, GITLAB_MCP_URL,
  beginLogin, completeLogin, createGitLabOAuth, loadOAuth, safeOAuthFailure,
} from './auth.mjs';

// Tests use the real public OAuth package, with network replaced by a deterministic fixture.
// Set PI_CODING_AGENT_ENTRY to the installed public entry if not resolvable by package name.
const oauth = await loadOAuth();
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'forge-oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'credentials'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'gitlab.json');
  return { root, directory, file, store: new FileOAuthStateStore(file) };
}
const metadata = {
  issuer: 'https://gitlab.com', authorization_endpoint: 'https://gitlab.com/oauth/authorize',
  token_endpoint: 'https://gitlab.com/oauth/token', registration_endpoint: 'https://gitlab.com/oauth/register',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
};
function fixture({ redirectUrl = 'http://127.0.0.1:8765/callback' } = {}) {
  const calls = [];
  let refreshError, refreshCount = 0, includeRefresh = true;
  const fetch = async (url, init = {}) => {
    url = new URL(url); calls.push({ url, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: 'https://gitlab.com/api/v4/mcp', authorization_servers: ['https://gitlab.com'], scopes_supported: ['mcp'] });
    if (url.pathname.includes('.well-known/')) return json(metadata);
    if (url.pathname === '/oauth/register') {
      const request = JSON.parse(init.body); assert.equal(request.scope, 'mcp'); assert.equal(request.token_endpoint_auth_method, 'none');
      return json({ ...request, client_id: 'fixture-client' });
    }
    if (url.pathname === '/oauth/token') {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('code'), 'fixture-code'); assert.ok(body.get('code_verifier')); assert.equal(body.get('redirect_uri'), redirectUrl);
        return json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh' });
      }
      assert.equal(body.get('grant_type'), 'refresh_token');
      refreshCount++;
      if (refreshError) return json({ error: refreshError, error_description: 'SENSITIVE SERVER BODY fixture-refresh' }, refreshError === 'server_error' ? 503 : 400);
      return json({ access_token: `fixture-access-${refreshCount}`, token_type: 'Bearer', expires_in: 3600, ...(includeRefresh ? { refresh_token: `fixture-refresh-${refreshCount}` } : {}) });
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  };
  return { fetch, calls, setRefreshError(value) { refreshError = value; }, omitRefresh() { includeRefresh = false; }, get refreshCount() { return refreshCount; } };
}
async function authorized(t) {
  const state = await setup(t), mock = fixture();
  const pending = await beginLogin({ file: state.file, oauth, fetch: mock.fetch });
  const response = new URL(pending.redirectUrl); response.searchParams.set('state', pending.state); response.searchParams.set('code', 'fixture-code');
  const result = await completeLogin({ file: state.file, response: response.href, oauth, fetch: mock.fetch });
  assert.deepEqual(result, { authorized: true, refreshable: true });
  return { ...state, mock };
}

test('public package loads by export name; credential store persists atomically with exact endpoint binding', async t => {
  const { file, directory, store } = await setup(t);
  await store.save({ serverUrl: GITLAB_MCP_URL, clientInformation: { client_id: 'fixture-client' }, tokens: { access_token: 'fixture-token', token_type: 'Bearer' } });
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await new FileOAuthStateStore(file).load()).tokens.access_token, 'fixture-token');
  assert.deepEqual(await readdir(directory), ['gitlab.json']);
  await assert.rejects(new FileOAuthStateStore(file, 'https://gitlab.com/api/v4/mcp').load(), /endpoint/);
  await assert.rejects(store.save({ serverUrl: 'https://other.example/mcp' }), /endpoint/);
});

test('unsafe credential modes and directory modes fail closed without changing bytes', async t => {
  const { store, file, directory } = await setup(t);
  await store.save({ serverUrl: GITLAB_MCP_URL });
  const before = await readFile(file, 'utf8');
  await chmod(file, 0o644);
  await assert.rejects(store.load(), /Unsafe/);
  await assert.rejects(store.save({ serverUrl: GITLAB_MCP_URL }), /Unsafe/);
  assert.equal(await readFile(file, 'utf8'), before);
  await chmod(file, 0o600); await chmod(directory, 0o755);
  await assert.rejects(store.load(), /Unsafe/);
});

test('symlink, hard-linked credentials and nonregular files are rejected', async t => {
  const { store, file, root } = await setup(t);
  const target = join(root, 'target'); await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, file); await assert.rejects(store.load()); await rm(file);
  await link(target, file); await assert.rejects(store.load(), /Unsafe/); await rm(file);
  await mkdir(file, { mode: 0o700 }); await assert.rejects(store.load(), /Unsafe/);
  // Ownership cannot be changed in an unprivileged fixture; the runtime stat.uid guard is explicit.
});

test('symlink and writable ancestor paths are rejected', async t => {
  const { root, directory } = await setup(t);
  const alias = join(root, 'alias'); await symlink(directory, alias);
  await assert.rejects(new FileOAuthStateStore(join(alias, 'gitlab.json')).save({ serverUrl: GITLAB_MCP_URL }), /Unsafe/);
  const unsafe = join(root, 'unsafe'); await mkdir(unsafe, { mode: 0o700 }); await chmod(unsafe, 0o777);
  await assert.rejects(new FileOAuthStateStore(join(unsafe, 'private', 'gitlab.json')).save({ serverUrl: GITLAB_MCP_URL }), /Unsafe/);
});

test('oversized, malformed, wrong-envelope and foreign state are rejected', async t => {
  const { file, store } = await setup(t);
  await writeFile(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 }); await assert.rejects(store.load(), /too large/);
  await writeFile(file, '{'); await assert.rejects(store.load(), SyntaxError);
  await writeFile(file, JSON.stringify({ version: 1, serverUrl: GITLAB_MCP_URL, state: { serverUrl: 'https://foreign.example/mcp' } }));
  await assert.rejects(store.load(), /endpoint/);
});

test('manual URL authorization uses PKCE, mcp scope, state; durable registration survives explicit begin', async t => {
  const { file, store } = await setup(t), mock = fixture();
  const first = await beginLogin({ file, oauth, fetch: mock.fetch });
  const url = new URL(first.authorizationUrl);
  assert.equal(url.searchParams.get('scope'), 'mcp'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), first.state);
  const second = await beginLogin({ file, oauth, fetch: mock.fetch });
  assert.notEqual(second.state, first.state);
  assert.equal(mock.calls.filter(call => call.url.pathname === '/oauth/register').length, 1);
  const response = new URL(second.redirectUrl); response.searchParams.set('state', second.state); response.searchParams.set('code', 'fixture-code');
  await completeLogin({ file, response: response.href, oauth, fetch: mock.fetch });
  const saved = await store.read();
  assert.equal(saved.state.clientInformation.client_id, 'fixture-client'); assert.equal(saved.state.tokens.refresh_token, 'fixture-refresh');
  assert.equal(saved.state.codeVerifier, undefined); assert.equal(saved.state.oauthState, undefined); assert.equal(saved.pendingUntil, null);
  await assert.rejects(completeLogin({ file, response: response.href, oauth, fetch: mock.fetch }), /pending/);
});

test('manual callback rejects mismatched state/endpoint and expiry before token exchange', async t => {
  const { file, store } = await setup(t), mock = fixture();
  const pending = await beginLogin({ file, oauth, fetch: mock.fetch });
  for (const response of ['http://127.0.0.1:8765/callback?code=fixture-code&state=wrong', `http://evil.example/callback?code=fixture-code&state=${pending.state}`]) {
    await assert.rejects(completeLogin({ file, response, oauth, fetch: mock.fetch }), /mismatch/);
  }
  await store.metadata({ pendingUntil: Date.now() - 1 });
  await assert.rejects(completeLogin({ file, response: 'fixture-code', oauth, fetch: mock.fetch }), /pending/);
  assert.equal(mock.calls.filter(call => call.url.pathname === '/oauth/token').length, 0);
});

test('explicit bare-code completion and cached noninteractive token need no network', async t => {
  const { file } = await setup(t), mock = fixture();
  await beginLogin({ file, oauth, fetch: mock.fetch });
  await completeLogin({ file, response: 'fixture-code', oauth, fetch: mock.fetch });
  const before = mock.calls.length;
  assert.equal(await createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken(), 'fixture-access');
  assert.equal(mock.calls.length, before);
});

test('idle expiry refresh persists rotation, expiry, client information and scope across restart', async t => {
  const { file, store, mock } = await authorized(t);
  const state = await store.load(); state.tokensExpireAt = 1; await store.save(state);
  assert.equal(await createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken(), 'fixture-access-1');
  const after = await store.load(); assert.equal(after.tokens.refresh_token, 'fixture-refresh-1'); assert.equal(after.tokens.scope, 'mcp');
  assert.ok(after.tokensExpireAt > Date.now()); assert.equal(after.clientInformation.client_id, 'fixture-client');
  assert.equal(await createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken(), 'fixture-access-1');
  assert.equal(mock.refreshCount, 1);
});

test('refresh response omitting refresh_token preserves existing token', async t => {
  const { file, store, mock } = await authorized(t); mock.omitRefresh();
  await createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken({ forceRefresh: true });
  assert.equal((await store.load()).tokens.refresh_token, 'fixture-refresh');
});

test('concurrent 401s (including independent helpers) share one rotating refresh', async t => {
  const { file, mock } = await authorized(t);
  const first = createGitLabOAuth({ file, oauth, fetch: mock.fetch }), second = createGitLabOAuth({ file, oauth, fetch: mock.fetch });
  const context = { token: 'fixture-access', response: new Response(null, { status: 401 }) };
  await Promise.all([first.authProvider.onUnauthorized(context), second.authProvider.onUnauthorized(context), first.authProvider.onUnauthorized(context)]);
  assert.equal(mock.refreshCount, 1);
  assert.equal(await second.authProvider.token(), 'fixture-access-1');
});

test('noninteractive missing credentials/refresh/client/discovery fail closed without registration or redirects', async t => {
  const { file, store } = await setup(t), mock = fixture();
  const helper = createGitLabOAuth({ file, oauth, fetch: mock.fetch });
  await assert.rejects(helper.getAccessToken(), ForgeOAuthAuthRequiredError);
  await store.save({ serverUrl: GITLAB_MCP_URL, tokens: { access_token: 'fixture-access', token_type: 'Bearer' }, tokensExpireAt: 1 });
  await assert.rejects(helper.getAccessToken(), ForgeOAuthAuthRequiredError);
  assert.equal(mock.calls.length, 0);
});

test('revoked refresh fails auth-required, retains registration, never retries DCR or auth redirects', async t => {
  const { file, store, mock } = await authorized(t); mock.setRefreshError('invalid_grant');
  const before = mock.calls.length;
  await assert.rejects(createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken({ forceRefresh: true }), ForgeOAuthAuthRequiredError);
  assert.equal(mock.calls.length, before + 1); assert.equal((await store.load()).tokens, undefined);
  assert.equal((await store.load()).clientInformation.client_id, 'fixture-client');
});

test('transient refresh errors preserve durable grant and never leak server response bodies', async t => {
  const { file, store, mock } = await authorized(t); mock.setRefreshError('server_error');
  await assert.rejects(createGitLabOAuth({ file, oauth, fetch: mock.fetch }).getAccessToken({ forceRefresh: true }), error => {
    assert.equal(error.message, 'GitLab MCP OAuth refresh failed (network, timeout, or server error)'); assert.ok(!error.message.includes('SENSITIVE')); return true;
  });
  assert.equal((await store.load()).tokens.refresh_token, 'fixture-refresh');
});

test('insufficient_scope never refreshes or opens interactive authorization', async t => {
  const { file, mock } = await authorized(t), before = mock.calls.length;
  await assert.rejects(createGitLabOAuth({ file, oauth, fetch: mock.fetch }).authProvider.onUnauthorized({ token: 'fixture-access', response: new Response(null, { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } }) }), ForgeOAuthAuthRequiredError);
  assert.equal(mock.calls.length, before);
});

test('preexisting cross-process lock fails closed and is not silently removed', async t => {
  const { file, store } = await setup(t);
  await writeFile(`${file}.lock`, '', { mode: 0o600 });
  await assert.rejects(store.exclusive(() => assert.fail('must not run')), /busy/);
  assert.ok(await lstat(`${file}.lock`));
});

test('bounded loopback callback uses public API and completes the durable grant', async t => {
  const { file } = await setup(t);
  const callback = await oauth.OAuthCallbackServer.listen({ port: 0, path: '/callback', timeoutMs: 1000 });
  t.after(() => callback.close());
  const mock = fixture({ redirectUrl: callback.redirectUrl });
  const pending = await beginLogin({ file, oauth, fetch: mock.fetch, redirectUrl: callback.redirectUrl });
  const waiting = callback.waitForCallback(pending.state, '/callback');
  const response = new URL(callback.redirectUrl); response.searchParams.set('code', 'fixture-code'); response.searchParams.set('state', pending.state);
  assert.equal((await fetch(response)).status, 200);
  const value = await waiting; assert.equal(value.code, 'fixture-code');
  assert.equal((await completeLogin({ file, response: response.href, oauth, fetch: mock.fetch })).authorized, true);
});

test('diagnostics redact arbitrary errors, endpoints, secrets and server bodies', () => {
  assert.equal(safeOAuthFailure(new Error('fixture-secret')), 'OAUTH_FAILED');
  assert.equal(safeOAuthFailure({ name: 'OAuthRegistrationError', status: 401, message: 'fixture-secret', body: 'fixture-secret' }), 'OAuthRegistrationError HTTP 401');
  assert.equal(safeOAuthFailure({ code: 'fixture-secret' }), 'OAUTH_FAILED');
});
