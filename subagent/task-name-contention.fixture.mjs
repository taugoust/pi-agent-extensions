import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
// Deterministic barrier: report the actual failed exclusive acquisition, not
// merely process startup. The implementation itself is not replaced.
if (process.env.PI_NAME_DROP_EVENTS === '1') {
  const watch = fs.watch;
  fs.watch = function (path, listener) { return watch.call(this, path, () => {}); };
}
const open = fs.openSync;
let notified = false;
fs.openSync = function (...args) {
  try { return open.apply(this, args); }
  catch (error) {
    if (String(args[0]).endsWith('/.write-lock') && error.code === 'EEXIST' && !notified) {
      notified = true;
      process.send({ contended: true });
    }
    throw error;
  }
};
syncBuiltinESMExports();
const { TaskNameStore } = await import(process.env.PI_NAME_STORE_BASELINE ?? './task-name-store.ts');
const [root, id, operation] = process.argv.slice(2);
const identity = { ownerSessionId: 'owner', taskId: id, groupId: 'group', childId: id, attempt: 1, runtimeId: id, workerEpoch: id };
const store = new TaskNameStore(join(root, 'workers', id), identity);
await new Promise(resolve => { process.once('message', resolve); process.send({ ready: true }); });
try {
  const result = operation === 'claim' ? await store.claim('Parallel Task') : await store.rename('Renamed Task', 1, 'pi');
  process.send({ result });
} catch (error) {
  let lockState;
  try { const s = fs.lstatSync(join(root, 'task-names', '.write-lock')); lockState = { inode: s.ino, size: s.size }; }
  catch (inspection) { lockState = inspection.code; }
  process.send({ error: error.message, lockState }); process.exitCode = 1;
}
process.disconnect();
