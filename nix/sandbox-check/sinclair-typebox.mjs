export const Type = {
  String(options = {}) {
    return { type: "string", ...options };
  },
  Number(options = {}) {
    return { type: "number", ...options };
  },
  Integer(options = {}) {
    return { type: "integer", ...options };
  },
  Boolean(options = {}) {
    return { type: "boolean", ...options };
  },
  Array(items, options = {}) {
    return { type: "array", items, ...options };
  },
  Object(properties) {
    return { type: "object", properties };
  },
  Optional(schema) {
    return { ...schema, optional: true };
  },
  Literal(value) {
    return { const: value, type: typeof value };
  },
  Union(schemas, options = {}) {
    return { anyOf: schemas, ...options };
  },
  Unknown() {
    return {};
  },
  Null() {
    return { type: "null" };
  },
  Record(key, value) {
    return { type: "object", additionalProperties: value };
  },
};
