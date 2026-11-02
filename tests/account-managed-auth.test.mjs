import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {stripTypeScriptTypes,syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const compiled=await mkdtemp(join(tmpdir(),'account-proof-source-'));
test.after(()=>rm(compiled,{recursive:true,force:true}));
// Only the SDK's agent-directory lookup is replaced. Actual snapshot logic,
// filesystem operations and credential/identity guards execute unmodified.
let source=stripTypeScriptTypes(await readFile(new URL('../openai-accounts/account-controls.ts',import.meta.url),'utf8'));
const sdkImport=/import\s*\{\s*getAgentDir\s*,?\s*\}\s*from\s*["']@earendil-works\/pi-coding-agent["'];/;
assert.match(source,sdkImport);
source=source.replace(sdkImport,'const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;').replace('./private-auth-json.js','./private-auth-json.mjs');
await writeFile(join(compiled,'account-controls.mjs'),source);
await writeFile(join(compiled,'private-auth-json.mjs'),stripTypeScriptTypes(await readFile(new URL('../openai-accounts/private-auth-json.ts',import.meta.url),'utf8')));
const {createAccountControlsSnapshot}=await import(pathToFileURL(join(compiled,'account-controls.mjs')));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jwt=claims=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'managed-auth-proof-')),dir=join(root,'agent');await mkdir(dir,{mode:0o700});
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 t.after(async()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(root,{recursive:true,force:true});});
 const credentials={openai:{type:'oauth',clientId:'synthetic-client',scopes:['chatgpt.tokens.use.direct'],access:jwt({sub:'native-subject'}),expires:Date.now()+3600000},'openai-codex':{type:'oauth',access:jwt({sub:'codex-subject',chatgpt_account_id:'synthetic-account'}),accountId:'synthetic-account',expires:Date.now()+3600000}};
 const target=join(root,'private.json');await writeFile(target,JSON.stringify(credentials),{mode:0o600});
 const models=[{id:'native',provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1'},{id:'codex',provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'}];
 const registry={getProvider:id=>({baseUrl:models.find(m=>m.provider===id).baseUrl,getModels:()=>models.filter(m=>m.provider===id)}),getAll:()=>models,getRegisteredNativeProvider:()=>undefined,getRegisteredProviderConfig:()=>undefined,getProviderAuthStatus:()=>({configured:true,source:'stored'}),isUsingOAuth:()=>true};
 const owner={sessionId:'session',signal:new AbortController().signal,sessionManager:{getSessionId:()=>'session'},selections:{},selectionRevisions:new Map(),results:new Map(),appliedIdentities:new Map(),pendingSyncTasks:new Map(),switchReserved:0,openAIRequestCount:0,context:{isIdle:()=>true,model:models[0],modelRegistry:registry}};
 const store={readAsync:async()=>({providers:{openai:{accounts:{}},'openai-codex':{accounts:{}}}})};
 const snapshot=provider=>createAccountControlsSnapshot(owner,store,'epoch',[],provider);
 return {root,dir,target,credentials,registry,owner,snapshot,link:async()=>{await symlink(target,join(root,'managed'));await symlink('../managed',join(dir,'auth.json'));}};
}

test('direct and managed default credentials publish the same exact noncredential OpenAI/Codex proof',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.dir,'auth.json'),JSON.stringify(f.credentials),{mode:0o600});
 const native=await f.snapshot('openai'),codex=await f.snapshot('openai-codex');
 assert.equal(native.usage.nativeRegistrationKey,hash(['openai-native','synthetic-client','native-subject']));assert.equal(codex.usage.accountKey,hash(['openai-codex','synthetic-account','codex-subject']));
 await rm(join(f.dir,'auth.json'));await f.link();
 assert.deepEqual((await f.snapshot('openai')).usage,native.usage);assert.deepEqual((await f.snapshot('openai-codex')).usage,codex.usage);
 assert.ok(!JSON.stringify([native,codex]).includes('.synthetic'));assert.ok(!JSON.stringify([native,codex]).includes('native-subject'));
});

test('unsafe or malformed managed targets never publish proof or choose another provider grant',async t=>{
 const f=await fixture(t);await f.link();
 const denied=async()=>{assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);assert.equal((await f.snapshot('openai-codex')).usage.accountKey,undefined);};
 for(const mode of [0o644,0o620]){await chmod(f.target,mode);await denied();}await chmod(f.target,0o600);
 await writeFile(f.target,'private-fixture-invalid-json');await denied();await writeFile(f.target,' '.repeat(1024*1024+1));await denied();
 await rm(f.target);await mkdir(f.target);await denied();await rm(f.target,{recursive:true});await denied();
 await rm(join(f.dir,'auth.json'));await symlink('auth.json',join(f.dir,'auth.json'));await denied();
});

test('custom provider/auth/selection or scope metadata remains ineligible even with a readable managed target',async t=>{
 const f=await fixture(t);await f.link();
 f.registry.getRegisteredNativeProvider=()=>({});assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);assert.equal((await f.snapshot('openai-codex')).usage.accountKey,undefined);
 f.registry.getRegisteredNativeProvider=()=>undefined;f.registry.getRegisteredProviderConfig=()=>({apiKey:'custom'});assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);assert.equal((await f.snapshot('openai-codex')).usage.accountKey,undefined);
 f.registry.getRegisteredProviderConfig=()=>undefined;f.owner.context.model.baseUrl='https://untrusted.invalid';assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);f.owner.context.model.baseUrl='https://api.openai.com/v1';
 f.credentials.openai.scopes=[];await writeFile(f.target,JSON.stringify(f.credentials));assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);
 delete f.credentials['openai-codex'];await writeFile(f.target,JSON.stringify(f.credentials));assert.equal((await f.snapshot('openai-codex')).usage.accountKey,undefined);
});

test('writable ancestors and foreign ownership withhold proof without exposing file contents',async t=>{
 const f=await fixture(t);await f.link();await chmod(f.root,0o777);
 assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);await chmod(f.root,0o700);
 const original=fs.lstatSync;
 for(const path of [f.dir,f.target,join(f.dir,'auth.json')]) {
  fs.lstatSync=(name,...args)=>{const stat=original(name,...args);if(name===path)stat.uid=process.getuid()+1;return stat;};syncBuiltinESMExports();
  try {assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);assert.equal((await f.snapshot('openai-codex')).usage.accountKey,undefined);}finally{fs.lstatSync=original;syncBuiltinESMExports();}
 }
});

test('ambiguous dot paths, trailing-slash agent aliases and file targets cannot select a different directory',async t=>{
 const f=await fixture(t);await f.link();await symlink(f.dir,join(f.root,'alias'));
 for(const dir of [f.dir+'/./',f.dir+'/../agent',join(f.root,'alias')+'/']) {
  process.env.PI_CODING_AGENT_DIR=dir;assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);
 }
 process.env.PI_CODING_AGENT_DIR=f.dir;await rm(join(f.dir,'auth.json'));await symlink(f.target+'/',join(f.dir,'auth.json'));
 assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);
});

test('file or link replacement at open/read fails closed and always closes the opened descriptor',async t=>{
 const f=await fixture(t);await f.link();
 for(const stage of ['openSync','readSync']){
  const original=fs[stage],originalClose=fs.closeSync;let changed=false,opened=0,closed=0;const originalOpen=fs.openSync;
  fs.openSync=(path,...args)=>{const fd=originalOpen(path,...args);if(path===f.target){opened++;if(stage==='openSync'&&!changed){changed=true;fs.unlinkSync(join(f.dir,'auth.json'));fs.symlinkSync(f.target,join(f.dir,'auth.json'));}}return fd;};
  if(stage==='readSync')fs.readSync=(...args)=>{const result=original(...args);if(!changed){changed=true;fs.unlinkSync(f.target);fs.writeFileSync(f.target,JSON.stringify(f.credentials),{mode:0o600});}return result;};
  fs.closeSync=(fd)=>{closed++;return originalClose(fd);};syncBuiltinESMExports();
  try{assert.equal((await f.snapshot('openai')).usage.nativeRegistrationKey,undefined);assert.ok(changed);assert.equal(opened,closed);}finally{fs.openSync=originalOpen;fs.readSync=stage==='readSync'?original:fs.readSync;fs.closeSync=originalClose;syncBuiltinESMExports();}
 }
});
