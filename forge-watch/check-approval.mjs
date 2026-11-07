#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseTarget } from "./types.ts";
import { checkApproval } from "./approval.ts";

const args=process.argv.slice(2), options={};
for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(!["--url","--reviewer","--head","--config"].includes(key)||!args[i+1]||args[i+1].startsWith("--")) {
    console.log(JSON.stringify({approved:false,reason:"usage: check-approval.mjs --url URL --reviewer LOGIN --head SHA --config FILE"}));process.exit(2);
  }
  options[key.slice(2)]=args[++i];
}
try {
  if(!options.url||!options.reviewer||!options.head||!options.config)throw new Error("all options are required");
  const config=JSON.parse(await readFile(options.config,"utf8"));
  const target=parseTarget(options.url,config.servers?.map(s=>s.host)??[]);
  const result=await checkApproval({target,reviewer:options.reviewer,expectedHead:options.head,config});
  console.log(JSON.stringify(result));process.exitCode=result.approved?0:1;
} catch(error) {
  console.log(JSON.stringify({approved:false,reason:error instanceof Error?error.message:"configuration or approval check failed"}));process.exitCode=1;
}
