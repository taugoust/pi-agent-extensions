import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiNativeManager } from './tui-native.ts';

// Reload order is group-ID order, so a newer attempt can load before an older one.
for (const newerFirst of [true, false]) {
 test(`task inventory shows the highest attempt (newer group ID sorts ${newerFirst ? 'first' : 'last'})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-inventory-'));
  const manager: any = new TuiNativeManager(root, () => 'native', () => true, 16);
  try {
   const taskId = `subagent-task-${'a'.repeat(24)}`;
   const child = (attempt: number, digit: string, state: string) => ({ childId: `subagent-child-${digit.repeat(24)}`, taskId, attempt,
    directory: join(root, digit), spec: { task: 'Fixture' }, state, started: true, notifiedSequence: 0 });
   const older = { id: `subagent-job-${(newerFirst ? 'c' : 'b').repeat(24)}`, owner: 'parent', createdAt: 1, children: [child(1, 'b', 'completed')] };
   const newer = { id: `subagent-job-${(newerFirst ? 'b' : 'c').repeat(24)}`, owner: 'parent', createdAt: 2, children: [child(2, 'c', 'running')] };
   for (const g of [older, newer].sort((x, y) => x.id.localeCompare(y.id))) manager.groups.set(g.id, g);
   const [row] = manager.taskList('parent');
   assert.equal(row.attempt, 2);
   assert.equal(row.state, 'running');
   assert.equal(row.can_resume, false);
  } finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
 });
}
