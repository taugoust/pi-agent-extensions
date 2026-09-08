import net from "node:net";
import { randomBytes } from "node:crypto";
import { TUI_WORKER_MAX_FRAME_BYTES, parseTuiWorkerRequest } from "../shared/tui-worker-protocol.ts";
import type { TuiWorkerManifest, TuiWorkerOperation, TuiWorkerResponse } from "../shared/tui-worker-protocol.ts";

export function workerRequest(manifest: TuiWorkerManifest, operation: TuiWorkerOperation, requestId = randomBytes(16).toString("hex")) {
  return parseTuiWorkerRequest({ protocol: 1, requestId, token: manifest.controlToken,
    ownerSessionId: manifest.ownerSessionId, taskId: manifest.taskId, runtimeId: manifest.runtimeId,
    groupId: manifest.groupId, childId: manifest.childId, attempt: manifest.attempt, workerEpoch: manifest.workerEpoch, ...operation });
}

/** A lost response never retries a mutation implicitly. Retry with the same ID. */
export async function callTuiWorker(manifest: TuiWorkerManifest, operation: TuiWorkerOperation,
  options: { requestId?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TuiWorkerResponse> {
  const request = workerRequest(manifest, operation, options.requestId);
  return await exchangeTuiWorker(manifest.controlSocket, request, manifest.workerEpoch, options);
}

export async function exchangeTuiWorker(socketPath: string, request: { requestId: string }, workerEpoch: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TuiWorkerResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid worker timeout");
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Worker observation cancelled");
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame) > TUI_WORKER_MAX_FRAME_BYTES) throw new Error("Worker request is oversized");
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false, buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: TuiWorkerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error("Worker observation cancelled; execution is unchanged"));
    const timer = setTimeout(() => finish(new Error("Worker response timeout; dispatch may have been accepted")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error("Worker disconnected without receipt; dispatch may have been accepted")));
    socket.on("connect", () => socket.write(frame));
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > TUI_WORKER_MAX_FRAME_BYTES) { finish(new Error("Oversized worker response")); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        if (newline !== buffer.length - 1) throw new Error("Unexpected worker response framing");
        const response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))) as TuiWorkerResponse;
        if (response.protocol !== 1 || response.requestId !== request.requestId || response.workerEpoch !== workerEpoch || typeof response.ok !== "boolean") throw new Error("Mismatched worker response");
        if (response.ok && (!Number.isSafeInteger(response.sequence) || response.sequence < 0 || !["accepted", "applied"].includes(response.receipt))) throw new Error("Invalid worker receipt");
        finish(undefined, response);
      } catch (error) { finish(error as Error); }
    });
  });
}

/** Trusted operator caller only. Capability must never flow into model tools. */
export async function applyTuiWorkerOperatorMode(manifest: TuiWorkerManifest, operatorCapability: string,
  enabled: boolean, requestId = randomBytes(16).toString("hex")): Promise<TuiWorkerResponse> {
  return await exchangeTuiWorker(manifest.controlSocket, {
    operatorProtocol: 1, requestId, workerEpoch: manifest.workerEpoch, ownerSessionId: manifest.ownerSessionId,
    runtimeId: manifest.runtimeId, operatorCapability, enabled,
  } as { requestId: string }, manifest.workerEpoch);
}
