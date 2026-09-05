import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { writeTaskOutcome } from './outcome.js';
const file=process.env.PI_SUBAGENT_OUTCOME_PATH;
delete process.env.PI_SUBAGENT_OUTCOME_PATH;
export default function taskOutcomeTool(pi:ExtensionAPI){
 if(!file||!process.env.PI_SUBAGENT_ID)return;
 pi.registerTool({name:'task_outcome',label:'Report task outcome',
  description:'Report task delivery independently of process exit. Use delivered only with evidence for every acceptance criterion and no remaining work. Otherwise report partial, blocked, or checkpointed and a concrete next action. This is model-reported evidence, not independent verification. Call before returning or a context-limit handoff.',
  parameters:Type.Object({version:Type.Literal(1),state:Type.String({pattern:'^(delivered|partial|blocked|checkpointed)$'}),summary:Type.String({maxLength:2000}),
   acceptance:Type.Array(Type.Object({criterion:Type.String({maxLength:500}),status:Type.String({pattern:'^(passed|failed|not_run)$'}),evidence:Type.Optional(Type.String({maxLength:1000}))}),{maxItems:16}),
   artifacts:Type.Array(Type.Object({path:Type.String({maxLength:4096}),sha256:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'}))}),{maxItems:16}),
   remaining:Type.Array(Type.String({maxLength:500}),{maxItems:16}),next_action:Type.Optional(Type.String({maxLength:2000}))}),
  async execute(_id,params){const result=writeTaskOutcome(file,params);return {content:[{type:'text' as const,text:`Recorded model-reported task outcome: ${result.state}. Execution and independent acceptance remain separate.`}],details:{task_outcome:result.state}};}
 });
}
