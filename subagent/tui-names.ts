export const SUBAGENT_NAME_MAX_LENGTH = 28;
export const SUBAGENT_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

/** Optional presentation label, never an execution/ownership identity. */
export function validateSubagentName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== "string" || name.length > SUBAGENT_NAME_MAX_LENGTH || name.trim() !== name || !new RegExp(SUBAGENT_NAME_PATTERN).test(name)) {
    throw new Error("Subagent name must be 1–28 ASCII lowercase kebab-case characters");
  }
  return name;
}

/** Bounded, deterministic and model-free. Duplicate display names are harmless. */
export function subagentTmuxName(task: string, name?: string): string {
  const explicit = validateSubagentName(name);
  if (explicit) return `agt-${explicit}`;
  const words = task.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4);
  let slug = "";
  for (const word of words) {
    if (!slug) slug = word.slice(0, SUBAGENT_NAME_MAX_LENGTH);
    else if (slug.length + 1 + word.length <= SUBAGENT_NAME_MAX_LENGTH) slug += `-${word}`;
    else break;
  }
  return `agt-${slug || "worker"}`;
}

export const SUBAGENT_DISPLAY_NAME_MAX_LENGTH = 80;

/** Human presentation only: never use this value to authorize or route a worker. */
export function validateSubagentDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > SUBAGENT_DISPLAY_NAME_MAX_LENGTH
    || value !== value.trim() || !value || /[\p{Cc}\p{Cf}]/u.test(value)
    || value.split(/\s+/u).length > 4) {
    throw new Error("Subagent displayName must be 1–4 words, at most 80 characters, without control characters");
  }
  return value.replace(/\s+/gu, " ");
}

/** Explicit parent wording wins; legacy name remains accepted without becoming identity. */
export function canonicalSubagentName(task: string, displayName?: string, name?: string): string {
  const explicit = validateSubagentDisplayName(displayName);
  if (explicit) return explicit;
  const legacy = validateSubagentName(name);
  if (legacy) return legacy.split("-").slice(0, 4).join(" ");
  // Ignore instruction headings and urgency rather than copying an entire prompt.
  const words = task.normalize("NFKC").replace(/\b(?:urgent|important|instructions?|please|task)\b\s*:?/giu, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  let result = "";
  for (const word of words.slice(0, 4)) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > SUBAGENT_DISPLAY_NAME_MAX_LENGTH) break;
    result = next;
  }
  return result || "Worker";
}

/** Readable tmux alias, unique in the supplied namespace; no opaque IDs. */
export function subagentTmuxAlias(displayName: string, occupied: Iterable<string> = []): string {
  const words = displayName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const base = words.slice(0, 2).join("-").slice(0, 28).replace(/-+$/, "") || "worker";
  const used = new Set(occupied);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Refresh generated terminal headers only; preserve the worker's actual answer verbatim. */
export function subagentResultPresentation(text: string, group: any, lookup: (child: any) => string | undefined): string {
  if (!Array.isArray(group?.children)) return text;
  return text.split("\n").map((line, index) => {
    if (index === 0 && typeof group.job_id === "string" && line.startsWith(`${group.job_id} `)) line = `${group.mode ?? "subagent"} ${line.slice(group.job_id.length + 1)}`;
    for (const child of group.children) {
      const label = lookup(child) ?? child.displayName ?? canonicalSubagentName(String(child.task ?? "Worker"));
      const prefixes = [`${child.child}. ${child.child_id} task_id=${child.task_id} `, `${child.child}. ${child.child_id} `,
        ...(child.displayName ? [`${child.child}. ${child.displayName} `] : [])];
      const prefix = prefixes.find(prefix => line.startsWith(prefix));
      if (prefix) return `${child.child}. ${label} ${line.slice(prefix.length)}`;
    }
    return line;
  }).join("\n");
}

/** AgentSH's independent request validator need not know native presentation fields. */
export function withoutSubagentNames(params: any): any {
  const { name: _name, displayName: _displayName, ...rest } = params;
  for (const key of ["tasks", "chain"]) {
    if (Array.isArray(rest[key])) rest[key] = rest[key].map(({ name: _itemName, displayName: _displayName, ...item }: any) => item);
  }
  return rest;
}
