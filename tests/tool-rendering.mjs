// Run: node tests/tool-rendering.mjs <source-root> <stock-pi-package-root>
// Offline, real Pi ToolExecutionComponent composition (not renderer text alone).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = resolve(process.argv[2] ?? '.');
const sdk = resolve(process.argv[3] ?? 'node_modules/@earendil-works/pi-coding-agent');
const { createJiti } = await import(pathToFileURL(join(sdk, 'node_modules/jiti/lib/jiti.mjs')));
const alias = { '@earendil-works/pi-coding-agent': join(sdk,'dist/index.js'), '@sinclair/typebox':join(sdk,'node_modules/typebox/build/index.mjs') };
for (const name of ['pi-ai','pi-tui','pi-agent-core']) alias[`@earendil-works/${name}`] = join(sdk,`node_modules/@earendil-works/${name}/dist/${name === 'pi-ai' ? 'compat' : 'index'}.js`);
for (const [key,value] of Object.entries(alias)) if(key.startsWith('@earendil-works/')) alias[key.replace('@earendil-works/','@mariozechner/')]=value;
alias.typebox = join(sdk,'node_modules/typebox/build/index.mjs');
const jiti = createJiti(import.meta.url, { alias });
const { ToolExecutionComponent } = await import(pathToFileURL(join(sdk,'dist/modes/interactive/components/tool-execution.js')));
const { initTheme } = await import(pathToFileURL(join(sdk,'dist/modes/interactive/theme/theme.js')));
initTheme('dark');
function load(module) {
 let tool;
 const pi = { registerTool(t) { if (t.name === module.replace('-', '_')) tool=t; }, on(){}, registerCommand(){}, registerShortcut(){}, registerFlag(){}, events:new EventEmitter(), getFlag(){}, appendEntry(){} };
 return jiti.import(join(source,module,'index.ts')).then(async m => { await m.default(pi); assert.ok(tool, `registered ${module}`); return tool; });
}
const { formatStatus, goalSummary } = await jiti.import(join(source,'workflows/goal/runtime.ts'));
const pausedGoal = { status:'paused', text:'Footer regression', automaticModelTurns:3, safetyPauseCause:'continuation_limit', iteration:1, timeUsedSeconds:0, tokensUsed:0 };
for (const limit of [3, 10, null]) {
 assert.equal(formatStatus(pausedGoal, limit), 'Goal ■');
 assert.match(goalSummary(pausedGoal, limit), /Automatic work: 3/);
 assert.match(goalSummary(pausedGoal, limit), /Safety pause:/);
}
assert.equal(formatStatus(undefined), undefined);
assert.equal(formatStatus({...pausedGoal,status:'active'}, null), 'Goal ✓');
assert.equal(formatStatus({...pausedGoal,status:'complete'}, null), 'Goal ✓');
const job = await load('background-job');
const name='Repeated output fixture';
for (const action of ['output','reap']) for (const partial of [false,true]) for (const width of [64,120]) {
 const content = action === 'reap' ? 'Job reaped' : 'same intentional line\nsame intentional line\nUnicode 日本語 ✓';
 const result={content:[{type:'text',text:content}], details:{action,job_id:'job-'+'1'.repeat(24),name,status:'completed'}};
 const c=new ToolExecutionComponent('background_job','fixture',{action}, {},job,{requestRender(){}},source);
 if(partial)c.updateResult({content:[{type:'text',text:'partial'}],details:{}},true);
 c.updateResult(result,false);
 for(let repaint=0;repaint<3;repaint++) {
  const rendered=c.render(width).join('\n');
  assert.equal(rendered.split(action==='reap'?'Job reaped':'same intentional line').length-1,action==='reap'?1:2,`${action} partial=${partial} width=${width}`);
  c.setExpanded(repaint%2===0); c.invalidate();
 }
 assert.equal(result.content[0].text,content,'model content unchanged');
}
const theme={fg:(_c,t)=>t,bold:t=>t};
const yielded={content:[{type:'text',text:'Full no-suspension semantic contract'}],details:{action:'yield',jobs:[{name,status:'completed'}]}};
assert.match(job.renderResult(yielded,{expanded:false},theme).render(120).join('\n'),/Run yielded · 1 job/);
assert.match(job.renderResult(yielded,{expanded:true},theme).render(120).join('\n'),/Full no-suspension/);
const failed = new ToolExecutionComponent('background_job','error',{action:'output'}, {},job,{requestRender(){}},source);
failed.updateResult({content:[{type:'text',text:'Retained command failed'}],isError:true,details:{action:'output',job_id:'job-'+'2'.repeat(24),name,status:'failed'}},false);
assert.equal(failed.render(64).join('\n').split('Retained command failed').length-1,1);
const subagent=await load('subagent');
const sy={content:[{type:'text',text:'Full contract: no suspension or output consumed'}],details:{operation:'yield',background_subagent:true,groups:[{children:[{label:'Human task',status:'running'}]}]}};
assert.match(subagent.renderResult(sy,{expanded:false},theme).render(64).join('\n'),/Run yielded · 1 group/);
assert.match(subagent.renderResult(sy,{expanded:true},theme).render(64).join('\n'),/no suspension/);
const r={label:'Report',task:'PRIVATE TASK METADATA',exitCode:0,messages:[{role:'assistant',content:[{type:'text',text:'Useful worker answer 日本語'}]}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:0},stderr:'',model:'fixture',tools:['read'],cwd:'/fixture'};
const rendered=subagent.renderResult({content:[],details:{mode:'single',results:[r]}},{expanded:true},theme).render(120).join('\n');
assert.ok(rendered.indexOf('Useful worker answer')<rendered.indexOf('PRIVATE TASK METADATA'));
assert.match(rendered,/Diagnostics/);
for(const file of ['subagent/result-report.test.ts','subagent/legacy-result-report.test.ts','background-job/yield.test.mjs']) await jiti.import(join(source,file));
if (process.env.TEST_TMUX && process.env.TEST_RUNNER) await jiti.import(join(source,'background-job/retention.test.mjs'));
console.log('PASS real Pi composition: partial/final, final-only/reload, repaint, expansion, Unicode, intentional repeated lines, report order and retained presentation');
