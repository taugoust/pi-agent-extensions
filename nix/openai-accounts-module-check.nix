{ self, pkgs }:
let
  inherit (pkgs) lib;
  evaluate =
    accounts: usage:
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
            extensions.accounts.enable = accounts;
            extensions.usage.enable = usage;
          };
        })
      ];
    }).config.home.file;
  both = evaluate true true;
  accountsOnly = evaluate true false;
  usageOnly = evaluate false true;
  neither = evaluate false false;
in
assert both ? ".pi/agent/extensions/shared";
assert accountsOnly ? ".pi/agent/extensions/shared";
assert usageOnly ? ".pi/agent/extensions/shared";
assert both ? ".pi/agent/extensions/openai-accounts";
assert both ? ".pi/agent/extensions/openai-usage";
assert !(accountsOnly ? ".pi/agent/extensions/openai-usage");
assert !(usageOnly ? ".pi/agent/extensions/openai-accounts");
assert !(neither ? ".pi/agent/extensions/openai-accounts");
assert !(neither ? ".pi/agent/extensions/openai-usage");
pkgs.runCommand "openai-accounts-module-check" { } ''
  test -f ${both.".pi/agent/extensions/openai-accounts".source}/index.ts
  test -f ${both.".pi/agent/extensions/openai-usage".source}/index.ts
  test -f ${self}/shared/account-controls.ts
  touch "$out"
''
