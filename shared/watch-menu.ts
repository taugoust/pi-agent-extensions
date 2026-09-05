import { taskChoice, uiText, watchResultText } from './task-presentation.js';

export async function watchMenu(ctx:any, execute:(params:any)=>Promise<any>, show:(title:string,body:string)=>Promise<void>):Promise<void>{
  for(;;){
    const result=await execute({action:'watches'});const watches=result.details?.watches??[];
    if(!watches.length){await show('Alerts','No watches in this scope.');return;}
    const labels=watches.map((w:any,i:number)=>`${i+1}. ${w.status==='running'?'Watching':uiText(w.status)} · ${uiText(w.label||w.log_path,90)}`);
    const selected=await taskChoice(ctx,'Alerts — stopping a watch never stops its build',labels);
    const index=labels.indexOf(selected);if(index<0)return;
    const watch=watches[index];let displayedThrough:number|undefined;
    for(;;){
      const actions=['View unread alerts',...(displayedThrough!==undefined?[`Acknowledge displayed alerts through #${displayedThrough}`]:[]),...(watch.status==='running'?['Stop watching — keep build running']:[]),'Back'];
      const action=await taskChoice(ctx,uiText(watch.label||watch.log_path,140),actions);
      if(!action||action==='Back')break;
      if(action==='View unread alerts'){
        const page=await execute({action:'events',watch_id:watch.watch_id});
        await show('Alerts',watchResultText('events',page.details));
        displayedThrough=page.details.events?.length?page.details.next_sequence:undefined;
      }else if(action.startsWith('Acknowledge')&&displayedThrough!==undefined){
        await execute({action:'ack',watch_id:watch.watch_id,through_sequence:displayedThrough});displayedThrough=undefined;
        await show('Alerts acknowledged','Only the displayed range was acknowledged. Newer alerts remain unread.');
      }else if(action.startsWith('Stop watching')){
        const confirm=await taskChoice(ctx,'Stop this watch? The build will continue unchanged.',['Stop watching','Keep watching']);
        if(confirm==='Stop watching'){
          await execute({action:'unwatch',watch_id:watch.watch_id});
          await show('Watch stopping','The build is still running. No cancellation was sent.');break;
        }
      }
    }
  }
}
