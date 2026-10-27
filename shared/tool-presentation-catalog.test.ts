import assert from 'node:assert/strict';
import test from 'node:test';
import {extractToolPresentation,extractRetainedToolPresentation,extractToolPresentationArguments,validateToolPresentation,validateToolPresentationArguments,PASEO_PRESENTATION_TOOL_NAMES} from './tool-presentation.ts';

test('native background failure carries only independent user-visible stderr, never stream internals',()=>{
 const input={content:[{type:'text',text:'Combined terminal log'}],isError:true,details:{job_id:'job-'+'1'.repeat(24),action:'wait',status:'failed',exit_code:2,streams:{available:true,stderr:'Actual stderr diagnostic',stdout:'PRIVATE_STDOUT_COPY',socketPath:'/PRIVATE_SOCKET',capability:'PRIVATE_CAPABILITY'},manifest:{sessionFile:'/PRIVATE_SESSION'}}};
 const projected=extractToolPresentation('background_job',input)!;
 assert.ok(projected);assert.deepEqual((projected.result.details as Record<string,unknown> | undefined)?.streams,{available:true,stderr:'Actual stderr diagnostic'});
 assert.doesNotMatch(JSON.stringify(projected),/PRIVATE/);assert.deepEqual(validateToolPresentation(projected),projected);
 assert.equal(input.details.streams.stdout,'PRIVATE_STDOUT_COPY','extractor never mutates original fallback source');
 assert.equal(extractToolPresentation('background_job',{...input,details:{...input.details,streams:{available:'true',stderr:'bad'}}}),undefined);
});

test('retained lifecycle flags and private record fields are not promoted into native result data',()=>{
 const message={role:'toolResult',toolName:'notify_parent',toolCallId:'call',content:[{type:'text',text:'Queued for the parent; no reply yet.'}],isError:false,sessionFile:'/PRIVATE_SESSION'};
 const projected=extractRetainedToolPresentation('notify_parent',message)!;
 assert.deepEqual(projected.result,{content:message.content});
 assert.equal(projected.result.isError,undefined);
 assert.doesNotMatch(JSON.stringify(projected),/PRIVATE|toolCallId|role/);
 assert.equal(message.isError,false);
});

test('all reviewed public Paseo names preserve ordinary native-visible arguments and text-only results',()=>{
 assert.equal(PASEO_PRESENTATION_TOOL_NAMES.length,62);
 const args={agentId:'agent',workspaceId:'workspace',title:'Fixture',name:'Fixture',prompt:'Hello',initialPrompt:'Initial',path:'/visible/path',filePaths:['/visible/upload'],fullPage:true,width:800,height:600};
 const result={content:[{type:'text',text:'{"literal":"control response text"}'}]};
 for(const leaf of PASEO_PRESENTATION_TOOL_NAMES){
  for(const name of [`mcp__paseo__${leaf}`,`paseo.${leaf}`]){
   const safe=extractToolPresentationArguments(name,args);assert.deepEqual(safe,args,name);assert.deepEqual(validateToolPresentationArguments(name,safe),safe);
   const output=extractToolPresentation(name,result);assert.ok(output,name);assert.equal(output.toolName,name);assert.equal(output.result.content?.[0].text,result.content[0].text);assert.deepEqual(validateToolPresentation(output),output);
  }
 }
 for(const name of ['create_agent','paseo_catalog','mcp__other__create_agent','mcp__paseo__not_a_public_tool'])assert.equal(extractToolPresentationArguments(name,args),undefined,name);
});

test('unexpected catalog objects fail closed without losing or parsing the opaque fallback',()=>{
 const args={agentId:'agent',settings:{headers:{Authorization:'PRIVATE'}}};
 assert.equal(extractToolPresentationArguments('mcp__paseo__create_agent',args),undefined);
 assert.equal(args.settings.headers.Authorization,'PRIVATE');
 const structuredOnly={structuredContent:{agentId:'user-visible-result',capability:'PRIVATE'}};
 assert.equal(extractToolPresentation('mcp__paseo__create_agent',structuredOnly),undefined,'unprojected sole payload must not become an empty successful envelope');
 assert.equal(structuredOnly.structuredContent.agentId,'user-visible-result');
 const literal='{"content":[{"type":"text","text":"do not reinterpret"}]}';
 assert.equal(extractToolPresentation('mcp__paseo__create_agent',literal),undefined);
 assert.equal(extractToolPresentationArguments('exec_command',{cmd:'visible',unknown:'keep in raw input'}),undefined,'unclassified tools keep complete opaque input, not partial guessed arguments');
});
