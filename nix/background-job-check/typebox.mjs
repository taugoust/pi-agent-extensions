const make = (...args) => ({ args });
export const Type = new Proxy({}, { get: () => make });
