import test from "node:test";
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piEntry=process.env.PI_CODING_AGENT_ENTRY?pathToFileURL(process.env.PI_CODING_AGENT_ENTRY).href:import.meta.resolve("@earendil-works/pi-coding-agent");
const pkg=findPackageJSON("@earendil-works/pi-mcp",fileURLToPath(piEntry));
const manifest=JSON.parse(await readFile(pkg,"utf8"));
const pkgRoot=dirname(pkg);
const sdk=await import(pathToFileURL(resolve(pkgRoot,manifest.exports["."].import)).href);
const testing=await import(pathToFileURL(resolve(pkgRoot,manifest.exports["./testing"].import)).href);

test("standalone public MCP client initializes, lists and calls through in-memory transport",async()=>{
 const {client:clientTransport,server}=testing.createInMemoryTransportPair();
 const client=new sdk.McpClient({name:"forge-watch-test",version:"1"});
 server.onMessage(message=>{
  if(message.method==="initialize") void server.send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}});
  else if(message.method==="tools/list") void server.send({jsonrpc:"2.0",id:message.id,result:{tools:[{name:"pull_request_read",inputSchema:{type:"object",properties:{method:{enum:["get"]}}}}]}});
  else if(message.method==="tools/call") void server.send({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:JSON.stringify({head:"abc"})}]}});
 });
 await server.start();
 await client.connect(clientTransport);
 assert.equal((await client.listTools())[0].name,"pull_request_read");
 const result=await client.callTool("pull_request_read",{method:"get"});
 assert.notEqual(result.isError,true);
 assert.match(result.content[0].text,/head/);
 await client.close();await server.close();
});
