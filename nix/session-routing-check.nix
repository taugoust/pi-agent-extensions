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
    mkdir -p "$HOME" src/shared src/openai-accounts out
    cp ${self}/shared/session-routing.ts ${self}/shared/session-routing.test.ts src/shared/
    cp ${self}/openai-accounts/session-follower.ts ${self}/openai-accounts/session-follower.test.ts src/openai-accounts/
    printf '%s\n' '{"type":"module"}' > src/package.json
    tsc --noCheck --skipLibCheck --rewriteRelativeImportExtensions \
      --module nodenext --moduleResolution nodenext --target es2022 \
      --rootDir src --outDir out \
      src/shared/session-routing.test.ts src/openai-accounts/session-follower.test.ts
    cp src/package.json out/package.json
    node --test out/shared/session-routing.test.js out/openai-accounts/session-follower.test.js
    touch "$out"
  ''
