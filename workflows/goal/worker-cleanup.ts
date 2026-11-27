export function unreapedWorkerIds(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || (value as any).isError) return;
  const details = (value as any).details ?? (value as any).structuredContent ?? value;
  const keys = ["groups", "descendants"];
  if (keys.some((key) => !Array.isArray(details?.[key]))) return;
  const groups = keys.flatMap((key) => details[key]);
  if (groups.some((group: any) => !Array.isArray(group.children))) return;
  const workers = groups.flatMap((group: any) =>
    group.children
      .filter((child: any) => child.reaped !== true)
      .map((child: any) => `${group.job_id}/${child.child_id}`),
  );
  if (!Array.isArray(details.foregroundTasks) || !Array.isArray(details.background)) return;
  return workers.concat(
    details.foregroundTasks
      .filter((task: any) => task.status !== "reaped")
      .map((task: any) => `${task.groupId}/${task.childId}`),
    details.background.map((record: any) => record.id),
  );
}

export async function runGoalCompletionWorkerGate<T>(
  ctx: any,
  complete: () => T | Promise<T>,
  reject: (message: string) => T | Promise<T>,
): Promise<T> {
  const message = await goalCompletionWorkerRejection(ctx);
  return message ? await reject(message) : await complete();
}

export async function goalCompletionWorkerRejection(ctx: any): Promise<string | undefined> {
  const controller = (globalThis as any).__paeLocalSubagentControllerV1;
  const sessionId = ctx.sessionManager.getSessionId();
  if (!controller) {
    return process.env.PI_DEDICATED_GOAL_CHILD === "1"
      ? "Goal completion rejected: delegated worker inventory is unavailable."
      : undefined;
  }
  if (
    controller.protocol !== 1 ||
    controller.sessionId !== sessionId ||
    typeof controller.goalCompletionWorkers !== "function"
  )
    return "Goal completion rejected: delegated worker inventory is unavailable.";
  try {
    const workers = unreapedWorkerIds(await controller.goalCompletionWorkers());
    if (!workers) return "Goal completion rejected: delegated worker inventory is invalid.";
    return workers.length
      ? `Goal completion rejected: reap delegated workers first: ${workers.join(", ")}.`
      : undefined;
  } catch (error) {
    return `Goal completion rejected: delegated workers could not be inspected (${String(error)}).`;
  }
}
