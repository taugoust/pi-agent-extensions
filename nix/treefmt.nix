# Formatters for `nix fmt` and the `format` check.
{
  projectRootFile = "flake.nix";

  # oxfmt reads .oxfmtrc.json from the repository root.
  programs.oxfmt.enable = true;
  programs.nixfmt.enable = true;
  programs.shfmt.enable = true;

  # Vendored dependencies are kept byte-for-byte.
  settings.global.excludes = [ "**/node_modules/**" ];

  settings.formatter.oxfmt.excludes = [
    "**/*.gen.ts"
    "**/*.gen.tsx"
    "btw/candidate-runtime.ts"
  ];
}
