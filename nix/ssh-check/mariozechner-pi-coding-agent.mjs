function tool(name, cwd, options = {}) {
  return {
    name,
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: `${name}:${params.path || cwd}` }],
        details: { operations: options.operations },
      };
    },
  };
}
export const createReadTool = (cwd, options) => tool("read", cwd, options);
export const createWriteTool = (cwd, options) => tool("write", cwd, options);
export const createEditTool = (cwd, options) => tool("edit", cwd, options);
