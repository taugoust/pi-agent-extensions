import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractToolPresentation as extract, validateToolPresentation as validate, extractToolPresentationArguments, validateToolPresentationArguments, utf8ByteLength } from './tool-presentation.ts';
import { readRetainedConversation } from '../subagent/retained-conversation.ts';
export const command = 'cd /home/theo/.worktrees/paseo/web-plugin-surface-focus && node .dev/verify-accounts.cjs > .dev/repaired-browser.log 2>&1';
export const raw = 'job-2083c71f9e35e537555f2506  Running  0s  Ready repaired Accounts repeat proof\ncwd: /home/theo\ncommand: '+command+'\nStarted in a new tmux pane.';
export const typed = { content: [{type:'text',text:raw}], details: {job_id:'job-2083c71f9e35e537555f2506',name:'Ready repaired Accounts repeat proof',status:'running',action:'start',command,cwd:'/home/theo', capability:'PRIVATE',socketPath:'/private/socket'} };
test('complete known native families, exact search leaf aliases and strict argument validation',()=>{
 for (const name of ['fetch','notify_parent','goal_complete','sandbox_allow_path','sandbox_allow_read_path','sandbox_allow_domain','sandbox_allow_unix_socket']) {
  const result={content:[{type:'text',text:'first'},{type:'text',text:'second'}],isError:true,details:{token:'PRIVATE'}};
  assert.deepEqual(extract(name,result)?.result,{content:result.content,isError:true,details:{}});
  assert.equal(extract(name,JSON.stringify(result)),undefined);
 }
 const result={structuredContent:{output:'failure',exit_code:2}};
 assert.deepEqual(extract('bash',result)?.result,result);
 for(const name of ['mcp__search__web_search','MCP__Provider__WeB_SeArCh','mcp__search__tavily_search']) {
  const v=extract(name,{structuredContent:{query:'one; two',results:[],durationSeconds:1}})!;assert.equal(v.toolName,name);assert.deepEqual(validate(v),v);
  assert.deepEqual(extractToolPresentationArguments(name,{queries:['one','two'],token:'PRIVATE'}),{queries:['one','two']});
 }
 for(const name of ['functions.read','mcp__provider__read','mcp__provider__web','mcp__provider__web.run']) assert.equal(extract(name,typed),undefined);
 assert.deepEqual(validateToolPresentationArguments('fetch',{url:'https://example.com',method:'GET'}),{url:'https://example.com',method:'GET'});
 assert.equal(validateToolPresentationArguments('fetch',{url:'https://example.com',token:'PRIVATE'}),undefined);
 assert.equal(validateToolPresentationArguments('read',{command:'not read args'}),undefined);
 const task={task_id:'opaque',attempt:2,displayName:'Readable',title:'Title',name:'Name',label:'Label',execution:'completed',status:'completed',state:'completed',outcome:'delivered',task_outcome:{state:'delivered'},accepted_delivery:true,verification:{status:'passed'}};
 assert.deepEqual(extract('subagent',{details:{tasks:[task],foreground_tasks:[task],group:task,children:[task]}})?.result.details,{tasks:[task],foreground_tasks:[task],group:task,children:[task]});
});
test('canonical display field matrix survives without runtime metadata',()=>{
 const details = { operation:'result',background_subagent:true,attempt:2,model:'human-model',task_title:'Accounts',stopReason:'aborted',status:'cancelled',failed:true,exitCode:1,errorMessage:'failed',job_id:'job-safe',child_id:'child-safe',child:1,offset:0,bytes:3,total_bytes:6,next_offset:3,diagnostics:true,complete:false,
 task_outcomes:[{child:1,attempt:2,reported:true,state:'partial',summary:'working'}],
 group:{job_id:'job-safe',mode:'single',background:true,background_subagent:true,status:'running',children:[{child:1,child_id:'child-safe',task_id:'task-safe',name:'Readable',displayName:'Readable worker',label:'First',status:'running',reaped:false}],result_children:[{child:1,label:'First',bytes:3,total_bytes:6,complete:false}]},
 sessionFile:'/private/session',manifest:{token:'SECRET'},socketPath:'/private/socket' };
 const v=extract('subagent',{content:[{type:'text',text:'abc'}],details})!;
 const {sessionFile,manifest,socketPath,...safe}=details;assert.deepEqual(v.result.details,safe);assert.deepEqual(validate(v),v);
 for(const [name,details] of Object.entries({goal_wait:{reason:'waiting',requested_resume_after_ms:1,resume_after_ms:1000},goal_blocked:{reason:'blocked',evidence:'proof'},update_progress:{steps:[{text:'step',status:'blocked'}]},questionnaire:{questions:[{id:'q',prompt:'Choose'}],answers:[{id:'q',label:'Human answer'}]},edit:{diff:'@@ diff'},background_job:{tracking_kind:'tmux-pane',events:[{rule:'done',kind:'match',text:'ready',status:'running'}],watches:[{label:'Build',status:'watching'}]}})) assert.deepEqual(extract(name,{details})?.result.details,details);
});
test('native web search typed groups and annotations only; nested arbitrary metadata omitted',()=>{
 const structuredContent={query:'Accounts',durationSeconds:0.5,results:['annotation',{tool_use_id:'opaque',content:[{title:'Result',url:'https://example.com',token:'PRIVATE'}]}],token:'PRIVATE'};
 const v=extract('web_search',{structuredContent})!;assert.ok(v);assert.ok(!JSON.stringify(v).includes('PRIVATE'));assert.deepEqual(validate(v),v);
 assert.equal(extract('web_search',JSON.stringify({structuredContent})),undefined);
 assert.equal(extract('web_search',{structuredContent:{...structuredContent,results:[{tool_use_id:'id',content:[{title:'missing URL'}]}]}}),undefined);
});
test('dependency-free UTF8 and aggregate hard bounds including non-JSON object traps',()=>{
 for(const text of ['ASCII','λ🚀','\\ud800','\\udc00','a\\ud800b','\\ud800🚀']) assert.equal(utf8ByteLength(text),Buffer.byteLength(text));
 const deep:any={};let next=deep;for(let i=0;i<14;i++) next=next.child={};
 const wide=Object.fromEntries(Array.from({length:520},(_,i)=>['key'+i,i]));
 const strings=Array(64).fill('x'.repeat(500));
 const getter=Object.defineProperty({},'status',{enumerable:true,get(){throw new Error('must not execute');}});
 const array:any=[];array.__protoKey='bad';
 for(const unsafe of [deep,wide,strings,getter,array,{toJSON(){return 'secret';}}]) assert.equal(extract('background_job',{details:{unsafe}}),undefined);
 assert.deepEqual(extractToolPresentationArguments('subagent',{operation:'result',job_id:'opaque',token:'PRIVATE'}),{operation:'result',job_id:'opaque'});
 assert.equal(extractToolPresentationArguments('subagent','{"operation":"result"}'),undefined);
});
test('typed projection only, exact raw fallback, no inference and no private metadata',()=>{
 const v=extract('background_job',typed)!;
 assert.equal(v.result.content![0].text,raw); assert.equal((v.result.details as any).status,'running');
 assert.ok(!JSON.stringify(v).includes('PRIVATE')); assert.ok(!JSON.stringify(v).includes('socketPath'));
 assert.deepEqual(validate(v),v);
 assert.equal(extract('background_job',raw),undefined);
 assert.equal(extract('background_job',JSON.stringify(typed)),undefined);
 assert.equal(extract('unknown',typed),undefined);
 assert.equal(validate({...v,authority:true}),undefined);
 assert.equal(validate({...v,result:{...v.result,details:{token:'secret'}}}),undefined);
});
test('native optional undefined properties are omitted just as JSON transport, nullable exit is retained',()=>{
 const native = {...typed,details:{...typed.details,exit_code:undefined,signal:undefined,child_id:undefined}};
 assert.deepEqual(extract('background_job',native),extract('background_job',JSON.parse(JSON.stringify(native))));
 const nullable=extract('background_job',{content:[],details:{status:'cancelled',exit_code:null}})!;
 assert.deepEqual(validate(nullable),nullable);
 assert.equal(validate({...nullable,result:{...nullable.result,other:undefined}}),undefined);
});
test('unsafe, malformed and bounded metadata omitted; error typed results preserved',()=>{
 for(const details of [{status:3},{status:Infinity},{name:'x'.repeat(8193)},{jobs:Array(65).fill({})},JSON.parse('{"__proto__":{}}')]) assert.equal(extract('background_job',{content:[],details}),undefined);
 const cycle:any={};cycle.self=cycle; assert.equal(extract('background_job',{details:cycle}),undefined);
 assert.equal(extract('background_job',{content:[],details:{status:'failed'},isError:true})?.result.isError,true);
 assert.equal(extract('background_job',{details:{status:'running'},content:[{type:'image',data:'private'}]}),undefined);
});
test('readonly pre-clipping arguments and latest raw result never inherit stale typed state',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-latest-'));chmodSync(dir,0o700);const path=join(dir,'session.jsonl');
 const args={command:'echo '+ 'safe '.repeat(900)};
 const call={type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'same',name:'bash',arguments:args}]}};
 const structured={type:'message',message:{role:'toolResult',toolCallId:'same',toolName:'bash',content:[{type:'text',text:'typed'}],details:{exitCode:0}}};
 const raw={type:'message',message:{role:'toolResult',toolCallId:'same',toolName:'bash',content:'literal raw failed prose'}};
 try {
 writeFileSync(path,[call,structured,raw].map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
 let messages=readRetainedConversation(path).messages;let part:any=messages[0].parts![0];
 assert.deepEqual(part.toolArguments,args);assert.notDeepEqual(part.arguments,args);assert.equal(part.arguments.truncated,true);
 assert.equal(part.toolPresentation,undefined);assert.equal(part.result,'literal raw failed prose');assert.equal(part.status,'completed');
 const cursor=Buffer.byteLength([call,structured].map(r=>JSON.stringify(r)).join('\n')+'\n');
 const olderPart:any=readRetainedConversation(path,cursor).messages[0].parts![0];assert.equal(olderPart.result,'literal raw failed prose');assert.equal(olderPart.toolPresentation,undefined);
 const duplicate={...call,message:{...call.message,content:[...call.message.content,...call.message.content]}};
 writeFileSync(path,[duplicate,structured].map(r=>JSON.stringify(r)).join('\n')+'\n');
 messages=readRetainedConversation(path).messages;
 for(const part of messages[0].parts as any[]) {assert.equal(part.toolArguments,undefined);assert.equal(part.toolPresentation,undefined);}
 const oversized={...call,message:{...call.message,content:[{...call.message.content[0],arguments:{command:'x'.repeat(8193)}}]}};
 writeFileSync(path,JSON.stringify(oversized)+'\n');assert.equal((readRetainedConversation(path).messages[0].parts![0] as any).toolArguments,undefined);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('retained paired and tool message envelopes equal extraction; old snapshots unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'presentation-'));chmodSync(dir,0o700);const path=join(dir,'session.jsonl');
 try {
 const rows=[{type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'call1',name:'background_job',arguments:{action:'start',command}}]}},{type:'message',message:{role:'toolResult',toolCallId:'call1',toolName:'background_job',...typed}}];
 writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
 const messages=readRetainedConversation(path).messages;
 const part:any=messages[0].parts![0];assert.deepEqual(part.toolPresentation,extract('background_job',typed));assert.deepEqual(messages[1].toolPresentation,part.toolPresentation);assert.equal(messages[1].text,raw);assert.equal(part.result,raw);
 writeFileSync(path,JSON.stringify({type:'message',message:{role:'toolResult',toolCallId:'old',toolName:'background_job',content:raw}})+'\n');
 const old=readRetainedConversation(path).messages[0];assert.equal(old.toolPresentation,undefined);assert.equal(old.text,raw);
 const searchResult={content:[{type:'text',text:'original search fallback'}],structuredContent:{query:'Accounts',durationSeconds:0.5,results:[{tool_use_id:'opaque',content:[{title:'Hit',url:'https://example.com'}]}]}};
 writeFileSync(path,JSON.stringify({type:'message',message:{role:'toolResult',toolCallId:'search',toolName:'web_search',...searchResult}})+'\n');
 const searchMessage=readRetainedConversation(path).messages[0];assert.deepEqual(searchMessage.toolPresentation,extract('web_search',searchResult));assert.equal(searchMessage.text,'original search fallback');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
