// Offline behavioral coverage of the registered production tool and its real TUI renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sourceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const sdkRoot = realpathSync(process.argv[3] ?? join(sourceRoot, 'node_modules/@earendil-works/pi-coding-agent'));
const { createJiti } = await import(pathToFileURL(join(sdkRoot, 'node_modules/jiti/lib/jiti.mjs')));
globalThis.fetch = () => { throw new Error('Network forbidden in Goal presentation check'); };
const jiti = createJiti(import.meta.url, { alias: {
  'typebox': join(sdkRoot, 'node_modules/typebox/build/index.mjs'),
  '@earendil-works/pi-coding-agent': join(sdkRoot, 'dist/index.js'),
  '@earendil-works/pi-ai': join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  '@earendil-works/pi-tui': join(sdkRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { registerGoalManagement } = await jiti.import(join(sourceRoot, 'workflows/goal/model-control.ts'));
const { GoalRuntime, formatFooterStatus } = await jiti.import(join(sourceRoot, 'workflows/goal/runtime.ts'));
const { bindGoalMutations } = await jiti.import(join(sourceRoot, 'workflows/goal/mutations.ts'));
const { writeProgress, mutateProgress } = await jiti.import(join(sourceRoot, 'shared/goal-progress.ts'));
const { normalizeGoalManageDisplay } = await jiti.import(join(sourceRoot, 'workflows/goal/presentation.ts'));
const theme = { fg: (_color, text) => text, bold: text => text };
function fixture() {
  let tool;
  const entries = [];
  const pi = {
    registerTool(t) { tool = t; }, on() {}, events: new EventEmitter(),
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendMessage() {}, getActiveTools: () => ['goal_complete', 'goal_blocked', 'goal_wait'],
  };
  const runtime = new GoalRuntime(pi);
  const ctx = {
    cwd: '/nonexistent/offline-goal-presentation', model: { id: 'offline' },
    sessionManager: { getSessionId: () => 'offline', getBranch: () => entries, getEntries: () => entries },
    ui: { setStatus() {}, notify() {} }, getContextUsage: () => ({ tokens: 0 }),
    isIdle: () => true, hasPendingMessages: () => false, abort() {},
  };
  runtime.bindWorkflowSession(ctx.sessionManager);
  bindGoalMutations(pi, ctx, runtime, { child: false, busy: () => false });
  registerGoalManagement(pi, runtime);
  // The current goal is created through update_progress; goal_manage create is saved-scope only.
  const create = params => mutateProgress(pi, ctx, { action: 'create', steps: [], ...params });
  return { pi, runtime, tool, ctx, create, execute: params => tool.execute('test', params, undefined, undefined, ctx) };
}
test('registered goal_manage exposes saved list/start schema and dispatches through the owner service, not the current Goal',async()=>{
 const f=fixture();const calls=[];
 assert.match(JSON.stringify(f.tool.parameters),/"saved"/);assert.match(JSON.stringify(f.tool.parameters),/"list"/);assert.match(JSON.stringify(f.tool.parameters),/"start"/);
 globalThis.__paeWorkflowsV1={protocol:1,sessionId:'offline',async manageSavedGoal(params,ctx){calls.push({params,ctx});return {scope:'saved',goals:[{id:'saved-id',status:'paused',revision:9}]};}};
 try{
  const list=await f.execute({scope:'saved',action:'list'});assert.equal(JSON.parse(plain(list)).goals[0].id,'saved-id');assert.equal(f.runtime.activeGoal,undefined);assert.equal(calls[0].ctx,f.ctx);
  const params={scope:'saved',action:'start',goal_id:'saved-id',expected_revision:9,request_id:'explicit-start',user_authorized:true};await f.execute(params);assert.deepEqual(calls[1].params,params);assert.equal(f.runtime.activeGoal,undefined);
  assert.equal(text(f.tool.renderCall(params,theme)),'Goal manage saved start');
  await assert.rejects(f.execute({action:'start',goal_id:'saved-id'}),/scope:saved/);
  globalThis.__paeWorkflowsV1.sessionId='foreign';await assert.rejects(f.execute({scope:'saved',action:'list'}),/unavailable/);
 }finally{delete globalThis.__paeWorkflowsV1;}
});

test('footer contains only the running tick or stopped square, never details', () => {
  const goal = { text: 'Private goal objective', waiting: { reason: 'Long private waiting explanation', resumeAt: 123 }, automaticModelTurns: 7, tokenBudget: 42, tokensUsed: 12 };
  for (const limit of [null, 10]) {
    assert.equal(formatFooterStatus(undefined, limit, theme), undefined);
    for (const waiting of [undefined, goal.waiting]) {
      assert.equal(formatFooterStatus({ ...goal, waiting, status: 'active' }, limit, theme), 'Goal ✓');
      for (const status of ['paused', 'blocked', 'usage_limited', 'budget_limited']) assert.equal(formatFooterStatus({ ...goal, waiting, status }, limit, theme), 'Goal ■');
      assert.equal(formatFooterStatus({ ...goal, waiting, status: 'complete' }, limit, theme), undefined);
    }
  }
  const f = fixture();
  const calls = [];
  f.ctx.ui.setStatus = (...args) => calls.push(args);
  f.runtime.showCompletionStatus(f.ctx);
  assert.deepEqual(calls, [['goal', undefined]], 'completion must remove the indicator immediately');
});
const context = (args, isError = false) => ({ args, isError });
const text = component => component.render(2000).map(line => line.trimEnd()).join('\n');
const plain = result => result.content.map(b => b.text).join('\n');

for (const objective of ['Validate this outcome.', 'Quotes: "yes"; path \\tmp; emoji ✓!', 'First line.\nSecond line: "Objective:" — done?']) {
  test(`registered renderers preserve contract, objective punctuation: ${JSON.stringify(objective)}`, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.execute({ action: 'create', objective, request_id: 'create', start: false }), /update_progress action:create/);
      f.create({ objective, request_id: 'create', start: false });
      for (const action of ['status', 'update', 'resume', 'pause', 'clear']) {
        const previous = f.runtime.activeGoal;
        const args = { action, ...(previous ? { goal_id: previous.id, activation_id: previous.activationId, expected_revision: previous.revision } : {}),
          ...(action === 'create' ? { request_id: 'create', start: false } : {}),
          ...(['update', 'resume', 'pause', 'clear'].includes(action) ? { user_authorized: true } : {}),
          ...(['create', 'update'].includes(action) ? { objective } : {}),
        };
        assert.equal(text(f.tool.renderCall(args, theme, context(args))), `Goal manage ${action}`);
        const result = await f.execute(args);
        const goal = f.runtime.activeGoal;
        if (action === 'pause' || action === 'clear') {
          assert.equal(plain(result), action === 'pause' ? 'Goal paused. Wait for explicit resume.' : 'Goal cleared and retained in history; not marked complete.');
          assert.equal(result.details.goalId, previous.id);
          assert.equal(result.terminate, action === 'pause');
        } else {
          const payload = JSON.parse(plain(result));
          assert.equal(payload.activationId, goal.activationId);
          assert.equal(payload.revision, goal.revision);
          if (action === 'create') assert.equal(payload.goalId, goal.id);
          else {
            assert.equal(payload.id, goal.id); assert.equal(payload.objective, objective);
            assert.deepEqual(result.details.goal.tasks, []);
          }
        }
        const snapshot = structuredClone(result);
        assert.deepEqual(result.details.presentation, { version: 1, tool: 'goal_manage', action, objective });
        for (const expanded of [false, true]) {
          const visible = text(f.tool.renderResult(result, { expanded, isPartial: false }, theme, context(args)));
          assert.equal(visible, `Objective: ${objective}`);
          for (const forbidden of [previous?.id, goal?.id, 'Required tasks', 'update_progress', 'user_authorized'].filter(Boolean))
            assert.equal(visible.includes(forbidden), false);
        }
        assert.deepEqual(normalizeGoalManageDisplay(JSON.parse(JSON.stringify(result))), { text: `Objective: ${objective}`, isError: false });
        assert.deepEqual(result, snapshot, 'Rendering never mutates full machine-facing content/details/terminate');
      }
      assert.equal(f.runtime.activeGoal, undefined);
      const empty = await f.execute({ action: 'status' });
      assert.equal(text(f.tool.renderResult(empty, {}, theme, context({ action: 'status' }))), 'No current goal.');
    } finally { f.runtime.releaseWorkflow(); }
  });
}

test('paused completion presentation preserves verification evidence without exposing machine controls', async () => {
  const f = fixture();
  const objective = 'Verified paused outcome.';
  f.create({ objective, request_id: 'create', start: false, steps: [{ text: 'Verify', status: 'completed' }] });
  const previous = f.runtime.activeGoal;
  const args = { action: 'complete', goal_id: previous.id, activation_id: previous.activationId, expected_revision: previous.revision,
    user_authorized: true, summary: 'Verified all requirements with passing tests.' };
  try {
    assert.ok(f.tool.parameters.properties.action.anyOf.some(action => action.const === 'complete'));
    assert.equal(f.tool.parameters.properties.summary.maxLength, 4000);
    assert.equal(text(f.tool.renderCall(args, theme, context(args))), 'Goal manage complete');
    const result = await f.execute(args), snapshot = structuredClone(result);
    assert.equal(plain(result), `Goal complete: ${args.summary}`);
    assert.equal(result.details.summary, args.summary); assert.equal(result.details.goal_id, previous.id);
    assert.equal(result.terminate, true); assert.equal(f.runtime.activeGoal, undefined);
    assert.deepEqual(result.details.presentation, { version: 1, tool: 'goal_manage', action: 'complete', objective });
    for (const expanded of [false, true])
      assert.equal(text(f.tool.renderResult(result, { expanded }, theme, context(args))), `Objective: ${objective}`);
    assert.deepEqual(normalizeGoalManageDisplay(JSON.parse(JSON.stringify(result))), { text: `Objective: ${objective}`, isError: false });
    assert.deepEqual(result, snapshot);
  } finally { f.runtime.clearCompletionStatusTimer(); }
});

test('errors override structured objective; missing objective is never fabricated from arguments', async () => {
  const f = fixture();
  const args = { action: 'resume', goal_id: 'stale-id', objective: 'Do not display me', user_authorized: true };
  await assert.rejects(f.execute(args), /Goal identity/);
  const result = { content: [{ type: 'text', text: 'Goal changed; get status and use the current goal_id' }],
    details: { goal: { objective: 'Not success' }, presentation: { version: 1, tool: 'goal_manage', action: 'resume', objective: 'Not success' } } };
  for (const errorSource of ['context', 'result']) {
    const errorResult = { ...result, ...(errorSource === 'result' ? { isError: true } : {}) };
    const snapshot = structuredClone(errorResult);
    assert.equal(text(f.tool.renderResult(errorResult, {}, theme, context(args, errorSource === 'context'))), plain(result));
    assert.equal(normalizeGoalManageDisplay(errorResult, errorSource === 'context').isError, true);
    assert.deepEqual(errorResult, snapshot);
  }
  for (const details of [undefined, {}, { goal: null }, { goal: { objective: '' } }, { goal: { objective: '  ' } },
    { presentation: { version: 1, tool: 'goal_manage', action: 'resume' } }]) {
    const missing = { content: [{ type: 'text', text: 'Missing objective diagnostic' }], details };
    assert.equal(text(f.tool.renderResult(missing, { expanded: true }, theme, context(args))), plain(missing));
  }
  for (const args of [{}, { action: 'res' }, { action: 'status\nsecret' }])
    assert.equal(text(f.tool.renderCall(args, theme, context(args))), 'Goal manage');
  // Older structured results still render without regex-parsing their machine contract.
  assert.equal(normalizeGoalManageDisplay({ content: result.content, details: { goal: { objective: 'Legacy goal.' } } }).text, 'Objective: Legacy goal.');
});


test('required task IDs and full control contract remain machine-facing only', async () => {
  const f = fixture();
  f.create({ objective: 'A concise outcome.', request_id: 'create', start: false });
  const progress = writeProgress(f.pi, f.ctx, [{ text: 'Verify the outcome', status: 'pending' }], f.runtime.activeGoal.id, false, false);
  const result = await f.execute({ action: 'status' });
  assert.deepEqual(result.details.goal.tasks, progress.steps);
  assert.ok(plain(result).includes(JSON.stringify(progress.steps)));
  assert.equal(JSON.parse(plain(result)).revision, f.runtime.activeGoal.revision);
  const snapshot = structuredClone(result);
  assert.equal(text(f.tool.renderResult(result, { expanded: true }, theme, context({ action: 'status' }))), 'Objective: A concise outcome.');
  assert.deepEqual(result, snapshot);
});

test('current-goal lifecycle actions reject request_id with a scope-specific message and accept the documented shape', async () => {
  const f = fixture();
  try {
    f.create({ objective: 'Request id contract.', request_id: 'create', start: false });
    const goal = f.runtime.activeGoal;
    const shape = { action: 'resume', goal_id: goal.id, activation_id: goal.activationId, expected_revision: goal.revision, user_authorized: true };
    await assert.rejects(f.execute({ ...shape, request_id: 'retry-1' }), /Omit request_id for current-goal lifecycle actions; it is used only with scope:saved/);
    assert.equal(f.runtime.activeGoal.revision, goal.revision, 'rejected call changed nothing');
    await assert.rejects(f.execute({ ...shape, start: true }), /start is create-only/);
    await f.execute(shape);
    assert.equal(f.runtime.activeGoal.status, 'active');
    // A retry of the same call fails safely on the revision fence instead of applying twice.
    await assert.rejects(f.execute(shape), /revision changed/);
  } finally { f.runtime.releaseWorkflow(); }
});
