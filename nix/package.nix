{ self, pkgs, pi-mcp-adapter ? null }:

pkgs.runCommand "pi-agent-extensions" { } ''
  mkdir -p $out

  # Simple single-file extensions
  for ext in agent-events direnv fence mac-system-theme modal-editor pager permission-gate questionnaire sandbox slow-mode ssh; do
    mkdir -p $out/$ext
    cp ${self}/$ext/index.ts $out/$ext/
  done

  # fetch: source only (dependencies installed at runtime via bun)
  mkdir -p $out/fetch
  cp ${self}/fetch/index.ts $out/fetch/
  cp ${self}/fetch/package.json $out/fetch/

  # Skills
  cp -r ${self}/skills $out/

  # package.json for pi package discovery
  cp ${self}/package.json $out/

  # Optional: expose pi-mcp-adapter from flake input as a bundled extension source.
  # Note: this is source-only and still expects its runtime JS deps to be resolvable.
  ${if pi-mcp-adapter != null then ''
    mkdir -p $out/node_modules
    cp -r ${pi-mcp-adapter} $out/node_modules/pi-mcp-adapter
  '' else ""}
''
