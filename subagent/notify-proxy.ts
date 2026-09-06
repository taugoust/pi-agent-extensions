import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

export default function parentNotifications(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'notify_parent', label: 'Notify supervisor',
    description: 'Send a concise discovery or blocker to the parent without ending your task. Set requires_guidance=true when a parent decision is needed. Acceptance means queued, not read or answered. This does not wait for a reply; continue independent work, avoid repeating updates, and do not take an action that depends on guidance before receiving it.',
    parameters: Type.Object({
      message: Type.String({minLength:1,maxLength:1000,description:'Concise finding, implication, and any specific question. Maximum 2000 UTF-8 bytes; do not paste reports or logs.'}),
      requires_guidance: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId, params, signal, _update, ctx) {
      if(ctx.mode!=='rpc'||!process.env.PI_SUBAGENT_ID)throw new Error('notify_parent is available only to native RPC children');
      if(signal?.aborted)throw new Error('Notification cancelled before dispatch');
      const response=await ctx.ui.input('pi-parent-notification-v1',JSON.stringify({toolCallId,params}),{signal});
      if(!response)throw new Error('Parent notification unavailable or cancelled');
      const result=JSON.parse(response);
      if(result.error)throw new Error(String(result.error));
      if(!Array.isArray(result.content))throw new Error('Invalid parent notification response');
      return result;
    },
  });
}
