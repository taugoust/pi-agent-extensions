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
    for f in subagent-routing.ts subagent-routing.test.ts account-controls.ts \
      model-tiers.ts extension-defaults.ts extension-config-manifest.json; do
      cp ${self}/shared/$f src/shared/
    done
    for f in config.ts config.test.ts coordinator-role.ts; do
      cp ${self}/subagent/$f src/subagent/
    done
    # Node needs an import attribute to load JSON.
    manifest='"./extension-config-manifest.json"'
    substituteInPlace src/shared/extension-defaults.ts \
      --replace-fail "from $manifest;" "from $manifest with { type: \"json\" };"
    cp ${self}/openai-accounts/session-follower.ts ${self}/openai-accounts/session-follower.test.ts src/openai-accounts/
    printf '%s\n' '{"type":"module"}' > src/package.json
    tsc --noCheck --skipLibCheck --resolveJsonModule --rewriteRelativeImportExtensions \
      --module nodenext --moduleResolution nodenext --target es2022 \
      --rootDir src --outDir out \
      src/shared/session-routing.test.ts src/openai-accounts/session-follower.test.ts \
      src/shared/subagent-routing.test.ts src/subagent/config.test.ts
    cp src/package.json out/package.json
    # config.ts only needs getAgentDir from Pi.
    pi=out/node_modules/@earendil-works/pi-coding-agent
    mkdir -p $pi
    echo '{"type":"module","main":"./index.js"}' > $pi/package.json
    echo 'export const getAgentDir = () => process.env.HOME;' > $pi/index.js
    node --test out/shared/session-routing.test.js out/openai-accounts/session-follower.test.js \
      out/shared/subagent-routing.test.js out/subagent/config.test.js
    touch "$out"
  ''
