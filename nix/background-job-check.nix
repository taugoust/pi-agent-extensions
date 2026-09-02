{ self, pkgs }:

let
  moduleResult = pkgs.lib.evalModules {
    modules = [
      {
        options.home.packages = pkgs.lib.mkOption {
          type = pkgs.lib.types.listOf pkgs.lib.types.package;
          default = [ ];
        };
        options.home.file = pkgs.lib.mkOption {
          type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
          default = { };
        };
      }
      self.homeManagerModules.default
      {
        programs.pi.enable = true;
        programs.pi.package = null;
        programs.pi.extensions.background-job.enable = true;
      }
    ];
    specialArgs = { inherit pkgs; };
  };
  moduleFiles = moduleResult.config.home.file;
  modulePackages = moduleResult.config.home.packages;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.extensions;
in
pkgs.runCommand "background-job-extension-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.jq
      pkgs.nodejs
      pkgs.tmux
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/background-job-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir/background-job" "$srcdir/shared" "$outdir/background-job" "$workdir/home" "$workdir/tmp"
    cp ${self}/background-job/{index.ts,manager.ts,store.ts,tmux.ts,types.ts,test.mjs,runner.mjs} "$srcdir/background-job/"
    cp ${self}/shared/agentsh-mode.ts "$srcdir/shared/agentsh-mode.ts"
    printf '%s\n' '{"type":"module"}' > "$srcdir/package.json"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/background-job/index.ts" \
      "$srcdir/background-job/manager.ts" \
      "$srcdir/background-job/store.ts" \
      "$srcdir/background-job/tmux.ts" \
      "$srcdir/background-job/types.ts" \
      "$srcdir/shared/agentsh-mode.ts"
    cp "$srcdir/background-job/test.mjs" "$outdir/background-job/test.mjs"

    export HOME="$workdir/home"
    export TMPDIR="$workdir/tmp"
    export TEST_TMUX=${pkgs.tmux}/bin/tmux
    export TEST_RUNNER=${package}/background-job/runner.mjs
    node "$outdir/background-job/test.mjs"

    mkdir -p "$outdir/node_modules/@sinclair/typebox" \
      "$outdir/node_modules/@mariozechner/pi-coding-agent" \
      "$outdir/node_modules/@mariozechner/pi-tui"
    for packageName in @sinclair/typebox @mariozechner/pi-coding-agent @mariozechner/pi-tui; do
      cat > "$outdir/node_modules/$packageName/package.json" <<EOF
    { "name": "$packageName", "type": "module", "main": "./index.js" }
    EOF
    done
    cat > "$outdir/node_modules/@sinclair/typebox/index.js" <<'EOF'
    const make = (...args) => ({ args });
    export const Type = new Proxy({}, { get: () => make });
    EOF
    cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
    export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
    EOF
    cat > "$outdir/node_modules/@mariozechner/pi-tui/index.js" <<'EOF'
    export class Text { constructor(text) { this.text = text; } }
    EOF
    cat > "$workdir/contract.mjs" <<'EOF'
    process.env.PI_SUPERVISED = "1";
    const extension = (await import("./out/background-job/index.js")).default;
    const tools = new Map();
    const commands = new Map();
    const handlers = new Map();
    const pi = {
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      on(name, handler) { handlers.set(name, handler); },
      sendMessage() {},
    };
    extension(pi);
    if (tools.size !== 1 || !tools.has("background_job")) throw new Error("extension did not register exactly one background_job tool");
    if (!commands.has("background-jobs")) throw new Error("extension did not register its human job manager");
    let blocked = false;
    try {
      await tools.get("background_job").execute("start-1", { action: "start", command: "printf forbidden" }, undefined, undefined, { cwd: process.cwd(), sessionManager: {} });
    } catch (error) {
      blocked = String(error).includes("refusing native");
    }
    if (!blocked) throw new Error("full AgentSH selection did not fail closed before native background execution");

    delete process.env.PI_SUPERVISED;
    globalThis.__paeCommandAuthorityV1 = { protocol: 1, active: true, consume: () => false };
    const nativeExtension = (await import("./out/background-job/index.js?native-contract")).default;
    const nativeTools = new Map();
    nativeExtension({
      registerTool(tool) { nativeTools.set(tool.name, tool); },
      registerCommand() {},
      on() {},
      sendMessage() {},
    });
    let receiptBlocked = false;
    try {
      await nativeTools.get("background_job").execute("start-mutated", { action: "start", command: "printf mutated" }, undefined, undefined, {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "native-session" },
      });
    } catch (error) {
      receiptBlocked = String(error).includes("authorization receipt");
    }
    if (!receiptBlocked) throw new Error("background start was not bound to an exact Permission Gate receipt");
    delete globalThis.__paeCommandAuthorityV1;
    EOF
    PI_CODING_AGENT_DIR="$workdir/agent" node "$workdir/contract.mjs"

    test -d ${moduleFiles.".pi/agent/extensions/background-job".source}
    test -f ${moduleFiles.".pi/agent/extensions/background-job".source}/index.ts
    test -f ${moduleFiles.".pi/agent/extensions/shared".source}/agentsh-mode.ts
    test ${toString (builtins.elem pkgs.tmux modulePackages)} = 1

    test -f ${package}/background-job/index.ts
    test -f ${package}/background-job/runner.mjs
    test -f ${package}/shared/agentsh-mode.ts
    test "$(jq '[.pi.extensions[] | select(. == "background-job")] | length' ${self}/package.json)" = 1
    test "$(jq '[.pi.extensions[] | select(. == "background-job")] | length' ${package}/package.json)" = 1

    mkdir -p "$out"
    touch "$out/passed"
  ''
