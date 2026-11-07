import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const packageRoot=process.env.PI_MCP_PACKAGE_ROOT;
if(packageRoot){const manifest=JSON.parse(await readFile(join(packageRoot,"package.json"),"utf8"));registerHooks({resolve(specifier,context,nextResolve){const sub=specifier==="@earendil-works/pi-mcp"?".":specifier.startsWith("@earendil-works/pi-mcp/")?specifier.slice("@earendil-works/pi-mcp/".length):undefined;const entry=sub?manifest.exports[sub==="."?".":`./${sub}`]?.import:undefined;return entry?nextResolve(pathToFileURL(join(packageRoot,entry)).href,context):nextResolve(specifier,context);}});}
const sdk=await import("@earendil-works/pi-mcp");
const testing=await import("@earendil-works/pi-mcp/testing");
const {createForgeMcpClient,ForgeError}=await import("./mcp.ts");

test("forge MCP wrapper initializes/calls on in-memory public protocol and rejects unsafe methods",async()=>{
 const {client:clientTransport,server}=testing.createInMemoryTransportPair();
 server.onMessage(message=>{
  if(message.method==="initialize")void server.send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}});
  else if(message.method==="tools/list")void server.send({jsonrpc:"2.0",id:message.id,result:{tools:[{name:"pull_request_read",inputSchema:{type:"object",properties:{method:{enum:["get","get_comments","get_review_comments","get_reviews","get_status","get_check_runs","get_diff"]}}}}]}});
  else if(message.method==="tools/call")void server.send({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:JSON.stringify({head:"abc"})}]}});
 });
 await server.start();
 const target={provider:"github",host:"github.com",project:"owner/repo",number:1,url:"https://github.com/owner/repo/pull/1"};
 const config={requestTimeoutMs:1000,servers:[{provider:"github",host:"github.com",url:"https://api.githubcopilot.com/mcp/readonly"}]};
 const forge=createForgeMcpClient(config,target,{createClient:()=>new sdk.McpClient({name:"test",version:"1"}),createTransport:()=>clientTransport});
 assert.equal((await forge.call("pull_request_read",{method:"get"})).content[0].text,'{"head":"abc"}');
 await assert.rejects(forge.call("pull_request_read",{method:"get_diff"}),/allowlist/);
 await forge.close();await server.close();
});

test("client retries failed initialization and preserves known rate-limit metadata",async()=>{
 const target={provider:"github",host:"github.com",project:"owner/repo",number:1,url:"https://github.com/owner/repo/pull/1"};
 const config={requestTimeoutMs:1000,servers:[{provider:"github",host:"github.com",url:"https://api.githubcopilot.com/mcp/readonly"}]};
 let connections=0;
 const forge=createForgeMcpClient(config,target,{createClient:()=>({async connect(){if(++connections===1)throw Object.assign(new Error("network"),{statusCode:503});},async listTools(){return [{name:"pull_request_read",inputSchema:{type:"object",properties:{method:{enum:["get","get_comments","get_review_comments","get_reviews","get_status","get_check_runs"]}}}}];},async callTool(){const error=new Error("rate limit");error.statusCode=429;error.headers=new Headers({"retry-after":"3"});throw error;},async close(){}}),createTransport:()=>({})});
 await assert.rejects(forge.call("pull_request_read",{method:"get"}),e=>e instanceof ForgeError&&e.status===503);
 await assert.rejects(forge.call("pull_request_read",{method:"get"}),e=>e instanceof ForgeError&&e.status===429&&e.retryAfterMs===3000);
 await forge.close();
});
