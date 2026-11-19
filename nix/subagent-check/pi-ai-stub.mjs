const optional = Symbol.for("TypeBox.Optional");
export const Type = {
  String: (options = {}) => ({ type: "string", ...options }),
  Integer: (options = {}) => ({ type: "integer", ...options }),
  Boolean: (options = {}) => ({ type: "boolean", ...options }),
  Literal: (value, options = {}) => ({ const: value, ...options }),
  Union: (anyOf, options = {}) => ({ anyOf, ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Optional: (schema) => ({ ...schema, [optional]: "Optional" }),
  Object: (properties, options = {}) => {
    const required = Object.keys(properties).filter(
      (key) => properties[key][optional] !== "Optional",
    );
    return { type: "object", properties, ...(required.length ? { required } : {}), ...options };
  },
};
