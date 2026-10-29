// Run: node tests/extension-reload.mjs <stock-pi-package-root>
// Exercise Home Manager's stable symlinks across two immutable bundle versions.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sdk = resolve(process.argv[2] ?? 'node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = await import(pathToFileURL(join(sdk, 'node_modules/jiti/lib/jiti.mjs')));
const root = mkdtempSync(join(tmpdir(), 'pi-reload-entry-'));
try {
  for (const name of ['old', 'new', 'live']) mkdirSync(join(root, name));
  for (const name of ['old', 'new']) {
    const entry = join(root, name, 'index.ts');
    writeFileSync(entry, 'import {status} from "./runtime.js"; export {status}; export default ()=>status;');
    writeFileSync(join(root, name, 'runtime.ts'), `export const status=${JSON.stringify(name)};`);
    writeFileSync(join(root, name, 'wrapper.ts'), `export {default} from ${JSON.stringify(entry)}; export * from ${JSON.stringify(entry)};`);
  }
  for (const name of ['old', 'new']) {
    const live = join(root, 'live', 'index.ts');
    if (name === 'new') unlinkSync(live);
    symlinkSync(join(root, name, 'wrapper.ts'), live);
    const module = await createJiti(import.meta.url, {moduleCache:false, tryNative:false}).import(live);
    assert.equal(module.default(), name, 'reload must use the new transitive implementation');
    assert.equal(module.status, name, 'named exports must match the same release');
  }
  console.log('PASS immutable entry wrapper refreshes the complete module graph across symlink upgrades');
} finally { rmSync(root, { recursive:true, force:true }); }
