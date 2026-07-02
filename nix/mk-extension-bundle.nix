{ self, lib, pi-mcp-adapter ? null }:

{
  pkgs,
  name ? "pi-extension-bundle",
  version ? "0.1.0",
  extensions ? [ ],
  skills ? [ ],
  prompts ? [ ],
  themes ? [ ],
  packageName ? name,
}:

let
  registry = import ./extension-registry.nix { inherit self pi-mcp-adapter; };

  extensionRegistry = registry.extensions;
  skillRegistry = registry.skills;

  unknownExtensions = lib.subtractLists (builtins.attrNames extensionRegistry) extensions;
  unknownSkills = lib.subtractLists (builtins.attrNames skillRegistry) skills;

  extensionEntries = map (extName:
    let
      entry = extensionRegistry.${extName};
    in
    if (entry ? requiresInput) && entry.source == null then
      throw "${packageName}: extension '${extName}' requires flake input '${entry.requiresInput}'"
    else
      entry // { name = extName; }
  ) extensions;

  skillEntries = map (skillName:
    skillRegistry.${skillName} // { name = skillName; }
  ) skills;

  copyExtensionCommands = lib.concatMapStringsSep "\n" (entry: ''
    mkdir -p "$out/$(dirname ${lib.escapeShellArg entry.manifestPath})"
    cp -R ${lib.escapeShellArg entry.source} "$out/${entry.manifestPath}"
    chmod -R u+rwX "$out/${entry.manifestPath}"
  '') extensionEntries;

  copySkillCommands = lib.concatMapStringsSep "\n" (entry: ''
    mkdir -p "$out/$(dirname ${lib.escapeShellArg entry.manifestPath})"
    cp -R ${lib.escapeShellArg entry.source} "$out/${entry.manifestPath}"
    chmod -R u+rwX "$out/${entry.manifestPath}"
  '') skillEntries;

  manifest = {
    name = packageName;
    inherit version;
    type = "module";
    keywords = [ "pi-package" ];
    pi = lib.filterAttrs (_: value: value != [ ]) {
      extensions = map (entry: entry.manifestPath) extensionEntries;
      skills = map (entry: entry.manifestPath) skillEntries;
      inherit prompts themes;
    };
  };
in
if unknownExtensions != [ ] then
  throw "${packageName}: unknown pi extension(s): ${lib.concatStringsSep ", " unknownExtensions}"
else if unknownSkills != [ ] then
  throw "${packageName}: unknown pi skill(s): ${lib.concatStringsSep ", " unknownSkills}"
else
  pkgs.runCommand name { } ''
    set -euo pipefail
    mkdir -p "$out"

    ${copyExtensionCommands}
    ${copySkillCommands}

    cat > "$out/package.json" <<'EOF'
    ${builtins.toJSON manifest}
    EOF
  ''
