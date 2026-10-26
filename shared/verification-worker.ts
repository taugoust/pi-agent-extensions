import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { privateEvidenceDirectory } from "./readonly-job-ancestry.ts";
import { parseTuiWorkerPlacement, parseTuiWorkerRequest, type TuiWorkerManifest } from "./tui-worker-protocol.ts";

/** Background-job remains standalone: verification manifest discovery depends
 * only on shared protocol/file boundaries, never the subagent extension runtime. */
export function readNativeVerificationManifest(path: string): TuiWorkerManifest {
  const file = resolve(path), directory = privateEvidenceDirectory(dirname(file));
  if (file !== join(directory, "manifest.json")) throw new Error("Invalid verification manifest filename");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const before = fstatSync(fd), maximum = 256 * 1024;
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || (before.mode & 0o077)
      || process.getuid && before.uid !== process.getuid()) throw new Error("Unsafe verification manifest");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Verification manifest changed during bounded read");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { closeSync(fd); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid verification worker manifest");
  const m = value as TuiWorkerManifest;
  parseTuiWorkerRequest({ protocol: m.protocol, requestId: "verification-manifest", token: m.controlToken,
    ownerSessionId: m.ownerSessionId, taskId: m.taskId, runtimeId: m.runtimeId, groupId: m.groupId,
    childId: m.childId, attempt: m.attempt, workerEpoch: m.workerEpoch, operation: "status" });
  if (m.execution !== undefined && m.execution !== "tmux" || !["background", "foreground-staged"].includes(m.presentation)
    || !m.placement || m.sessionFile !== join(directory, "session.jsonl") || m.controlSocket !== join(directory, "control.sock")
    || Buffer.byteLength(m.controlSocket) > 100 || m.launchMode !== undefined && !["none", "guard-only"].includes(m.launchMode)
    || m.operatorCapabilityHash !== undefined && !/^[a-f0-9]{64}$/.test(m.operatorCapabilityHash)) throw new Error("Invalid native verification worker identity");
  parseTuiWorkerPlacement(m.placement);
  if (m.foregroundOwner !== undefined && (!Number.isSafeInteger(m.foregroundOwner.pid) || m.foregroundOwner.pid < 1
    || typeof m.foregroundOwner.token !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.foregroundOwner.token))) throw new Error("Invalid foreground worker owner");
  if ((m.panePid === undefined) !== (m.paneProcessToken === undefined)
    || m.panePid !== undefined && (!Number.isSafeInteger(m.panePid) || m.panePid < 1)
    || m.paneProcessToken !== undefined && (typeof m.paneProcessToken !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.paneProcessToken))) throw new Error("Invalid verification pane process identity");
  return structuredClone(m);
}
