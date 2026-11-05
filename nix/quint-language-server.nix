# Adapted from taugoust/flake-templates at ab2a17e, quint/nix/quint-language-server.nix.
{
  lib,
  buildNpmPackage,
  quint,
}:

buildNpmPackage {
  pname = "quint-language-server";
  version = "0.19.0";

  # Use this repository's pinned Quint release, not a separate toolchain input.
  inherit (quint) src;
  sourceRoot = "${quint.src.name}/vscode/quint-vscode/server";
  npmDepsHash = "sha256-BT5KN9E5aRUIJQR0zGlT00tDmRpS2oFF/yOdQOPIGgQ=";
  npmBuildScript = "compile";

  # The standalone server does not include the enclosing VS Code client workspace.
  postPatch = ''
    substituteInPlace src/complete.ts \
      --replace-fail "from 'vscode-languageclient'" "from 'vscode-languageserver'"
  '';

  meta = {
    description = "Language server for the Quint specification language";
    homepage = "https://github.com/quint-co/quint";
    license = lib.licenses.asl20;
    mainProgram = "quint-language-server";
    platforms = lib.platforms.unix;
  };
}
