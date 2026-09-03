export const SUBAGENT_PERMISSION_AUTHORITY_KEY = "__paeSubagentPermissionAuthorityV1";
export const SUBAGENT_PERMISSION_SELECTION_KEY = "__paeSubagentPermissionSelectionV1";
export const SUBAGENT_PERMISSION_SOCKET_ENV = "PI_SUBAGENT_PERMISSION_SOCKET";
export const SUBAGENT_PERMISSION_TOKEN_ENV = "PI_SUBAGENT_PERMISSION_TOKEN";

export const SUBAGENT_PERMISSION_PROTOCOL_VERSION = 1;
export const SUBAGENT_PERMISSION_MAX_FRAME_BYTES = 64 * 1024;
export const SUBAGENT_PERMISSION_MAX_COMMAND_BYTES = 32 * 1024;
export const SUBAGENT_PERMISSION_MAX_CWD_BYTES = 4 * 1024;
export const SUBAGENT_PERMISSION_MAX_ID_BYTES = 256;
export const SUBAGENT_PERMISSION_MAX_REASON_BYTES = 512;
export const SUBAGENT_PERMISSION_MAX_REQUESTS = 4096;
export const SUBAGENT_PERMISSION_NATIVE_TOOLS = ["read", "bash", "edit", "write"] as const;
export const SUBAGENT_PERMISSION_MAX_TOOLS = SUBAGENT_PERMISSION_NATIVE_TOOLS.length;
export const SUBAGENT_PERMISSION_BASH_TOOL = "parent_bash";

export type SubagentPermissionSelection = {
  protocol: 1;
  selected: true;
  conflict: boolean;
};

export type SubagentPermissionRequest = {
  subagentId: string;
  label: string;
  task: string;
  toolCallId: string;
  command: string;
  cwd: string;
};

export type SubagentPermissionResult = {
  allowed: boolean;
  reason: string;
};

/** Parent-process authority published by the launcher-bound Permission Gate. */
export type SubagentPermissionAuthority = {
  protocol: 1;
  selected: true;
  active: boolean;
  authorize(request: SubagentPermissionRequest, signal?: AbortSignal): Promise<SubagentPermissionResult>;
};

export function currentSubagentPermissionSelection(): SubagentPermissionSelection | undefined {
  const value = (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_SELECTION_KEY];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Parent subagent Permission Gate selection is malformed");
  }
  const candidate = value as Partial<SubagentPermissionSelection>;
  if (candidate.protocol !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || candidate.selected !== true
    || typeof candidate.conflict !== "boolean") {
    throw new Error("Parent subagent Permission Gate selection is malformed");
  }
  return candidate as SubagentPermissionSelection;
}

export function currentSubagentPermissionAuthority(): SubagentPermissionAuthority | undefined {
  const value = (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_AUTHORITY_KEY];
  if (value === undefined) {
    if (currentSubagentPermissionSelection()?.selected) {
      throw new Error("Parent subagent Permission Gate was selected but its authority is unavailable");
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Parent subagent Permission Gate authority is malformed");
  }
  const candidate = value as Partial<SubagentPermissionAuthority>;
  if (candidate.protocol !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || candidate.selected !== true
    || typeof candidate.active !== "boolean" || typeof candidate.authorize !== "function") {
    throw new Error("Parent subagent Permission Gate authority is malformed");
  }
  return candidate as SubagentPermissionAuthority;
}
