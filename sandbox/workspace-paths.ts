import { posix as posixPath } from "node:path";

type JsonObject = Record<string, unknown>;

export type WorkspaceRoot = {
  name?: string;
  real?: string;
  work?: string;
};

export type WorkspacePathMetadata = {
  worktree?: string;
  real_workspace?: string;
  virtual_root?: string;
  workspace_roots?: WorkspaceRoot[];
};

export type RestFileRequest = {
  path: string;
  cwd?: string;
};

export function toSlashPath(path: string) {
  return path.replace(/\\/g, "/");
}

export function cleanPosix(path: string) {
  const cleaned = posixPath.normalize(toSlashPath(path));
  return cleaned === "." ? "" : cleaned;
}

export function isUnderPath(path: string, root: string) {
  const cleanPath = cleanPosix(path);
  const cleanRoot = cleanPosix(root);
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
}

function relativeToRoot(path: string, root: string) {
  const cleanPath = cleanPosix(path);
  const cleanRoot = cleanPosix(root);
  if (cleanPath === cleanRoot) return "";
  return cleanPath.slice(cleanRoot.length + 1);
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeWorkspaceRoots(value: unknown): WorkspaceRoot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const obj = candidate as JsonObject;
    const root: WorkspaceRoot = {
      name: stringField(obj.name),
      real: stringField(obj.real),
      work: stringField(obj.work),
    };
    return root.name || root.real || root.work ? [root] : [];
  });
}

function metadataVirtualRoot(metadata?: WorkspacePathMetadata) {
  return stringField(metadata?.virtual_root) || "/workspace";
}

function virtualForRoot(vroot: string, root: WorkspaceRoot, rel: string) {
  const parts = [vroot, root.name || "", rel].filter(Boolean);
  return cleanPosix(parts.join("/"));
}

export function absoluteToVirtual(metadata: WorkspacePathMetadata | undefined, path: string) {
  if (!path.startsWith("/")) return undefined;
  const abs = cleanPosix(path);
  const vroot = metadataVirtualRoot(metadata);
  if (isUnderPath(abs, vroot)) return abs;

  const roots = metadata?.workspace_roots || [];
  const singleFlatRoot = roots.length === 1 && roots[0].work && metadata?.worktree && cleanPosix(roots[0].work) === cleanPosix(metadata.worktree);
  if (singleFlatRoot) {
    const root = roots[0];
    for (const candidate of [root.work, root.real]) {
      if (candidate && isUnderPath(abs, candidate)) {
        return cleanPosix(`${vroot}/${relativeToRoot(abs, candidate)}`);
      }
    }
  }

  for (const root of roots) {
    for (const candidate of [root.work, root.real]) {
      if (candidate && isUnderPath(abs, candidate)) {
        return virtualForRoot(vroot, root, relativeToRoot(abs, candidate));
      }
    }
  }

  if (metadata?.worktree && isUnderPath(abs, metadata.worktree)) {
    return cleanPosix(`${vroot}/${relativeToRoot(abs, metadata.worktree)}`);
  }
  if (metadata?.real_workspace && isUnderPath(abs, metadata.real_workspace)) {
    return cleanPosix(`${vroot}/${relativeToRoot(abs, metadata.real_workspace)}`);
  }
  return undefined;
}

function firstPathComponent(path: string) {
  return cleanPosix(path).split("/").find(Boolean) || "";
}

export function restFileRequest(metadata: WorkspacePathMetadata | undefined, path: string, cwd: string): RestFileRequest {
  const directVirtual = absoluteToVirtual(metadata, toSlashPath(path));
  if (directVirtual) return { path: directVirtual };

  cwd = toSlashPath(cwd);
  const virtualCwd = absoluteToVirtual(metadata, cwd);
  if (virtualCwd) return { path, cwd: virtualCwd };

  const first = firstPathComponent(path);
  if (first && (metadata?.workspace_roots || []).some((root) => root.name === first)) {
    return { path, cwd: metadataVirtualRoot(metadata) };
  }

  return { path };
}

export function supervisorAbsolutePath(metadata: WorkspacePathMetadata | undefined, path: string, cwd: string) {
  const file = restFileRequest(metadata, path, cwd);
  if (posixPath.isAbsolute(file.path)) return cleanPosix(file.path);
  const virtualCwd = file.cwd || absoluteToVirtual(metadata, toSlashPath(cwd)) || metadataVirtualRoot(metadata);
  return cleanPosix(posixPath.resolve(virtualCwd, file.path));
}
