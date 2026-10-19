{ self, pkgs }:
let
  inherit (pkgs) lib;
  evaluate = enabled: model:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ./module.nix { inherit self; })
        ({ ... }: {
          options.home.file = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
          options.home.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
          config.programs.pi = {
            enable = true;
            package = null;
            extensions.idle-context-warning = {
              enable = enabled;
              cheapCompactionModel = model;
            };
          };
        })
      ];
    }).config.home.file;
  configured = evaluate true "openai/gpt-6-luna:low";
  defaults = evaluate true null;
  disabled = evaluate false "openai/gpt-6-luna:low";
  configFile = ".pi/agent/extensions/idle-context-warning.json";
  sourceDir = ".pi/agent/extensions/idle-context-warning";
in
assert builtins.fromJSON configured.${configFile}.text == { cheapCompactionModel = "openai/gpt-6-luna:low"; };
assert builtins.fromJSON defaults.${configFile}.text == { cheapCompactionModel = null; };
assert !(disabled ? ${configFile});
assert lib.all (file: configured ? ${sourceDir + "/" + file}) [ "index.ts" "policy.ts" "compaction.ts" ];
pkgs.runCommand "idle-context-warning-config-check" { } ''
  test -f ${configured.${sourceDir + "/index.ts"}.source}
  test -f ${configured.${sourceDir + "/policy.ts"}.source}
  test -f ${configured.${sourceDir + "/compaction.ts"}.source}
  touch "$out"
''
