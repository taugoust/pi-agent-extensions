import { spawn } from "node:child_process";
import type { ForgeTarget } from "./types.ts";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import * as publicOAuth from "@earendil-works/pi-mcp/oauth";

export type ForgeServerConfig = { provider:"github"|"gitlab";host:string;url:string;auth?:{command?:string;args?:string[];env?:string;oauthFile?:string};allowedTools?:string[];maxPages?:number };
export type ForgeMcpConfig = {servers:ForgeServerConfig[];requestTimeoutMs?:number};
export class ForgeError extends Error {
 readonly status?:number;readonly retryAfterMs?:number;
 constructor(message:string,status?:number,retryAfterMs?:number){super(message);this.name="ForgeError";this.status=status;this.retryAfterMs=retryAfterMs;}
}
const REQUIRED={github:{pull_request_read:new Set(["get","get_comments","get_review_comments","get_reviews","get_status","get_check_runs"])},gitlab:{get_merge_request:new Set(["get_merge_request"])}};
function credential(auth:ForgeServerConfig["auth"],signal:AbortSignal):Promise<string|undefined>{
 if(!auth)return Promise.resolve(undefined);
 const sources=[auth.command,auth.env,auth.oauthFile].filter(Boolean);
 if(sources.length!==1)throw new ForgeError("Configure exactly one trusted credential source");
 if(auth.env){const token=process.env[auth.env];if(!token)throw new ForgeError(`Credential environment variable ${auth.env} is unset`);return Promise.resolve(token.trim());}
 if(auth.oauthFile)return Promise.resolve(undefined);
 return new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(new ForgeError("Credential command aborted"));
  const child=spawn(auth.command!,auth.args??[],{stdio:["ignore","pipe","ignore"],shell:false,timeout:10_000,env:process.env});
  let output="";const abort=()=>child.kill("SIGTERM");signal.addEventListener("abort",abort,{once:true});
  child.stdout.setEncoding("utf8").on("data",chunk=>{output+=chunk;if(output.length>16_384)child.kill("SIGTERM");});
  child.on("error",()=>reject(new ForgeError("Credential command failed")));
  child.on("close",code=>{signal.removeEventListener("abort",abort);code===0&&output.trim()?resolve(output.trim()):reject(new ForgeError(signal.aborted?"Credential command aborted":"Credential command returned no credential"));});
 });
}
export function createForgeMcpClient(config:ForgeMcpConfig,target:ForgeTarget,dependencies:{createClient?:()=>any;createTransport?: (options:any)=>any}={}){
 const server=config.servers.find(s=>s.provider===target.provider&&s.host.toLowerCase()===target.host.toLowerCase());
 if(!server)throw new ForgeError(`No trusted MCP server configured for ${target.provider} ${target.host}`);
 const endpoint=new URL(server.url);
 if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new ForgeError("MCP URL must be a clean HTTPS endpoint explicitly pinned in configuration");
 const controller=new AbortController();let client:any,ready:Promise<any>|undefined,closed=false;
 const getReady=(signal?:AbortSignal)=>{
  if(closed)throw new ForgeError("MCP client is closed");
  if(signal?.aborted)throw new ForgeError("MCP request aborted");
  if(!ready)ready=connect(signal).catch(error=>{ready=undefined;throw safeError(error);});
  return ready;
 };
 async function connect(signal?:AbortSignal){
  const connectSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  if(server.provider==="gitlab"&&!server.auth?.oauthFile)throw new ForgeError("GitLab requires an explicit OAuth credential file; interactive auth is never started by polling");
  const token=server.provider==="github"?await credential(server.auth,connectSignal):undefined;
  if(connectSignal.aborted)throw new ForgeError("MCP connection aborted");
  client=dependencies.createClient?.()??new McpClient({name:"forge-watch",version:"1.0.0",requestTimeoutMs:config.requestTimeoutMs??15_000});
  let authProvider;
  if(server.provider==="gitlab"){
   const {createGitLabOAuth}=await import("./auth.mjs");
   authProvider=createGitLabOAuth({file:server.auth!.oauthFile,serverUrl:endpoint.toString(),oauth:publicOAuth}).authProvider;
  }
  const transport=dependencies.createTransport?.({url:endpoint.toString(),headers:token?{Authorization:`Bearer ${token}`} :undefined,authProvider})??new StreamableHttpTransport({url:endpoint.toString(),headers:token?{Authorization:`Bearer ${token}`} :undefined,authProvider});
  try{
   await timed(client.connect(transport),config.requestTimeoutMs??15_000,"MCP connection timed out",()=>client?.close());
   const listed=await timed(client.listTools({signal:connectSignal,timeoutMs:config.requestTimeoutMs??15_000}),config.requestTimeoutMs??15_000,"MCP tool listing timed out");
   const mandatory=REQUIRED[target.provider],configured=server.allowedTools?new Set(server.allowedTools):new Set(Object.keys(mandatory)),allowed=new Map();
   for(const [name,methods] of Object.entries(mandatory)){
    const tool=listed.find((item:any)=>item.name===name);if(!configured.has(name)||!tool)continue;
    const enums=tool.inputSchema?.properties?.method?.enum;
    if(!Array.isArray(enums)||[...methods].some(method=>!enums.includes(method)))throw new ForgeError(`MCP tool ${name} lacks required safe method enum`);
    allowed.set(name,methods);
   }
   if(allowed.size!==Object.keys(mandatory).length)throw new ForgeError(`MCP server lacks a required read-only ${target.provider} tool`);
   return {client,allowed,tools:listed};
  }catch(error){await client.close().catch(()=>{});throw safeError(error);}
 }
 return {
  async tools(signal?:AbortSignal){return (await getReady(signal)).tools;},
  async call(name:string,args:Record<string,unknown>,signal?:AbortSignal){
   const state=await getReady(signal);if(closed)throw new ForgeError("MCP client is closed");
   if(!state.allowed.get(name)?.has(String(args.method)))throw new ForgeError("MCP operation is not in the read-only method allowlist");
   try{
    const result=await state.client.callTool(name,args,{signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,timeoutMs:config.requestTimeoutMs??15_000});
    if((result as any).isError)throw new ForgeError("MCP read operation failed");return result;
   }catch(error){throw safeError(error);}
  },
  async close(){if(closed)return;closed=true;controller.abort();if(client)await client.close().catch(()=>{});else if(ready)await ready.catch(()=>{});},
  maxPages:Math.max(1,Math.min(server.maxPages??20,100)),
 };
}
function timed<T>(promise:Promise<T>,ms:number,message:string,onTimeout?:()=>unknown):Promise<T>{
 let timer:ReturnType<typeof setTimeout>;
 return new Promise<T>((resolve,reject)=>{
  timer=setTimeout(()=>{void onTimeout?.();reject(new ForgeError(message));},ms);
  promise.then(resolve,reject).finally(()=>clearTimeout(timer));
 });
}
function safeError(error:any):ForgeError{
 if(error instanceof ForgeError)return error;
 const status=Number.isInteger(error?.statusCode)?error.statusCode:Number.isInteger(error?.status)?error.status:undefined;
 const header=error?.headers?.get?.("retry-after"),retry=Number(header);
 return new ForgeError(status===401?"Forge MCP authentication required":status===429?"Forge MCP rate limited":"Forge MCP request failed",status,Number.isFinite(retry)&&retry>0?retry*1000:undefined);
}
