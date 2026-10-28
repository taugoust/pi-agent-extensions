import assert from 'node:assert/strict';
import { TmuxBackend } from './tmux.js';

// Deterministic schedule: tmux reports alive, then /proc disappears before
// identity lookup. No timing sleeps or real-user processes are involved.
const launch = {socketPath:'/fixture',serverPid:100,serverStartToken:'server',paneId:'%1',windowId:'@1',panePid:200,paneStartToken:'pane',ownershipToken:'owner'};
const snapshot = (dead='0', changes={}) => {
 const v={tag:'job',dead,pid:200,owner:'owner',session:'$1',window:'@1',server:100,start:'pane',...changes};
 return {code:0,stdout:[v.tag,v.dead,v.pid,v.owner,v.session,v.window,v.server,v.start].join('|'),stderr:''};
};
const missing={code:1,stdout:'',stderr:"can't find pane: %1"};
function fixture(second=snapshot('1'), tokenError='ENOENT') {
 const backend=new TmuxBackend({socketPath:'/fixture'},'', '', '');
 let reads=0, serverReads=0;
 backend.run=async()=> ++reads===1?snapshot():second;
 backend.identityToken=async pid=>{
  if(pid===100){serverReads++;return 'server';}
  if(tokenError==='reused')return 'replacement';
  throw Object.assign(new Error('proc unavailable'),{code:tokenError});
 };
 return {backend,counts:()=>[reads,serverReads]};
}
for(const method of ['paneState','inspect']) {
 for(const [second,expected] of [[snapshot('1'),{exists:true,dead:true,panePid:200}],[missing,{exists:false}]]) {
  const f=fixture(second);
  assert.deepEqual(await f.backend[method]('job',launch),expected);
  assert.deepEqual(f.counts(),[2,2]);
 }
 for(const changes of [{pid:201},{owner:'other'},{start:'other'},{window:'@2'},{server:101},{tag:'other'},{session:'invalid'}]) {
  const f=fixture(snapshot('1',changes));
  await assert.rejects(f.backend[method]('job',launch));
 }
 for(const error of ['reused','EACCES','EIO']) {
  const f=fixture(snapshot('1'),error);
  await assert.rejects(f.backend[method]('job',launch));
  assert.equal(f.counts()[0],1,'non-disappearance errors must not reobserve');
 }
 const unavailable=fixture({code:1,stdout:'',stderr:'server unavailable'});
 await assert.rejects(unavailable.backend[method]('job',launch),/Cannot verify missing/);
 const live=fixture(snapshot());
 await assert.rejects(live.backend[method]('job',launch),/unavailable after exit recheck/);
 assert.deepEqual(live.counts(),[2,2],'reobservation is bounded');
 const server=fixture();let calls=0;
 server.backend.identityToken=async pid=>{if(pid===100)return ++calls===1?'server':'replacement';throw Object.assign(new Error('gone'),{code:'ENOENT'});};
 await assert.rejects(server.backend[method]('job',launch),/server identity changed/);
}
console.log('tmux identity exit race: dead/missing accepted; PID/server/ownership replacement and unverifiable live state refused');
