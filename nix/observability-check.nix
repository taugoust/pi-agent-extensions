{ self, pkgs }:
let
  inherit (pkgs) lib;
  names = [
    "stamp"
    "progress"
    "cache-hit-monitor"
  ];
  evaluate =
    name: enabled:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ./module.nix { inherit self; })
        ({ ... }: {
          options.home.file = lib.mkOption {
            type = lib.types.attrsOf lib.types.anything;
            default = { };
          };
          options.home.packages = lib.mkOption {
            type = lib.types.listOf lib.types.package;
            default = [ ];
          };
          config.programs.pi = {
            enable = true;
            package = null;
            extensions.${name}.enable = enabled;
          };
        })
      ];
    }).config.home.file;
  directory = name: ".pi/agent/extensions/${name}";
in
assert lib.all (
  name:
  let
    files = evaluate name true;
  in
  files ? ${directory name} && files ? ".pi/agent/extensions/shared"
) names;
assert lib.all (name: !(evaluate name false ? ${directory name})) names;
pkgs.runCommand "pi-observability-config-check" { } ''
  ${lib.concatMapStringsSep "\n" (
    name: "test -f ${(evaluate name true).${directory name}.source}/index.ts"
  ) names}
  test -f ${self}/shared/observability.ts
  test -f ${self}/shared/terminal-text.ts
  touch "$out"
''
