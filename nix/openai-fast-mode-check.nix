{
  self,
  pkgs,
  pi-openai-fast-mode,
}:
let
  bundle = self.lib.mkExtensionBundle {
    inherit pkgs;
    name = "openai-fast-mode-deduplicated-bundle";
    packageName = "openai-fast-mode-deduplicated-bundle";
    extensions = [
      "openai-fast-mode"
      "openai-fast-mode"
    ];
  };
  defaultBundle = self.packages.${pkgs.stdenv.hostPlatform.system}.extensions;
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
  inherit
    (import ./module-test-harness.nix {
      inherit self pkgs;
      module = self.homeManagerModules.default;
    })
    evaluate
    ;
  hmBase = evaluate { };
  hmEnabled = evaluate { extensions.openai-fast-mode.enable = true; };
  hmFiles = hmEnabled.home.file;
in
pkgs.runCommand "openai-fast-mode-check"
  {
    nativeBuildInputs = [
      pkgs.jq
      pkgs.nodejs
      pkgs.python3
    ];
    inherit bundle defaultBundle pi;
    fastModePackage = pi-openai-fast-mode;
    hmEnabledByDefault = if hmBase.programs.pi.extensions.openai-fast-mode.enable then "1" else "0";
    hmFileCount = toString (builtins.length (builtins.attrNames hmFiles));
    hmFilesManifest = pkgs.writeText "hm-files.json" (
      builtins.toJSON (
        map (name: {
          inherit name;
          source = hmFiles.${name}.source or (pkgs.writeText "hm-file" hmFiles.${name}.text);
          recursive = hmFiles.${name}.recursive or false;
        }) (builtins.attrNames hmFiles)
      )
    );
    rpcTest = ./openai-fast-mode-check/rpc.py;
  }
  ''
    source ${./openai-fast-mode-check.sh}
  ''
