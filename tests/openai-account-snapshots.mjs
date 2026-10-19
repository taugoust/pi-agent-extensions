import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from '../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs';
const jiti=createJiti(import.meta.url);
const {createAccountControlsSnapshot}=await jiti.import('../openai-accounts/account-controls.ts');
const {default:usage}=await jiti.import('../openai-usage/index.ts');
const {ACCOUNT_CONTROLS_KEY}=await jiti.import('../shared/account-controls.ts');
function owner(){return {sessionId:'s',signal:new AbortController().signal,selections:{openai:'work'},selectionRevisions:new Map([['openai',2]]),results:new Map([['openai',{status:'active'}]]),appliedIdentities:new Map([['openai','work:fake-original-key']]),pendingSyncTasks:new Map(),switchReserved:0,openAIRequestCount:0,context:{isIdle:()=>true,modelRegistry:{getProvider(){throw Error('Must not fall back to builtin profile');}}}};}
function store(credential){return {readAsync:async()=>({providers:{openai:{accounts:credential?{work:credential}:{}}}})};}
test('removed or replaced named credentials never report builtin authentication or old verified binding',async()=>{
 for(const credential of [undefined,{type:'api_key',key:'fake-new-key'}]){
  const snapshot=await createAccountControlsSnapshot(owner(),store(credential),'epoch');
  assert.equal(snapshot.defaultSelected,false);assert.equal(snapshot.currentAccountId,'work');assert.equal(snapshot.usage.status,'unavailable');assert.equal(snapshot.usage.settingsUrl,null);assert.notEqual(snapshot.activationStatus,'active');assert.equal(JSON.stringify(snapshot).includes('fake-'),false);
 }
 const matched=await createAccountControlsSnapshot(owner(),store({type:'api_key',key:'fake-original-key'}),'epoch');
 assert.equal(matched.activationStatus,'active');assert.equal(matched.usage.status,'local-binding-confirmed');assert.equal(JSON.stringify(matched).includes('fake-original-key'),false);
});
test('snapshot busy flags are checked after asynchronous store access',async()=>{
 const o=owner();let release;const ready=new Promise(resolve=>release=resolve);
 const pending=createAccountControlsSnapshot(o,{readAsync:async()=>{await ready;return {providers:{openai:{accounts:{work:{type:'api_key',key:'fake-original-key'}}}}};}},'epoch');
 o.context.isIdle=()=>false;release();const snapshot=await pending;assert.equal(snapshot.busy,true);assert.equal(snapshot.canSwitch,false);
});
test('usage command rejects a service for another session and suppresses a superseded response',async()=>{
 const commands=new Map(),notices=[];usage({registerCommand:(name,command)=>commands.set(name,command)});
 const ctx={hasUI:true,sessionManager:{getSessionId:()=> 'current'},ui:{notify:message=>notices.push(message)}};
 const previous=globalThis[ACCOUNT_CONTROLS_KEY];
 try {
  let reads=0;globalThis[ACCOUNT_CONTROLS_KEY]={protocol:1,sessionId:'other',getSnapshot:async()=>{reads++;throw Error('Unexpected');}};
  await commands.get('usage').handler('',ctx);assert.equal(reads,0);assert.deepEqual(notices,['OpenAI credential status unavailable.']);
  notices.length=0;let release;const result=new Promise(resolve=>release=resolve);
  globalThis[ACCOUNT_CONTROLS_KEY]={protocol:1,sessionId:'current',getSnapshot:()=>result};
  const pending=commands.get('usage').handler('',ctx);globalThis[ACCOUNT_CONTROLS_KEY]={protocol:1,sessionId:'current',getSnapshot:()=>result};
  release({sessionId:'current',usage:{effectiveCredential:'api-key-configured',settingsUrl:null}});await pending;assert.equal(notices.length,0);
 }finally{if(previous===undefined)delete globalThis[ACCOUNT_CONTROLS_KEY];else globalThis[ACCOUNT_CONTROLS_KEY]=previous;}
});
