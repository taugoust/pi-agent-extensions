{
  self,
  pkgs,
  home-manager,
}:
let
  inherit (pkgs) lib;
  root = ".config-clara/pi";
  names = [
    "stamp"
    "openai-accounts"
    "shared"
  ];
  source =
    recursive:
    pkgs.runCommand "extension-source-${if recursive then "new" else "old"}" { } ''
      mkdir -p "$out"
      echo '${if recursive then "new" else "old"}' > "$out/index.ts"
    '';
  make =
    recursive: extra:
    (home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        self.homeManagerModules.default
        {
          home = {
            username = "fixture";
            homeDirectory = "/fixture-home";
            stateVersion = "26.05";
          };
          programs.pi = {
            enable = true;
            package = null;
            agentDir = root;
            extensions.stamp.enable = true;
            extensions.accounts.enable = true;
          };
          # Use tiny real sources: only the HM linking/activation contract matters.
          home.file = lib.genAttrs (map (name: "${root}/extensions/${name}") names) (_: {
            source = lib.mkForce (source recursive);
            recursive = lib.mkForce recursive;
          });
        }
        extra
      ];
    }).config;
  old = make false { };
  current = make true { };
  disabled = make true { home.file."${root}/extensions/stamp".enable = false; };
  redirected = make true { home.file."${root}/extensions/stamp".target = "custom/extensions/stamp"; };
  oldGeneration = pkgs.runCommand "home-manager-generation" { } ''
    mkdir "$out"
    ln -s ${old.home-files} "$out/home-files"
  '';
  newGeneration = pkgs.runCommand "home-manager-generation" { } ''
    mkdir "$out"
    ln -s ${current.home-files} "$out/home-files"
  '';
  contracts = pkgs.writeText "extension-migration-contracts.json" (
    builtins.toJSON {
      initialization = current.lib.bash.initHomeManagerLib;
      migration = current.home.activation.piMigrateExtensionLinks.data;
      collision = current.home.activation.checkLinkTargets.data;
      linking = current.home.activation.linkGeneration.data;
      inherit root names;
    }
  );
in
assert current.home.activation.piMigrateExtensionLinks.before == [ "checkLinkTargets" ];
assert current.home.file."${root}/extensions/openai-accounts".recursive;
assert !(current.home.file ? "${root}/extensions/accounts");
assert
  !(lib.hasInfix "${root}/extensions/stamp" disabled.home.activation.piMigrateExtensionLinks.data);
assert
  !(lib.hasInfix "${root}/extensions/stamp" redirected.home.activation.piMigrateExtensionLinks.data);
pkgs.runCommand "extension-link-migration-check"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.bash
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
      pkgs.gettext
    ];
  }
  ''
    export PYTHONDONTWRITEBYTECODE=1
    python3 ${./test-extension-link-migration.py} \
      ${./migrate-extension-links.py} ${contracts} ${oldGeneration} ${newGeneration} \
      ${current.home.activationPackage}/activate
    touch "$out"
  ''
