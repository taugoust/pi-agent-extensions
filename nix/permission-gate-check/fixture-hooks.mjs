import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-coding-agent")
      return {
        url: "data:text/javascript,export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith("/extension-config-manifest.json"))
      return {
        format: "module",
        source: "export default " + readFileSync(new URL(url), "utf8"),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
