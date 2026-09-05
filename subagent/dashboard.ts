import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { taskChoice, remoteTaskUiConnected, taskLabel, taskListText, uiText, jobStatusLabel } from '../shared/task-presentation.js';
import { watchMenu } from '../shared/watch-menu.js';

type DashboardServices = {
  list(ctx:ExtensionCommandContext):Promise<any[]>;
  record(ctx:ExtensionCommandContext,id:string):Promise<any>;
  report(ctx:ExtensionCommandContext,id:string):Promise<string>;
  resume(ctx:ExtensionCommandContext,id:string):Promise<any>;
  jobs(ctx:ExtensionCommandContext,id:string,params:any):Promise<any>;
};

export function readableTaskReport(text:string):string {
  return text.split('\n').map(line=>{
    if(line.startsWith('Task outcome (')) {
      const start=line.indexOf('{');
      try {
        const value=JSON.parse(line.slice(start));
        return [`Task outcome: ${value.state} (reported, not independently verified)`,uiText(value.summary,2000),
          ...(value.acceptance??[]).map((a:any)=>`• ${a.status}: ${uiText(a.criterion,500)}${a.evidence?` — ${uiText(a.evidence,1000)}`:''}`),
          ...(value.remaining??[]).map((item:string)=>`Remaining: ${uiText(item,500)}`),
          ...(value.next_action?[`Next: ${uiText(value.next_action,2000)}`]:[]),
          ...(value.artifacts??[]).map((a:any)=>`Artifact: ${uiText(a.path,4096)}${a.sha256?` (${a.sha256})`:''}`),
        ].join('\n');
      } catch {return line;}
    }
    if(line.startsWith('RPC diagnostics: ')) {
      try {const d=JSON.parse(line.slice('RPC diagnostics: '.length));return `Process exit: ${d.rawExit?.code??d.rawExit?.signal??'unknown'} · detailed trace retained in the result artifact`;}catch{}
    }
    return line;
  }).join('\n');
}

/** Human task controls use existing selectors, mirrored to Paseo when attached. */
export function registerTaskDashboard(pi:ExtensionAPI, services:DashboardServices):void {
  let open=false;
  const show=async(ctx:ExtensionCommandContext,title:string,body:string)=>{
    const content=uiText(body,24000);
    if(ctx.mode==='tui'&&!remoteTaskUiConnected()) {await ctx.ui.editor(`${title} — view only; edits are not saved`,content);return;}
    pi.sendMessage({customType:'task-dashboard-view',content:`${title}\n\n${content}`,display:true},{deliverAs:'steer',triggerTurn:false});
  };
  const alerts=async(ctx:ExtensionCommandContext,id:string)=>watchMenu(ctx,params=>services.jobs(ctx,id,params),(title,body)=>show(ctx,title,body));
  const builds=async(ctx:ExtensionCommandContext,id:string)=>{
    const result=await services.jobs(ctx,id,{action:'list',limit:50});
    const jobs=result.details?.jobs??[];
    if(!jobs.length){await show(ctx,'Task builds','No registered background jobs for this task.');return;}
    const labels=jobs.map((j:any,i:number)=>`${i+1}. ${jobStatusLabel(j.status,j.observation_only)} · ${uiText(j.name||'Build',90)}`);
    const selected=await taskChoice(ctx,'Task builds — select to open output',labels);
    const index=labels.indexOf(selected);if(index<0)return;
    const output=await services.jobs(ctx,id,{action:'output',job_id:jobs[index].job_id,lines:250});
    await show(ctx,labels[index],output.content?.[0]?.text??'(no output)');
  };
  pi.registerCommand('tasks',{
    description:'Task dashboard: outcomes, reports, resume, build output, and alerts',
    handler:async(args,ctx)=>{
      if(!ctx.hasUI)return;
      if(open){ctx.ui.notify('The task dashboard is already open.','warning');return;}
      open=true;
      try {
        const tasks=await services.list(ctx);
        if(!tasks.length){await show(ctx,'Tasks','No retained tasks in this session yet. Newly launched native tasks will appear here.');return;}
        let selectedTask:any;
        if(args.trim()) {
          if(!/^subagent-task-[0-9a-f]{24}$/.test(args.trim()))throw new Error('Use /tasks, or /tasks followed by an exact task ID.');
          selectedTask=tasks.find(t=>t.task_id===args.trim());
          if(!selectedTask)throw new Error('Task is not in this session’s recent task list.');
        } else {
          const labels=tasks.map((t:any,i:number)=>`${i+1}. ${taskLabel(t)} · ${uiText(t.title,90)} · attempt ${t.attempt}`);
          const selected=await taskChoice(ctx,'Tasks — choose work, not a worker ID',labels);
          selectedTask=tasks[labels.indexOf(selected)];
        }
        if(!selectedTask)return;
        let id=selectedTask.task_id;
        for(;;){
          const current=(await services.list(ctx)).find(t=>t.task_id===id)??selectedTask;
          const actions=['View task report','Open build output','Review alerts',...(current.can_resume&&current.outcome!=='delivered'?['Resume saved task']:[]),'Refresh','Choose another task','Technical details','Close'];
          const action=await taskChoice(ctx,taskListText([current],false),actions);
          if(!action||action==='Close')return;
          if(action==='Refresh')continue;
          if(action==='Choose another task'){
            const latest=await services.list(ctx);
            const labels=latest.map((t:any,i:number)=>`${i+1}. ${taskLabel(t)} · ${uiText(t.title,90)} · attempt ${t.attempt}`);
            const selected=await taskChoice(ctx,'Tasks',labels);
            const next=latest[labels.indexOf(selected)];
            if(next){selectedTask=next;id=next.task_id;}
            continue;
          }
          if(action==='View task report')await show(ctx,uiText(current.title,100),readableTaskReport(await services.report(ctx,id)));
          else if(action==='Open build output')await builds(ctx,id);
          else if(action==='Review alerts')await alerts(ctx,id);
          else if(action==='Technical details'){
            const record=await services.record(ctx,id);
            await show(ctx,'Task details',[`Task: ${id}`,`Worker: ${record.childId}`,`Attempt: ${record.attempt}`,`Workspace: ${record.spec.cwd}`,`Compaction before resume: ${record.requiresCompaction?'required':'not required'}`,...record.history.map((h:any)=>`Attempt ${h.attempt}: ${h.outcome??'unreported'} · ${h.finishedAt}`),`\nAssignment:\n${uiText(record.spec.task,6000)}`,...(record.spec.acceptance??[]).map((criterion:string)=>`Acceptance: ${uiText(criterion,500)}`)].join('\n'));
          } else if(action==='Resume saved task'){
            if(!ctx.isIdle()){await show(ctx,'Cannot resume yet','The parent is busy. Wait until it is idle; existing work has not been interrupted.');continue;}
            const decision=await taskChoice(ctx,`Resume ${uiText(current.title,100)}?\n${uiText(current.next_action||'Continue the saved task',300)}`,['Resume saved task','Back']);
            if(decision!=='Resume saved task')continue;
            await services.resume(ctx,id);
            await show(ctx,'Task resumed','A new attempt is running with the saved conversation and existing task-owned jobs. No build was relaunched by the dashboard.');
          }
        }
      } catch(error){await show(ctx,'Task action unavailable',uiText(error instanceof Error?error.message:error,2000));}
      finally {open=false;}
    }
  });
}
