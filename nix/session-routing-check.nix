{ self, pkgs }:
pkgs.runCommand "pi-session-routing-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME" src/shared src/openai-accounts src/subagent out
    cp ${self}/shared/session-routing.ts ${self}/shared/session-routing.test.ts src/shared/
    cp ${self}/shared/subagent-routing.ts ${self}/shared/subagent-routing.test.ts ${self}/shared/account-controls.ts src/shared/
    cp ${self}/shared/model-tiers.ts ${self}/shared/extension-defaults.ts ${self}/shared/extension-config-manifest.json src/shared/
    cp ${self}/subagent/config.ts ${self}/subagent/config.test.ts ${self}/subagent/coordinator-role.ts src/subagent/
    substituteInPlace src/shared/extension-defaults.ts \
      --replace-fail 'from "./extension-config-manifest.json";' 'from "./extension-config-manifest.json" with { type: "json" };'
    cp ${self}/openai-accounts/session-follower.ts ${self}/openai-accounts/session-follower.test.ts src/openai-accounts/
    printf '%s\n' '{"type":"module"}' > src/package.json
    tsc --noCheck --skipLibCheck --resolveJsonModule --rewriteRelativeImportExtensions \
      --module nodenext --moduleResolution nodenext --target es2022 \
      --rootDir src --outDir out \
      src/shared/session-routing.test.ts src/openai-accounts/session-follower.test.ts \
      src/shared/subagent-routing.test.ts src/subagent/config.test.ts
    cp src/package.json out/package.json
    mkdir -p out/node_modules/@earendil-works/pi-coding-agent
    printf '%s\n' '{"type":"module","main":"./index.js"}' > out/node_modules/@earendil-works/pi-coding-agent/package.json
    printf '%s\n' 'export const getAgentDir = () => process.env.HOME;' > out/node_modules/@earendil-works/pi-coding-agent/index.js
    node --test out/shared/session-routing.test.js out/openai-accounts/session-follower.test.js \
      out/shared/subagent-routing.test.js out/subagent/config.test.js
    touch "$out"
  ''
