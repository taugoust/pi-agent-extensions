import path from "node:path";

type JsonObject = Record<string, unknown>;

function cleanPosix(value: string) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === "." ? "" : normalized;
}

function requestedCwd(cwd: unknown, parentCwd: string, toVirtual: (absolute: string) => string | undefined) {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const requested = cleanPosix(cwd.trim());
  if (requested.startsWith("/") || /^[A-Za-z]:\//.test(requested)) {
    return toVirtual(requested) || requested;
  }
  return cleanPosix(`${parentCwd}/${requested}`);
}

// Normalize every model-supplied cwd into the supervisor's virtual workspace.
// Pi's ctx.cwd can be the real project path while AgentSH executes against a
// shadow mount, so forwarding that host path directly is not a valid subagent
// cwd even though both paths describe the same logical project.
export function normalizeSupervisorSubagentCwds(
  params: JsonObject,
  parentCwd: string,
  toVirtual: (absolute: string) => string | undefined,
) {
  const normalized = { ...params };
  const cleanParent = cleanPosix(parentCwd);
  const supervisorParent = toVirtual(cleanParent) || cleanParent;
  const requestCwd = requestedCwd(normalized.cwd, supervisorParent, toVirtual) || supervisorParent;
  if (typeof normalized.cwd === "string") normalized.cwd = requestCwd;

  for (const key of ["tasks", "chain"] as const) {
    if (!Array.isArray(normalized[key])) continue;
    normalized[key] = normalized[key].map((candidate: unknown) => {
      if (!candidate || typeof candidate !== "object") return candidate;
      const item = { ...(candidate as JsonObject) };
      const cwd = requestedCwd(item.cwd, requestCwd, toVirtual);
      if (cwd) item.cwd = cwd;
      return item;
    });
  }
  return { params: normalized, parentCwd: requestCwd };
}
