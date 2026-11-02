import * as fs from "node:fs";
import * as path from "node:path";

export function trustedNixStoreFile(candidate: string, executable = false): string | undefined {
  try {
    const resolved = fs.realpathSync(candidate), info = fs.statSync(resolved);
    if (!resolved.startsWith("/nix/store/") || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return undefined;
    if (executable) fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch { return undefined; }
}

type Authority = {
  trustedFile(candidate: string, executable?: boolean): string | undefined;
  readManifest(file: string): { name?: unknown; bin?: unknown };
};
const authority: Authority = { trustedFile: trustedNixStoreFile, readManifest: file => JSON.parse(fs.readFileSync(file, "utf8")) };

/** Follow only this process's immutable runtime and the declared Pi CLI; never PATH or PI_SUBAGENT_BIN. */
export function guardedPiInvocation(args: string[], executable = "/proc/self/exe", script = process.argv[1], trust: Authority = authority): { command: string; args: string[] } {
  const command = trust.trustedFile(executable, true);
  if (!command) throw new Error("Guarded native subagents require an immutable Nix-store executable");
  if (!/^(node|bun)(\.exe)?$/i.test(path.basename(command))) return { command, args };
  const cli = script && trust.trustedFile(script);
  if (cli) for (const relative of ["dist/cli.js", "dist/bundle/cli.js"]) {
    const root = path.resolve(path.dirname(cli), ...Array(relative.split("/").length - 1).fill(".."));
    if (path.join(root, relative) !== cli) continue;
    const manifest = trust.trustedFile(path.join(root, "package.json"));
    if (!manifest || manifest !== path.join(root, "package.json")) continue;
    try {
      const pkg = trust.readManifest(manifest);
      if (!["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"].includes(pkg.name as string)) continue;
      const bin = pkg.bin as { pi?: unknown } | undefined;
      if (!bin || typeof bin !== "object" || bin.pi !== relative) continue;
      return { command, args: [cli, ...args] };
    } catch { /* Refuse unverifiable package metadata. */ }
  }
  throw new Error("Guarded native subagents require an immutable declared Pi CLI alongside the Node/Bun runtime");
}
