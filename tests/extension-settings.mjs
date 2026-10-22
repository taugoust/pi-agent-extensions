import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { snapshotExtensionSettings as snapshot } from '../shared/snapshot-extension-settings.mjs';

// Nix compiles the unchanged production TS to CommonJS. Only getAgentDir is
// supplied by a fixture SDK; filesystem/JSON/merge code is never mocked.
const defaults = createRequire(import.meta.url)(process.env.DEFAULTS_MODULE);
const manifest = JSON.parse(await readFile(new URL('../shared/extension-config-manifest.json', import.meta.url)));
const approved = [...manifest.defaults.map(n => `defaults/${n}.json`), ...manifest.preferences];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), dest = join(root, 'dest');
  await mkdir(source, { mode: 0o700 });
  await mkdir(dest, { mode: 0o700 });
  return { root, source, dest };
}
async function put(root, path, value) {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, value);
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const missing = async path => assert.rejects(lstat(path), { code: 'ENOENT' });

test('production merge precedence is recursive, pure, and replaces arrays/null/scalars', () => {
  const builtins = { nested: { a: 1, b: 1 }, list: [1], nullable: { a: 1 }, scalar: 1 };
  const operator = { nested: { b: 2 }, list: [2], nullable: null };
  const preferences = { nested: { a: 3 }, scalar: 3 };
  const session = { scalar: 4 };
  const before = structuredClone([builtins, operator, preferences, session]);
  const merged = [operator, preferences, session].reduce(defaults.mergeExtensionSettings, builtins);
  assert.deepEqual(merged, { nested: { a: 3, b: 2 }, list: [2], nullable: null, scalar: 4 });
  assert.deepEqual([builtins, operator, preferences, session], before);
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"ok":1}');
  assert.deepEqual(defaults.mergeExtensionSettings({}, malicious), { ok: 1 });
  assert.equal({}.polluted, undefined);
});

test('defaults reader and wrapper use the configured root and preserve validator inputs', async t => {
  const { source } = await fixture(t);
  process.env.PI_TEST_AGENT_DIR = source;
  t.after(() => delete process.env.PI_TEST_AGENT_DIR);
  assert.deepEqual(defaults.readExtensionDefaults('stamp'), {});
  await put(source, 'defaults/stamp.json', '{"display":{"enabled":true,"width":5}}');
  assert.deepEqual(defaults.withExtensionDefaults('stamp', { width: 8 }, 'display'), { enabled: true, width: 8 });
  assert.equal(defaults.withExtensionDefaults('stamp', null), null);
  await put(source, 'defaults/stamp.json', '{"display":false}');
  assert.throws(() => defaults.withExtensionDefaults('stamp', {}, 'display'), /must be an object/);
  assert.throws(() => defaults.readExtensionDefaults('../auth', source), /Invalid canonical/);
});

test('snapshot copies every approved path, preserves empty objects, excludes credentials/control and uses private modes', async t => {
  const { source, dest, root } = await fixture(t);
  for (const [i, path] of approved.entries()) await put(source, path, JSON.stringify(i === 0 ? {} : { fixture: path }));
  for (const path of ['auth.json', 'settings.json', 'accounts.json', 'sessions/session.jsonl', 'control.json', 'defaults/unapproved.json']) {
    await put(source, path, 'SECRET');
  }
  // Nix-managed source symlinks are intentionally supported.
  await put(root, 'store.json', '{"linked":true}');
  await rm(join(source, approved[1]));
  await symlink(join(root, 'store.json'), join(source, approved[1]));
  await snapshot(source, dest);
  for (const [i, path] of approved.entries()) {
    assert.deepEqual(await json(join(dest, path)), i === 0 ? {} : i === 1 ? { linked: true } : { fixture: path });
    assert.equal((await lstat(join(dest, path))).mode & 0o777, 0o600);
  }
  for (const path of ['auth.json', 'settings.json', 'accounts.json', 'sessions', 'control.json', 'defaults/unapproved.json']) await missing(join(dest, path));
  assert.equal((await lstat(join(dest, 'defaults'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(dest, 'extensions/pi-openai-fast-mode'))).mode & 0o777, 0o700);
  assert.equal((await readdir(join(dest, 'defaults'))).some(n => n.endsWith('.tmp')), false);
});

for (const sourceKind of ['empty', 'missing']) test(`${sourceKind} source cleans only approved stale files, never cwd or unrelated files`, async t => {
  const { root, dest } = await fixture(t);
  for (const path of approved) await put(dest, path, '{"stale":true}');
  await put(dest, 'defaults/unapproved.json', 'keep');
  await put(dest, 'auth.json', 'keep-secret');
  await put(root, 'defaults/stamp.json', '{"mustNotCopyCwd":true}');
  // Exercise the CLI with a controlled cwd, including the literal empty argument.
  execFileSync(process.execPath, [new URL('../shared/snapshot-extension-settings.mjs', import.meta.url).pathname,
    sourceKind === 'empty' ? '' : join(root, 'absent'), dest], { cwd: root });
  for (const path of approved) await missing(join(dest, path));
  assert.equal(await readFile(join(dest, 'auth.json'), 'utf8'), 'keep-secret');
  assert.equal(await readFile(join(dest, 'defaults/unapproved.json'), 'utf8'), 'keep');
});

test('same directory and symlink aliases are no-ops even with malformed settings', async t => {
  const { source, root } = await fixture(t);
  await put(source, approved[0], 'not JSON');
  const before = await lstat(join(source, approved[0]));
  await symlink(source, join(root, 'alias'));
  await snapshot(source, source);
  await snapshot(join(root, 'alias'), source);
  assert.equal(await readFile(join(source, approved[0]), 'utf8'), 'not JSON');
  assert.equal((await lstat(join(source, approved[0]))).ino, before.ino);
});

for (const kind of ['malformed', 'array', 'null', 'scalar', 'oversize', 'utf8', 'directory', 'fifo']) {
  test(`${kind} source fails before any destination changes; defaults reader also rejects`, async t => {
    const { source, dest } = await fixture(t);
    await put(source, approved[0], '{"new":true}');
    await put(dest, approved[0], '{"old":true}');
    const bad = join(source, 'defaults/openai-fast-mode.json');
    await mkdir(join(bad, '..'), { recursive: true });
    if (kind === 'directory') await mkdir(bad);
    else if (kind === 'fifo') execFileSync('mkfifo', [bad]);
    else await writeFile(bad, ({ malformed: '{', array: '[]', null: 'null', scalar: '1', oversize: ' '.repeat(65537), utf8: Buffer.from([0xff]) })[kind]);
    await assert.rejects(snapshot(source, dest));
    assert.throws(() => defaults.readPreferenceDocument(bad));
    assert.deepEqual(await json(join(dest, approved[0])), { old: true });
    assert.deepEqual(await readdir(dest), ['defaults']);
  });
}

test('destination safety rejects writable roots/parents and symlink parents without outside effects', async t => {
  const { source, dest, root } = await fixture(t);
  await put(source, approved[0], '{"new":true}');
  await chmod(dest, 0o777);
  await assert.rejects(snapshot(source, dest), /destination must/);
  await chmod(dest, 0o700);
  const outside = join(root, 'outside'); await mkdir(outside);
  await put(outside, 'stamp.json', 'untouched');
  await symlink(outside, join(dest, 'defaults'));
  await assert.rejects(snapshot(source, dest), /destination must/);
  assert.equal(await readFile(join(outside, 'stamp.json'), 'utf8'), 'untouched');
  await rm(join(dest, 'defaults'));
  await mkdir(join(dest, 'defaults'), { mode: 0o777 }); await chmod(join(dest, 'defaults'), 0o777);
  await assert.rejects(snapshot(source, dest), /destination must/);
  await assert.rejects(snapshot(source, ''), /must not be empty/);
});

test('destination file symlinks are replaced or unlinked, not followed; cleanup never recurses', async t => {
  const { source, dest, root } = await fixture(t);
  await put(root, 'outside.json', 'outside');
  await mkdir(join(dest, 'defaults'));
  await symlink(join(root, 'outside.json'), join(dest, approved[0]));
  await put(source, approved[0], '{"safe":true}');
  await snapshot(source, dest);
  assert.equal((await lstat(join(dest, approved[0]))).isSymbolicLink(), false);
  assert.deepEqual(await json(join(dest, approved[0])), { safe: true });
  await rm(join(source, approved[0]));
  await rm(join(dest, approved[0]));
  await symlink(join(root, 'outside.json'), join(dest, approved[0]));
  await snapshot(source, dest);
  await missing(join(dest, approved[0]));
  assert.equal(await readFile(join(root, 'outside.json'), 'utf8'), 'outside');
  await mkdir(join(dest, approved[0]));
  await put(dest, `${approved[0]}/unrelated`, 'keep');
  await assert.rejects(snapshot(source, dest));
  assert.equal(await readFile(join(dest, approved[0], 'unrelated'), 'utf8'), 'keep');
});

test('size boundary and newly created snapshot root are bounded and private', async t => {
  const { source, root } = await fixture(t);
  const dest = join(root, 'new-child');
  // JSON representation is 65535 bytes; snapshot adds exactly one newline.
  const contents = JSON.stringify({ x: 'a'.repeat(65527) });
  assert.equal(Buffer.byteLength(contents), 65535);
  await put(source, approved[0], contents);
  await snapshot(source, dest);
  assert.equal((await readFile(join(dest, approved[0]))).length, 65536);
  assert.equal((await lstat(dest)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(source, approved[0]), 'utf8'), contents);
  // Reader permits exactly 64 KiB, but snapshot must reject if serialization
  // would exceed the limit, before even creating a new destination root.
  await put(source, approved[0], JSON.stringify({ x: 'a'.repeat(65528) }));
  assert.equal(defaults.readExtensionDefaults('stamp', source).x.length, 65528);
  await assert.rejects(snapshot(source, join(root, 'not-created')), /serialized JSON/);
  await missing(join(root, 'not-created'));
  await assert.rejects(snapshot(source, dest), /serialized JSON/);
  assert.equal((await readFile(join(dest, approved[0]))).length, 65536);
});

test('legacy defaults-only copy executes real reader/writer and excludes preferences', async t => {
  const { source, dest } = await fixture(t);
  await put(source, 'defaults/stamp.json', '{"enabled":false}');
  await put(source, 'auth.json', 'SECRET');
  await put(source, 'pi-stamp.json', '{}');
  await put(dest, 'defaults/progress.json', '{"stale":true}');
  await put(dest, 'defaults/unapproved.json', 'keep');
  await defaults.copyExtensionDefaults(source, dest);
  assert.deepEqual(await json(join(dest, 'defaults/stamp.json')), { enabled: false });
  assert.equal((await lstat(join(dest, 'defaults/stamp.json'))).mode & 0o777, 0o600);
  await missing(join(dest, 'defaults/progress.json'));
  await missing(join(dest, 'auth.json')); await missing(join(dest, 'pi-stamp.json'));
  assert.equal(await readFile(join(dest, 'defaults/unapproved.json'), 'utf8'), 'keep');
});
