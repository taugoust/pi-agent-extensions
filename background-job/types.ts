import type { PaneIdentity } from './external-pane.js';

export const JOB_SCHEMA_VERSION = 1 as const;
export const JOB_ID_PATTERN = /^job-[0-9a-f]{24}$/;

export type JobStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"
  | "unavailable";

export type JobMetadata = {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  id: string;
  name?: string;
  command: string;
  cwd: string;
  shell: string;
  createdAt: string;
  ownerPid: number;
  ownerToken?: string;
  pane?: PaneIdentity;
  sessionId?: string;
  childId?: string;
  infrastructure?: boolean;
  observed?: { pid: number; startToken: string; logPath: string; logDevice: number; logInode: number };
};

export type JobLaunch = {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  windowId: string;
  paneId: string;
  panePid: number;
  paneStartToken: string;
  launchedAt: string;
};

export type JobProcess = {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  pid: number;
  startToken: string;
  startedAt: string;
};

export type JobResult = {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  status: "completed" | "failed" | "cancelled" | "lost";
  exitCode: number | null;
  signal?: string;
  finishedAt: string;
  reason?: string;
};

export type JobRecord = {
  metadata: JobMetadata;
  launch?: JobLaunch;
  result?: JobResult;
  status: JobStatus;
  observationError?: string;
};

export type OutputSnapshot = {
  text: string;
  truncated: boolean;
  source: "log" | "pane" | "none";
};
