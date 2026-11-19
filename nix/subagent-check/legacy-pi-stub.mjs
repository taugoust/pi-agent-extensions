export function createBashTool() {
  return {
    name: "bash",
    label: "bash",
    description: "test bash",
    parameters: {},
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: "built-in:" + params.command }],
        details: {},
        isError: false,
      };
    },
  };
}
