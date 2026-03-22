{ self, bun2nix, pkgs }:
let
  pkgsWithBun2nix = pkgs.extend bun2nix.overlays.default;

  sandbox = pkgsWithBun2nix.stdenv.mkDerivation {
    pname = "pae-sandbox";
    version = "1.0.0";
    src = "${self}/sandbox";

    nativeBuildInputs = [ pkgsWithBun2nix.bun2nix.hook ];

    bunDeps = pkgsWithBun2nix.bun2nix.fetchBunDeps {
      bunNix = "${self}/sandbox/bun.nix";
    };

    dontUseBunBuild = true;
    bunInstallFlags = [
      "--linker=hoisted"
      "--backend=copyfile"
    ];

    installPhase = ''
      mkdir -p $out
      cp index.ts $out/
      cp -r node_modules $out/
    '';
  };
in
pkgs.runCommand "pi-agent-extensions" { } ''
  mkdir -p $out

  # Simple single-file extensions
  for ext in fence mac-system-theme modal-editor pager permission-gate questionnaire slow-mode; do
    mkdir -p $out/$ext
    cp ${self}/$ext/index.ts $out/$ext/
  done

  # sandbox: pre-built with npm dependencies
  cp -r ${sandbox} $out/sandbox

  # fetch: source only (dependencies installed at runtime via bun)
  mkdir -p $out/fetch
  cp ${self}/fetch/index.ts $out/fetch/
  cp ${self}/fetch/package.json $out/fetch/

  # Skills
  cp -r ${self}/skills $out/

  # package.json for pi package discovery
  cp ${self}/package.json $out/
''
