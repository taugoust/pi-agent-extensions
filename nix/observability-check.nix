{ self, pkgs }:
let
  inherit (pkgs) lib;
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate valid;
  names = [
    "stamp"
    "progress"
    "cache-hit-monitor"
  ];
  enabled = lib.genAttrs names (name: evaluate { extensions.${name}.enable = true; });
  disabled = evaluate { };
  configured = evaluate {
    extensions.stamp = {
      enable = true;
      visibleByDefault = false;
      settings.visibleByDefault = true;
    };
    extensions.cache-hit-monitor = {
      enable = true;
      visibleByDefault = true;
    };
    extensions.progress = {
      enable = true;
      settings = {
        showCompleted = false;
        maxVisibleItems = 3;
      };
    };
  };
  decode = config: name: builtins.fromJSON config.home.file.".pi/agent/defaults/${name}.json".text;
  runtime = import ./progress-settings-check.nix { inherit self pkgs; };
  shared = configured.home.file.".pi/agent/extensions/shared".source;
in
assert valid disabled && valid configured && lib.all (name: valid enabled.${name}) names;
assert lib.all (
  name:
  enabled.${name}.home.file ? ${".pi/agent/extensions/${name}"}
  && enabled.${name}.home.file ? ".pi/agent/extensions/shared"
  && enabled.${name}.home.file ? ${".pi/agent/defaults/${name}.json"}
  && !(disabled.home.file ? ${".pi/agent/extensions/${name}"})
  && !(disabled.home.file ? ${".pi/agent/defaults/${name}.json"})
) names;
assert !(decode enabled.stamp "stamp").visibleByDefault;
assert !(decode enabled.cache-hit-monitor "cache-hit-monitor").visibleByDefault;
assert (decode configured "stamp").visibleByDefault;
assert (decode configured "cache-hit-monitor").visibleByDefault;
assert
  decode configured "progress" == {
    showCompleted = false;
    maxVisibleItems = 3;
  };
# Declarative defaults must not take ownership of writable user preferences.
assert lib.all (file: !(configured.home.file ? ${".pi/agent/${file}"})) [
  "pi-stamp.json"
  "stamp-display.json"
  "pi-progress.json"
  "cache-hit-monitor-display.json"
];
pkgs.runCommand "pi-observability-contract-check" { } ''
  ${lib.concatMapStringsSep "\n" (
    name: "test -f ${enabled.${name}.home.file.${".pi/agent/extensions/${name}"}.source}/index.ts"
  ) names}
  test -f ${shared}/observability.ts
  test -f ${shared}/extension-defaults.ts
  test -f ${shared}/extension-config-manifest.json
  mkdir "$out"
  ln -s ${runtime} "$out/progress-runtime"
  printf '%s\n' 'module ownership, visibility precedence and installed helper closure verified' > "$out/module-contract"
''
