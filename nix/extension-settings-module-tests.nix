# Unit-level module outputs, not a substitute for real Home Manager integration.
{ self, pkgs }:
let
  inherit (pkgs) lib;
  evaluate =
    pi:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ./module.nix { inherit self; })
        {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            home = {
              homeDirectory = lib.mkOption {
                type = lib.types.str;
                default = "/fixture-home";
              };
              file = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
              packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              sessionVariables = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
              };
              activation = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
            };
          };
          config.programs.pi = {
            enable = true;
            package = null;
          }
          // pi;
        }
      ];
    }).config;
  valid =
    config:
    let
      booleans = map (entry: entry.assertion) config.assertions;
    in
    builtins.deepSeq booleans (lib.all (value: value) booleans);
  absent = evaluate { };
  optedIn = evaluate {
    settings = { };
    models = { };
    keybindings = { };
    mcp = { };
  };
  names = [
    "settings"
    "models"
    "keybindings"
    "mcp"
  ];
  precedence = evaluate {
    extensions.idle-context-warning = {
      enable = true;
      idleMinutes = 40;
      guardedModels = {
        retained = "fixture/retained";
        override = "fixture/named";
      };
      settings = {
        idleMinutes = 12;
        guardedModels.override = "fixture/raw";
      };
    };
    extensions.subagent = {
      enable = true;
      defaultModel = "named-model";
      settings.defaultModel = "raw-model";
    };
  };
  idle = builtins.fromJSON precedence.home.file.".pi/agent/defaults/idle-context-warning.json".text;
  subagent = builtins.fromJSON precedence.home.file.".pi/agent/defaults/subagent.json".text;
  sandbox = evaluate { extensions.sandbox.enable = true; };
  withPackages = evaluate {
    settings.packages = [ "npm:fixture" ];
    packages = [
      "npm:fixture"
      "npm:second-fixture"
    ];
  };
  packagesJSON = builtins.fromJSON withPackages.home.file.".pi/agent/settings.json".text;
  badSubagent = [
    { defaultProvider = ""; }
    { defaultModel = "contains whitespace"; }
    { defaultModel = false; }
    { defaultThinkingLevel = "ultra"; }
    { allowedTools = [ "bash" ]; }
  ];
  badFastMode = [
    { enabled = "yes"; }
    { targets = [ "fixture" ]; }
  ];
in
assert valid absent && valid optedIn && valid precedence && valid sandbox && valid withPackages;
# Null is unmanaged, including absence of defaults artifacts; {} opts in.
assert lib.all (
  name:
  !(absent.home.file ? ${".pi/agent/${name}.json"})
  && !(absent.home.file ? ${".pi/agent/defaults/${name}.json"})
  && builtins.fromJSON optedIn.home.file.${".pi/agent/${name}.json"}.text == { }
  && builtins.fromJSON optedIn.home.file.${".pi/agent/defaults/${name}.json"}.text == { }
) names;
assert
  packagesJSON.packages == [
    "npm:fixture"
    "npm:second-fixture"
  ];
assert idle.idleMinutes == 12 && idle.contextPercent == 20;
assert
  idle.guardedModels == {
    retained = "fixture/retained";
    override = "fixture/raw";
  };
assert subagent.defaultModel == "raw-model" && subagent.defaultProvider == "openai";
assert lib.all (name: sandbox.home.file ? ${".pi/agent/extensions/${name}"}) [
  "sandbox"
  "subagent"
  "subagent-finalizer"
  "shared"
];
assert lib.all (name: builtins.elem name (map lib.getName sandbox.home.packages)) [
  "nodejs"
  "tmux"
];
# Evaluate every assertion boolean, not just the lazy module configuration.
assert lib.all (
  settings:
  !(valid (evaluate {
    extensions.subagent.settings = settings;
  }))
) badSubagent;
assert lib.all (
  settings:
  !(valid (evaluate {
    extensions.openai-fast-mode.settings = settings;
  }))
) badFastMode;
assert valid (evaluate {
  extensions.openai-fast-mode.settings.enabled = false;
});
true
