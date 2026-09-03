const REGISTRY_KEY = "__paeBashCommandTransformsV1";

export type BashCommandTransform = (command: string) => string;

type BashCommandTransformRegistry = {
  protocol: 1;
  transforms: Map<string, BashCommandTransform>;
  applied: WeakSet<object>;
};

function registry(): BashCommandTransformRegistry {
  const root = globalThis as Record<string, unknown>;
  const existing = root[REGISTRY_KEY] as BashCommandTransformRegistry | undefined;
  if (existing !== undefined) {
    if (existing?.protocol !== 1
      || !(existing.transforms instanceof Map)
      || !(existing.applied instanceof WeakSet)) {
      throw new Error("Bash command transform registry is malformed");
    }
    return existing;
  }
  const created: BashCommandTransformRegistry = {
    protocol: 1,
    transforms: new Map(),
    applied: new WeakSet(),
  };
  root[REGISTRY_KEY] = created;
  return created;
}

export function registerBashCommandTransform(
  name: string,
  transform: BashCommandTransform,
): () => void {
  if (!name || typeof transform !== "function") {
    throw new Error("Bash command transform registration is malformed");
  }
  const transforms = registry().transforms;
  transforms.set(name, transform);
  return () => {
    if (transforms.get(name) === transform) transforms.delete(name);
  };
}

/**
 * Apply every trusted extension transform exactly once to one mutable Pi Bash
 * input object. Each transform computes a string before the final command is
 * committed, so a throwing transform cannot leave a partly rewritten command.
 */
export function applyBashCommandTransforms(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Bash tool input is malformed");
  }
  const target = input as { command?: unknown };
  if (typeof target.command !== "string") {
    throw new Error("Bash command is missing or malformed");
  }
  const state = registry();
  if (state.applied.has(input)) return;

  let command = target.command;
  for (const [name, transform] of state.transforms) {
    const transformed = transform(command);
    if (typeof transformed !== "string" || transformed.length === 0) {
      throw new Error(`Bash command transform ${JSON.stringify(name)} returned an invalid command`);
    }
    command = transformed;
  }
  target.command = command;
  state.applied.add(input);
}
