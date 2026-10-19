import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const PROGRESS_SETTINGS_FILE = "pi-progress.json";
export const MAX_PROGRESS_SETTINGS_BYTES = 64 * 1024;
export const PROGRESS_DISPLAY_MODES = ["adaptive", "expanded", "collapsed"] as const;

export type ProgressDisplayMode = (typeof PROGRESS_DISPLAY_MODES)[number];

export interface ProgressSettings {
  enabled: boolean;
  displayMode: ProgressDisplayMode;
  showCompleted: boolean;
  maxVisibleItems: number | null;
  showProgress: boolean;
}

export const DEFAULT_PROGRESS_SETTINGS: Readonly<ProgressSettings> = Object.freeze({
  enabled: true,
  displayMode: "adaptive",
  showCompleted: true,
  maxVisibleItems: null,
  showProgress: true,
});

export type ProgressSettingsLoadResult =
  | { kind: "missing"; path: string; settings: ProgressSettings }
  | { kind: "loaded"; path: string; settings: ProgressSettings }
  | { kind: "invalid"; path: string; settings: ProgressSettings; issue: string };

export function progressSettingsPath(): string {
  return join(getAgentDir(), PROGRESS_SETTINGS_FILE);
}

export function normalizeProgressSettings(value: unknown): ProgressSettings | undefined {
  if (!isRecord(value)) return undefined;
  const widgetValue = Object.hasOwn(value, "widget") ? value.widget : undefined;
  if (widgetValue !== undefined && !isRecord(widgetValue)) return undefined;
  // Retain nested pi-progress.json settings; top-level fields take precedence.
  const settings = { ...widgetValue, ...value };

  const enabled = booleanSetting(settings, "enabled", DEFAULT_PROGRESS_SETTINGS.enabled);
  const showCompleted = booleanSetting(settings, "showCompleted", DEFAULT_PROGRESS_SETTINGS.showCompleted);
  const showProgress = booleanSetting(settings, "showProgress", DEFAULT_PROGRESS_SETTINGS.showProgress);
  if (enabled === undefined || showCompleted === undefined || showProgress === undefined) return undefined;

  const displayMode = Object.hasOwn(settings, "displayMode")
    ? settings.displayMode
    : DEFAULT_PROGRESS_SETTINGS.displayMode;
  if (!PROGRESS_DISPLAY_MODES.includes(displayMode as ProgressDisplayMode)) return undefined;

  const maxVisibleItems = Object.hasOwn(settings, "maxVisibleItems")
    ? settings.maxVisibleItems
    : DEFAULT_PROGRESS_SETTINGS.maxVisibleItems;
  if (
    maxVisibleItems !== null &&
    (typeof maxVisibleItems !== "number" ||
      !Number.isSafeInteger(maxVisibleItems) ||
      maxVisibleItems < 1 ||
      maxVisibleItems > 50)
  ) {
    return undefined;
  }

  return {
    enabled,
    displayMode: displayMode as ProgressDisplayMode,
    showCompleted,
    maxVisibleItems,
    showProgress,
  };
}

export async function loadProgressSettings(
  canonicalPath = progressSettingsPath(),
  signal?: AbortSignal,
): Promise<ProgressSettingsLoadResult> {
  return withFileMutationQueue(canonicalPath, async () => {
    const result = await loadSettingsFile(canonicalPath, signal);
    throwIfAborted(signal);
    return result;
  });
}

export async function saveProgressSettings(
  patch: Partial<ProgressSettings>,
  path = progressSettingsPath(),
  signal?: AbortSignal,
): Promise<ProgressSettings> {
  return withFileMutationQueue(path, async () => {
    let document: Record<string, unknown> = {};
    let mode = 0o600;
    const loaded = await loadSettingsFile(path, signal, (parsed, fileMode) => {
      document = parsed;
      mode = fileMode & 0o777;
    });
    throwIfAborted(signal);
    if (loaded.kind === "invalid") throw new Error(`Cannot save invalid settings: ${loaded.issue}`);
    const nextDocument = { ...document, ...patch };
    const settings = normalizeProgressSettings(nextDocument);
    if (!settings) throw new Error("Invalid settings update");
    const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_PROGRESS_SETTINGS_BYTES) throw new Error("Settings update exceeds size limit");

    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    throwIfAborted(signal);
    const temporary = await mkdtemp(join(parent, ".pi-progress-"));
    try {
      throwIfAborted(signal);
      const staged = join(temporary, "settings.json");
      await writeFile(staged, text, { mode, signal });
      // writeFile applies umask; restore the intended mode before atomic publication.
      await chmod(staged, mode);
      throwIfAborted(signal);
      await rename(staged, path);
      // A rename can complete while cancellation fires; the next queued read sees it.
      return settings;
    } finally {
      // Cleanup failure must not report a successful publication as a failed save.
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function loadSettingsFile(
  path: string,
  signal?: AbortSignal,
  onDocument?: (document: Record<string, unknown>, mode: number) => void,
): Promise<ProgressSettingsLoadResult> {
  throwIfAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throwIfAborted(signal);
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: cloneDefaultSettings() };
    }
    return invalidResult(path, safeReadIssue(error));
  }

  try {
    const stats = await handle.stat();
    throwIfAborted(signal);
    if (!stats.isFile()) return invalidResult(path, "settings path is not a regular file");
    if (stats.size > MAX_PROGRESS_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_PROGRESS_SETTINGS_BYTES} bytes`);
    }

    const buffer = Buffer.alloc(MAX_PROGRESS_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROGRESS_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_PROGRESS_SETTINGS_BYTES} bytes`);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      return invalidResult(path, "settings file is not valid UTF-8");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return invalidResult(path, "invalid JSON");
    }
    const settings = normalizeProgressSettings(parsed);
    if (!settings || !isRecord(parsed)) return invalidResult(path, "invalid settings shape or values");
    onDocument?.(parsed, stats.mode);
    return { kind: "loaded", path, settings };
  } catch (error) {
    throwIfAborted(signal);
    return invalidResult(path, safeReadIssue(error));
  } finally {
    await handle.close();
  }
}

function booleanSetting(record: Record<string, unknown>, key: string, fallback: boolean): boolean | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : fallback;
  return typeof value === "boolean" ? value : undefined;
}

function cloneDefaultSettings(): ProgressSettings {
  return { ...DEFAULT_PROGRESS_SETTINGS };
}

function invalidResult(path: string, issue: string): ProgressSettingsLoadResult {
  return { kind: "invalid", path, settings: cloneDefaultSettings(), issue };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeReadIssue(error: unknown): string {
  if (isNodeError(error) && error.code === "ELOOP") return "symbolic links are not accepted";
  return error instanceof Error ? error.message : String(error);
}
