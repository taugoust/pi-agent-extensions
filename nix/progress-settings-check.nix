{
  self,
  pkgs,
  piSource ? self.packages.${pkgs.stdenv.hostPlatform.system}.pi.src,
}:

pkgs.runCommand "pi-progress-settings-behavior-check"
  {
    nativeBuildInputs = [
      pkgs.bun
      pkgs.python3
      pkgs.gnugrep
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export NO_COLOR=1
    mkdir -p "$PI_CODING_AGENT_DIR" src/progress src/shared \
      src/node_modules/@earendil-works/pi-coding-agent
    cp ${self}/progress/settings.ts ${self}/progress/settings.test.ts src/progress/
    cp ${self}/shared/extension-defaults.ts ${self}/shared/extension-config-manifest.json src/shared/
    cat > src/node_modules/@earendil-works/pi-coding-agent/package.json <<'EOF'
    { "name": "@earendil-works/pi-coding-agent", "type": "module", "main": "./index.js" }
    EOF
    # The only stub is the controlled root locator. Re-export the actual pinned
    # SDK queue from its immutable npm source (its imports are Node builtins).
    # No settings, filesystem, or scheduling behavior is reimplemented.
    cat > src/node_modules/@earendil-works/pi-coding-agent/index.js <<'EOF'
    export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
    export { withFileMutationQueue } from "${piSource}/dist/core/tools/file-mutation-queue.js";
    EOF
    bun test --timeout 10000 ./src/progress/settings.test.ts

    # Prove the explicit-preferences assertion is sensitive to a realistic bug:
    # accidentally serialize resolved settings (including inherited defaults).
    # Mutate only a disposable copy, never the original production source.
    cp -R src mutant
    chmod u+w mutant/progress/settings.ts
    python3 - <<'PY'
    from pathlib import Path
    path = Path("mutant/progress/settings.ts")
    text = path.read_text()
    old = "JSON.stringify(nextDocument, null, 2)"
    assert text.count(old) == 1
    path.write_text(text.replace(old, "JSON.stringify(settings, null, 2)"))
    PY
    if bun test --timeout 10000 --test-name-pattern 'saving writes only explicit preferences' \
      ./mutant/progress/settings.test.ts > mutant.log 2>&1; then
      cat mutant.log
      echo 'ERROR: resolved-defaults-persistence mutant survived' >&2
      exit 1
    fi
    grep -F '(fail) saving writes only explicit preferences' mutant.log
    echo 'KILLED: progress save persists resolved defaults instead of explicit preferences'
    touch "$out"
  ''
