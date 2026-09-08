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

/** AgentSH's independent request validator need not know native presentation fields. */
export function withoutSubagentNames(params: any): any {
  const { name: _name, ...rest } = params;
  for (const key of ["tasks", "chain"]) {
    if (Array.isArray(rest[key])) rest[key] = rest[key].map(({ name: _itemName, ...item }: any) => item);
  }
  return rest;
}
