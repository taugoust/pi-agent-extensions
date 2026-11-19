export const Type = {
  String(options = {}) {
    return { type: "string", ...options };
  },
  Number(options = {}) {
    return { type: "number", ...options };
  },
  Boolean(options = {}) {
    return { type: "boolean", ...options };
  },
  Literal(value, options = {}) {
    return { const: value, ...options };
  },
  Union(anyOf, options = {}) {
    return { anyOf, ...options };
  },
  Object(properties, options = {}) {
    return { type: "object", properties, ...options };
  },
  Optional(schema) {
    return { ...schema, optional: true };
  },
};
