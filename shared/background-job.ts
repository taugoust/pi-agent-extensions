import { Type } from "@sinclair/typebox";

export const JOB_BROKER_KEY = "__paeParentJobBrokerV1";
export const JOB_REQUEST_TITLE = "pi-parent-background-job-v1";
export type JobParams = {
  action: "start" | "adopt" | "list" | "status" | "output" | "wait" | "signal" | "cancel" | "watch" | "watches" | "events" | "ack" | "unwatch";
  command?: string; name?: string; job_id?: string; timeout_ms?: number; lines?: number; limit?: number;
  signal?: "SIGINT" | "SIGTERM"; pid?: number; log_path?: string;
  pane_id?: string; tmux_socket?: string;
  watch_id?: string; patterns?: Array<{name:string;match:string}>; from?: "start"|"end"; poll_ms?: number;
  watch_timeout_ms?: number; after_sequence?: number; through_sequence?: number;
};
export type ParentJobIdentity = { sessionId: string; childId: string; cwd: string };
export type ParentJobBroker = {
  protocol: 1; sessionId: string;
  execute(identity: ParentJobIdentity, callId: string, params: JobParams, signal?: AbortSignal,
    authorize?: (command: string, cwd: string) => Promise<void>): Promise<any>;
};
export function parentJobBroker(sessionId: string): ParentJobBroker | undefined {
  const broker = (globalThis as any)[JOB_BROKER_KEY] as ParentJobBroker | undefined;
  return broker?.protocol === 1 && broker.sessionId === sessionId ? broker : undefined;
}
export const JobParameters = Type.Object({
  action: Type.String({ pattern: "^(start|adopt|list|status|output|wait|signal|cancel|watch|watches|events|ack|unwatch)$" }),
  command: Type.Optional(Type.String({ description: "Shell command for start." })),
  name: Type.Optional(Type.String({ maxLength: 80 })),
  job_id: Type.Optional(Type.String({ pattern: "^job-[0-9a-f]{24}$" })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  signal: Type.Optional(Type.String({ pattern: "^(SIGINT|SIGTERM)$" })),
  pid: Type.Optional(Type.Integer({ minimum: 1, description: "Existing process to observe (adopt only; no control authority is acquired)." })),
  pane_id: Type.Optional(Type.String({pattern:"^%[0-9]+$",description:"adopt only: exact existing tmux pane ID. No input or restart is sent."})),
  tmux_socket: Type.Optional(Type.String({maxLength:4096,description:"adopt pane: explicit tmux socket; defaults to the current/default tmux server."})),
  log_path: Type.Optional(Type.String({ description: "Existing output log for read-only adoption or a persistent watch." })),
  watch_id: Type.Optional(Type.String({ pattern: "^watch-[0-9a-f]{24}$" })),
  patterns: Type.Optional(Type.Array(Type.Object({ name: Type.String({maxLength:64}), match: Type.String({maxLength:256}) }), {minItems:1,maxItems:16})),
  from: Type.Optional(Type.String({pattern:"^(start|end)$"})),
  poll_ms: Type.Optional(Type.Integer({minimum:250,maximum:60000})),
  watch_timeout_ms: Type.Optional(Type.Integer({minimum:1000,maximum:604800000})),
  after_sequence: Type.Optional(Type.Integer({minimum:0})),
  through_sequence: Type.Optional(Type.Integer({minimum:0})),
});
export function validateJobParams(p: JobParams): void {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Invalid background job parameters");
  const allowed: Record<string,string[]> = {
    start:["command","name"], adopt:["pid","log_path","name","pane_id","tmux_socket"], list:["limit"], status:["job_id"],
    watch:["log_path","patterns","from","poll_ms","watch_timeout_ms","job_id"], watches:[], events:["watch_id","after_sequence"], ack:["watch_id","through_sequence"], unwatch:["watch_id"],
    output:["job_id","lines"], wait:["job_id","timeout_ms","lines"], signal:["job_id","signal"], cancel:["job_id"],
  };
  if (!allowed[p.action]) throw new Error("Unknown background job action");
  for (const k of Object.keys(p)) if (k!=="action" && !allowed[p.action].includes(k)) throw new Error(`${p.action} does not accept ${k}`);
  for (const [k,min,max] of [["timeout_ms",0,30000],["lines",1,2000],["limit",1,50],["pid",1,Number.MAX_SAFE_INTEGER]] as const) {
    if (p[k]!==undefined && (!Number.isSafeInteger(p[k]) || p[k]!<min || p[k]!>max)) throw new Error(`Invalid ${k}`);
  }
  if (["status","output","wait","signal","cancel"].includes(p.action) && !/^job-[0-9a-f]{24}$/.test(p.job_id??"")) throw new Error("A valid job_id is required");
  if (p.action==="start" && (typeof p.command!=="string" || !p.command.trim() || Buffer.byteLength(p.command)>32768)) throw new Error("start requires a bounded command");
  if (p.name!==undefined && (typeof p.name!=="string" || !p.name.trim() || Buffer.byteLength(p.name)>80)) throw new Error("Invalid name");
  if (p.action==="signal" && !["SIGINT","SIGTERM"].includes(p.signal??"")) throw new Error("signal requires SIGINT or SIGTERM");
  if (["events","ack","unwatch"].includes(p.action) && !/^watch-[0-9a-f]{24}$/.test(p.watch_id??"")) throw new Error("A valid watch_id is required");
  for (const k of ["after_sequence","through_sequence"] as const) if(p[k]!==undefined&&(!Number.isSafeInteger(p[k])||p[k]!<0))throw new Error(`Invalid ${k}`);
  if(p.action==='ack'&&p.through_sequence===undefined)throw new Error('ack requires through_sequence');
  if(p.action==='watch'&&typeof p.log_path!=='string'&&!/^job-[0-9a-f]{24}$/.test(p.job_id??''))throw new Error('watch requires log_path or an owned job_id');
  if (p.action==="adopt") {
    if(p.pane_id!==undefined){
      if(typeof p.pane_id!=="string"||!/^%[0-9]+$/.test(p.pane_id)||p.pid!==undefined)throw new Error('Pane adoption requires pane_id, not pid');
      if(p.tmux_socket!==undefined&&(typeof p.tmux_socket!=='string'||!p.tmux_socket||Buffer.byteLength(p.tmux_socket)>4096))throw new Error('Invalid tmux_socket');
      if(p.log_path!==undefined&&(typeof p.log_path!=='string'||!p.log_path||Buffer.byteLength(p.log_path)>4096))throw new Error('Invalid log_path');
    } else {
      if(p.tmux_socket!==undefined||!p.pid||typeof p.log_path!=="string"||!p.log_path||Buffer.byteLength(p.log_path)>4096)throw new Error('adopt requires pid and log_path, or pane_id with optional tmux_socket');
    }
  }
}
