import { stat } from "node:fs/promises";

export async function openRetainedSession<T extends { getSessionId(): string }>(
  sessionFile: string,
  expectedSessionId: string,
  open: (sessionFile: string) => T,
  check: (sessionFile: string) => Promise<unknown> = stat,
): Promise<T | null> {
  try {
    await check(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manager = open(sessionFile);
  if (manager.getSessionId() !== expectedSessionId)
    throw new Error("Retained child session identity changed");
  return manager;
}
