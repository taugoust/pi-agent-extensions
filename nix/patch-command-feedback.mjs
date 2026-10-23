import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const read = path => readFileSync(join(root, path), "utf8");
function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) throw new Error(`Command feedback source drift (${label})`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}
function insertMethods(text, start, end, label) {
  const first = text.indexOf(start);
  if (first < 0 || text.indexOf(start, first + start.length) >= 0) throw new Error(`Command feedback section drift (${label})`);
  const last = text.indexOf(end, first + start.length);
  if (last < 0) throw new Error(`Command feedback section end missing (${label})`);
  return text.slice(0, last) + methods + text.slice(last);
}
// One implementation for the unbundled Node SDK and the native bundle: class
// method names are preserved by the release minifier. No legacy method changes.
const methods = `
    async dispatchExtensionCommand(name, args = "", options = {}) {
        const runner = this._extensionRunner;
        const command = runner.getCommand(name);
        if (!command) return { status: "not_found", notifications: [] };
        const notifications = [];
        let observing = true;
        const ctx = runner.createCommandContext();
        const ui = ctx.ui;
        const localNotify = ui.notify.bind(ui);
        const dispatchNotify = (message, type = "info") => {
            if (observing) {
                try { if (this._extensionRunner !== runner) observing = false; runner.assertActive(); }
                catch { observing = false; }
                if (observing) {
                    notifications.push({ message, type });
                    try { options.onNotify?.(message, type); } catch { /* Observers cannot fail commands. */ }
                }
            }
            localNotify(message, type);
        };
        Object.defineProperty(ctx, "ui", {
            enumerable: true,
            value: new Proxy(ui, { get(target, property) {
                if (property === "notify") return dispatchNotify;
                if (options.allowDialogs === false && ["select", "input", "confirm", "editor", "custom"].includes(property))
                    return () => { throw new Error("This command requires terminal UI and cannot continue through Paseo."); };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
            } }),
        });
        try {
            await command.handler(args, ctx);
            return { status: "completed", notifications };
        } catch (error) {
            return { status: "failed", error: { message: error instanceof Error ? error.message : String(error) }, notifications };
        } finally { observing = false; }
    }
    submitUserMessage(content, options = {}) {
        let text, images;
        if (typeof content === "string") text = content;
        else {
            text = content.filter(part => part.type === "text").map(part => part.text).join("\\n");
            images = content.filter(part => part.type !== "text");
            if (images.length === 0) images = undefined;
        }
        return new Promise((resolve, reject) => {
            let admitted = false;
            this.prompt(text, {
                expandPromptTemplates: options.expandPromptTemplates ?? false,
                streamingBehavior: options.deliverAs,
                images,
                source: "extension",
                preflightResult: disposition => {
                    if (admitted) return;
                    if (!["handled", "queued", "started"].includes(disposition)) {
                        reject(new Error("Unknown Pi prompt admission disposition")); return;
                    }
                    admitted = true;
                    resolve({ disposition });
                },
            }).catch(error => { if (!admitted) reject(error); });
        });
    }
`;
function patchNode(core) {
  let loader = read(`${core}/extensions/loader.js`);
  loader = replaceOnce(loader, "        sendUserMessage: notInitialized,\n", "        sendUserMessage: notInitialized,\n        dispatchExtensionCommand: notInitialized,\n        submitUserMessage: notInitialized,\n", "Node runtime stubs");
  loader = replaceOnce(loader,
    "        sendUserMessage(content, options) {\n            assertActive();\n            runtime.sendUserMessage(content, options);\n        },\n",
    "        sendUserMessage(content, options) {\n            assertActive();\n            runtime.sendUserMessage(content, options);\n        },\n        dispatchExtensionCommand(name, args = \"\", options = {}) {\n            assertActive();\n            return runtime.dispatchExtensionCommand(name, args, options);\n        },\n        submitUserMessage(content, options) {\n            assertActive();\n            return runtime.submitUserMessage(content, options);\n        },\n", "Node API methods");
  let runner = read(`${core}/extensions/runner.js`);
  runner = replaceOnce(runner, "        this.runtime.sendUserMessage = actions.sendUserMessage;\n", "        this.runtime.sendUserMessage = actions.sendUserMessage;\n        this.runtime.dispatchExtensionCommand = actions.dispatchExtensionCommand;\n        this.runtime.submitUserMessage = actions.submitUserMessage;\n", "Node runtime bindings");
  let session = read(`${core}/agent-session.js`);
  session = replaceOnce(session, "            appendEntry: (customType, data) => {\n", "            dispatchExtensionCommand: (name, args, options) => this.dispatchExtensionCommand(name, args, options),\n            submitUserMessage: (content, options) => this.submitUserMessage(content, options),\n            appendEntry: (customType, data) => {\n", "Node session actions");
  session = insertMethods(session, "    async _tryExecuteExtensionCommand(text) {", "    /**\n     * Expand skill commands", "Node dispatch");
  return [[`${core}/extensions/loader.js`, loader], [`${core}/extensions/runner.js`, runner], [`${core}/agent-session.js`, session]];
}
function patchBundle(path) {
  let bundle = read(path);
  bundle = replaceOnce(bundle,
    "runtime={sendMessage:notInitialized,sendUserMessage:notInitialized,appendEntry:notInitialized,",
    "runtime={sendMessage:notInitialized,sendUserMessage:notInitialized,dispatchExtensionCommand:notInitialized,submitUserMessage:notInitialized,appendEntry:notInitialized,", "Bun runtime stubs");
  bundle = replaceOnce(bundle,
    "sendUserMessage(content,options){assertActive(),runtime.sendUserMessage(content,options)},appendEntry(customType,data){",
    "sendUserMessage(content,options){assertActive(),runtime.sendUserMessage(content,options)},dispatchExtensionCommand(name,args=\"\",options={}){return assertActive(),runtime.dispatchExtensionCommand(name,args,options)},submitUserMessage(content,options){return assertActive(),runtime.submitUserMessage(content,options)},appendEntry(customType,data){", "Bun API methods");
  bundle = replaceOnce(bundle,
    "this.runtime.sendUserMessage=actions.sendUserMessage,this.runtime.appendEntry=actions.appendEntry,",
    "this.runtime.sendUserMessage=actions.sendUserMessage,this.runtime.dispatchExtensionCommand=actions.dispatchExtensionCommand,this.runtime.submitUserMessage=actions.submitUserMessage,this.runtime.appendEntry=actions.appendEntry,", "Bun runtime bindings");
  bundle = replaceOnce(bundle,
    "sendUserMessage:(content,options)=>{this.sendUserMessage(content,options).catch(err=>{runner.emitError({extensionPath:\"<runtime>\",event:\"send_user_message\",error:err instanceof Error?err.message:String(err)})})},appendEntry:(customType,data)=>{",
    "sendUserMessage:(content,options)=>{this.sendUserMessage(content,options).catch(err=>{runner.emitError({extensionPath:\"<runtime>\",event:\"send_user_message\",error:err instanceof Error?err.message:String(err)})})},dispatchExtensionCommand:(name,args,options)=>this.dispatchExtensionCommand(name,args,options),submitUserMessage:(content,options)=>this.submitUserMessage(content,options),appendEntry:(customType,data)=>{", "Bun session actions");
  return [path, insertMethods(bundle, "async _tryExecuteExtensionCommand(text){", "_expandSkillCommand(text){", "Bun dispatch")];
}
function patchTypes(path) {
  let types = read(path);
  types = replaceOnce(types, "export interface ExtensionAPI {\n", `export type ExtensionCommandNotification = { message: string; type: "info" | "warning" | "error" };
export type ExtensionCommandDispatchResult =
    | { status: "completed"; notifications: ExtensionCommandNotification[] }
    | { status: "failed"; error: { message: string }; notifications: ExtensionCommandNotification[] }
    | { status: "not_found"; notifications: [] };
export interface ExtensionAPI {
`, "result types");
  const anchor = "    /** Register a custom command. */\n    registerCommand(name: string, options: Omit<RegisteredCommand, \"name\" | \"sourceInfo\">): void;\n";
  types = replaceOnce(types, anchor, anchor + `    /** Await an extension command's actual outcome, with invocation-scoped UI policy. */
    dispatchExtensionCommand(name: string, args?: string, options?: { allowDialogs?: boolean; onNotify?: (message: string, type: "info" | "warning" | "error") => void }): Promise<ExtensionCommandDispatchResult>;
    /** Await prompt admission, not generation. Input hooks may consume the message. */
    submitUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): Promise<{ disposition: "handled" | "queued" | "started" }>;
`, "API method types");
  return [path, types];
}
const core = ["dist/core", "node_modules/@earendil-works/pi-coding-agent/dist/core", "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent/dist/core"].find(candidate => existsSync(join(root, candidate, "agent-session.js")));
if (!core) throw new Error("Command feedback patch: SDK dist/core not found");
const types = `${core}/extensions/types.d.ts`;
const chunks = readdirSync(join(root, "dist/bundle/chunks")).filter(name => name.endsWith(".js") && read(`dist/bundle/chunks/${name}`).includes("async _tryExecuteExtensionCommand(text){"));
if (chunks.length !== 1) throw new Error(`Command feedback patch: expected one native runtime chunk, found ${chunks.length}`);
// Validate every release anchor before modifying any file.
const writes = [...patchNode(core), patchBundle(`dist/bundle/chunks/${chunks[0]}`), patchTypes(types)];
for (const [path, contents] of writes) writeFileSync(join(root, path), contents);
console.log(`Pi command feedback and prompt admission patched: ${core}, ${chunks[0]}`);
