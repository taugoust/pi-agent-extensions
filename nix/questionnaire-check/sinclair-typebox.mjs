export const Type = {
  Object: (properties) => ({ type: "object", properties }),
  String: () => ({ type: "string" }),
  Boolean: () => ({ type: "boolean" }),
  Optional: (value) => value,
  Array: (items) => ({ type: "array", items }),
};
