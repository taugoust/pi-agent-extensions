import { createServer, createConnection, type Server } from "node:net";
import { chmod, unlink } from "node:fs/promises";

/** Immutable launch identity; a retained task alone is not an execution identity. */
export type GoalWorkerIdentity = {
  sessionId: string; runtimeId: string; taskId: string; childId: string;
  jobId: string; attempt: number; workerEpoch: string;
};
export type GoalWorkerRequest = { identity: GoalWorkerIdentity; token: string; request: unknown };
const fields = ["sessionId", "runtimeId", "taskId", "childId", "jobId", "attempt", "workerEpoch"] as const;
const MAX_FRAME = 1024 * 1024;
export function sameGoalWorker(a: GoalWorkerIdentity, b: unknown): boolean {
  return !!b && typeof b === "object" && fields.every(k => a[k] === (b as GoalWorkerIdentity)[k])
    && Object.keys(b).length === fields.length;
}

/** Private, structured workflow channel. Never interprets prompts or slash commands.
 * All mutations share one lane; identity is rechecked at execution, not only enqueue.
 */
export async function serveGoalWorker(options: {
  path: string; token: string; identity: GoalWorkerIdentity;
  isCurrent(): boolean;
  handle(request: unknown): Promise<unknown>;
}): Promise<{ close(): Promise<void> }> {
  if (options.token.length < 32) throw new Error("Goal worker capability is too short");
  let closed = false, lane: Promise<unknown> = Promise.resolve();
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let frame = "", received = false;
    socket.on("data", chunk => {
      if (received) { socket.destroy(); return; }
      frame += chunk.toString("utf8");
      if (Buffer.byteLength(frame) > MAX_FRAME) { socket.destroy(); return; }
      const end = frame.indexOf("\n");
      if (end < 0) return;
      received = true;
      const work = lane.then(async () => {
        if (closed || !options.isCurrent()) throw new Error("Stale goal worker runtime");
        const input = JSON.parse(frame.slice(0, end)) as GoalWorkerRequest;
        if (frame.slice(end + 1).trim() || input.token !== options.token || !sameGoalWorker(options.identity, input.identity))
          throw new Error("Stale goal worker identity");
        const result = await options.handle(input.request);
        if (closed || !options.isCurrent()) throw new Error("Goal worker changed during request");
        return result;
      });
      lane = work.catch(() => {});
      void work.then(result => socket.end(JSON.stringify({ ok: true, result }) + "\n"),
        error => socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Goal workflow failed" }) + "\n"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => { server.removeListener("error", reject); resolve(); });
  });
  try { await chmod(options.path, 0o600); }
  catch (error) { server.close(); await unlink(options.path).catch(() => {}); throw error; }
  return { async close() {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await lane;
    await unlink(options.path).catch(() => {});
  } };
}

export function requestGoalWorker(path: string, input: GoalWorkerRequest, timeoutMs = 30_000): Promise<unknown> {
  const encoded = JSON.stringify(input) + "\n";
  if (Buffer.byteLength(encoded) > MAX_FRAME) return Promise.reject(new Error("Goal workflow request too large"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    let frame = "", done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true; socket.destroy(); error ? reject(error) : resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Goal workflow request timed out; inspect before retrying")));
    socket.on("error", error => finish(error));
    socket.on("connect", () => socket.write(encoded));
    socket.on("data", chunk => {
      frame += chunk.toString("utf8");
      if (Buffer.byteLength(frame) > MAX_FRAME) { finish(new Error("Goal workflow response too large")); return; }
      const end = frame.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(frame.slice(0, end));
        if (value.ok === true) finish(undefined, value.result);
        else finish(new Error(typeof value.error === "string" ? value.error : "Invalid goal workflow response"));
      } catch (error) { finish(error as Error); }
    });
    socket.on("end", () => { if (!done) finish(new Error("Goal workflow channel ended without a response")); });
  });
}
