import { Type } from "@sinclair/typebox";

export const JOB_BROKER_KEY = "__paeParentJobBrokerV1";
export const JOB_REQUEST_TITLE = "pi-parent-background-job-v1";
export type JobParams = {
  action: "start" | "adopt" | "list" | "status" | "output" | "wait" | "signal" | "cancel";
  command?: string; name?: string; job_id?: string; timeout_ms?: number; lines?: number; limit?: number;
  signal?: "SIGINT" | "SIGTERM"; pid?: number; log_path?: string;
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
  action: Type.String({ pattern: "^(start|adopt|list|status|output|wait|signal|cancel)$" }),
  command: Type.Optional(Type.String({ description: "Shell command for start." })),
  name: Type.Optional(Type.String({ maxLength: 80 })),
  job_id: Type.Optional(Type.String({ pattern: "^job-[0-9a-f]{24}$" })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  signal: Type.Optional(Type.String({ pattern: "^(SIGINT|SIGTERM)$" })),
  pid: Type.Optional(Type.Integer({ minimum: 1, description: "Existing process to observe (adopt only; no control authority is acquired)." })),
  log_path: Type.Optional(Type.String({ description: "Existing output log for read-only adoption." })),
});
export function validateJobParams(p: JobParams): void {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Invalid background job parameters");
  const allowed: Record<string,string[]> = {
    start:["command","name"], adopt:["pid","log_path","name"], list:["limit"], status:["job_id"],
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
  if (p.action==="adopt" && (!p.pid || typeof p.log_path!=="string" || !p.log_path || Buffer.byteLength(p.log_path)>4096)) throw new Error("adopt requires pid and log_path");
}
