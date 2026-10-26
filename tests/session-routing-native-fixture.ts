// Offline fixture extension for native multi-process routing regression.
import accounts from "../openai-accounts/accounts.js";
import { registerGuard } from "../idle-context-warning/guard.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../openai-accounts/account-store.js";
import * as oauth from "../openai-accounts/oauth.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ACCOUNT_CONTROLS_KEY } from "../shared/account-controls.js";
import { appendFile } from "node:fs/promises";

const token = (id: string) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({sub:id,"https://api.openai.com/auth":{chatgpt_account_id:id}})).toString("base64url")}.fixture`;
export default async function fixture(pi: any) {
  const role = process.env.ROUTING_FIXTURE_ROLE!;
  const log = process.env.ROUTING_FIXTURE_LOG!;
  globalThis.fetch = (async () => { await appendFile(log,JSON.stringify({role,network:"blocked"})+"\n"); throw new Error("HTTP_FORBIDDEN_NATIVE_FIXTURE"); }) as any;
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const personal = token("personal"), work = token("work");
  await store.updateProvider("openai", state => ({...state,active:"Alpha",accounts:{Alpha:{type:"api_key",key:"fixture-alpha"}}}));
  await store.updateProvider("openai-codex", state => ({...state,accounts:{Work:{type:"oauth",access:work,refresh:"fixture-work-refresh",expires:Date.now()+86400000,accountId:"work"}}}));
  pi.registerProvider("openai", provider("openai", log));
  pi.registerProvider("openai-codex", provider("openai-codex", log));
  accounts(pi,{store,providers:oauth.createBuiltinProviderAdapters()});
  if (role === "parent") registerGuard(pi,()=>({idleMinutes:30,contextPercent:20,guardedModels:{astra:"openai/main-fixture"}}),{tombstonePath:process.env.PI_CODING_AGENT_DIR+"/aliases.json"});
  pi.registerCommand("routing-switch",{handler:async(args:string,ctx:any)=>{const [providerId,accountId]=args.split(/\s+/,2);const service=(globalThis as any)[ACCOUNT_CONTROLS_KEY];try{await appendFile(log,JSON.stringify({role:"control-start",providerId,accountId})+"\n");const snapshot=await service.getSnapshot({sessionId:ctx.sessionManager.getSessionId(),providerId});await appendFile(log,JSON.stringify({role:"snapshot",providerId,snapshot:{sessionId:snapshot.sessionId,serviceEpoch:snapshot.serviceEpoch,selectionRevision:snapshot.selectionRevision,sessionRouting:snapshot.sessionRouting,currentAccountId:snapshot.currentAccountId,activationStatus:snapshot.activationStatus}})+"\n");const result=await service.switchAccount({protocol:1,providerId,requestId:crypto.randomUUID(),expectedSessionId:snapshot.sessionId,expectedServiceEpoch:snapshot.serviceEpoch,expectedSelectionRevision:snapshot.selectionRevision,expectedRoutingRevision:snapshot.sessionRouting?.revision,accountId:accountId==="default"||accountId==="inherit"?null:accountId,...(accountId==="inherit"?{inherit:true}:{})});await appendFile(log,JSON.stringify({role:"control",providerId,accountId,result})+"\n");ctx.ui.notify(`switch:${result.ok}:${result.reason??"ok"}`);}catch(error){await appendFile(log,JSON.stringify({role:"control-error",error:String(error)})+"\n");throw error;}}});
  pi.registerCommand("routing-restore", { handler: async (args: string, ctx: any) => { const result = await ctx.navigateTree(args.trim(), { summarize: false }); await appendFile(log, JSON.stringify({ role: "history", source: role, cancelled: result.cancelled }) + "\n"); ctx.ui.notify(`history:${result.cancelled ? "cancelled" : "restored"}`); } });
  pi.registerCommand("routing-dispatch",{handler:async(_args:string,ctx:any)=>{await pi.sendUserMessage("offline fixture dispatch");}});
}
function provider(id:string, log:string) {
  return { api:id === "openai" ? "openai-responses" : "openai-codex-responses", baseUrl:id === "openai"?"https://api.openai.com/v1":"https://chatgpt.com/backend-api", models:["main-fixture","small-fixture"].map(model=>({id:model,name:model,reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})), streamSimple(model:any,_context:any,options:any={}) {
    const stream=createAssistantMessageEventStream(); queueMicrotask(async()=>{ try { await options.onPayload?.({fixture:true},model); await appendFile(log,JSON.stringify({role:process.env.ROUTING_FIXTURE_ROLE,provider:id,model:model.id,key:options.apiKey})+"\n"); const message={role:"assistant",provider:id,api:model.api,model:model.id,content:[{type:"text",text:"offline"}],stopReason:"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}; stream.push({type:"done",reason:"stop",message});stream.end(); }catch(e){stream.push({type:"error",reason:"error",error:{role:"assistant",provider:id,api:model.api,model:model.id,content:[],stopReason:"error",errorMessage:String(e),timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});stream.end();} }); return stream;
  }};
}
