{ self, pkgs }:
let
  inherit (pkgs) lib;
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate valid;
  make =
    enabled: model:
    evaluate {
      agentDir = ".config/fixture-pi";
      extensions.idle-context-warning = {
        enable = enabled;
        cheapCompactionModel = model;
        guardedModels = if model == null then { } else { astra = "fixture/expensive"; };
      };
    };
  configured = make true "fixture/cheap:low";
  defaults = make true null;
  disabled = make false "fixture/cheap:low";
  configFile = ".config/fixture-pi/defaults/idle-context-warning.json";
  sourceDir = ".config/fixture-pi/extensions/idle-context-warning";
  decode = config: builtins.fromJSON config.home.file.${configFile}.text;
  expected = {
    idleMinutes = 30;
    contextPercent = 20;
    cheapCompactionModel = "fixture/cheap:low";
    guardedModels.astra = "fixture/expensive";
  };
in
assert valid configured && valid defaults && valid disabled;
assert decode configured == expected;
assert
  decode defaults == (
    expected
    // {
      cheapCompactionModel = null;
      guardedModels = { };
    }
  );
assert !(disabled.home.file ? ${configFile}) && !(disabled.home.file ? ${sourceDir});
assert !(configured.home.file ? ".config/fixture-pi/idle-context-warning.json");
assert !(configured.home.file ? ".config/fixture-pi/extensions/idle-context-warning.json");
assert configured.home.sessionVariables.PI_CODING_AGENT_DIR == "/fixture-home/.config/fixture-pi";
pkgs.runCommand "idle-context-warning-module-contract" { } ''
  for file in index.ts policy.ts admission.ts compaction.ts migration.ts; do
    test -f ${configured.home.file.${sourceDir}.source}/"$file"
  done
  printf '%s\n' ${lib.escapeShellArg (builtins.toJSON expected)} > "$out"
''
