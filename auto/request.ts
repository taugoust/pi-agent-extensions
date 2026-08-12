import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type AutoAction = "review" | "apply" | "discard" | "pause";

function assertPrivateOwner(path: string, label: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  return stat;
}

export function writeAutoActionRequest(path: string, sessionId: string, action: AutoAction) {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error("Draft action request path must be an absolute single-line path");
  }
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new Error("Draft session identity is malformed");
  }

  const parent = assertPrivateOwner(dirname(path), "Draft action request directory");
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error("Draft action request directory is not private");
  }
  if (existsSync(path)) throw new Error("A Draft action is already pending");

  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ schema_version: 1, session_id: sessionId, action })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const tempStat = assertPrivateOwner(temporary, "Draft action request");
    if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600) {
      throw new Error("Draft action request is not a private regular file");
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
