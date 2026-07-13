export type SubagentModelIdentity = {
  provider?: unknown;
  id?: unknown;
};

type SubagentParams = Record<string, unknown> & {
  model?: unknown;
  tasks?: unknown;
  chain?: unknown;
};

export function canonicalModelReference(model: SubagentModelIdentity | null | undefined): string | undefined {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!provider || !id) return undefined;
  return `${provider}/${id}`;
}

function inheritItemModel(value: unknown, inheritedModel: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (typeof item.model === "string" && item.model.trim()) return item;
  return { ...item, model: inheritedModel };
}

/**
 * Apply the trusted parent's active model to child requests that do not select
 * one explicitly. This prevents child Pi from silently resolving a different
 * default provider/model (and therefore a different login) than its parent.
 */
export function inheritSubagentModels(params: SubagentParams, parentModel: SubagentModelIdentity | null | undefined): SubagentParams {
  const inheritedModel = canonicalModelReference(parentModel);
  if (!inheritedModel) return params;

  if (Array.isArray(params.tasks)) {
    return { ...params, tasks: params.tasks.map((item) => inheritItemModel(item, inheritedModel)) };
  }
  if (Array.isArray(params.chain)) {
    return { ...params, chain: params.chain.map((item) => inheritItemModel(item, inheritedModel)) };
  }
  if (typeof params.model === "string" && params.model.trim()) return params;
  return { ...params, model: inheritedModel };
}
