{
  pkgs,
  self,
  piPackage,
  extensionBundle,
}:
let
  bundle = import ./mk-extension-bundle.nix {
    inherit self;
    inherit (pkgs) lib;
  };
  workflowsOnly = bundle {
    inherit pkgs;
    name = "pi-workflows-only-runtime";
    extensions = [ "workflows" ];
  };
  subagentOnly = bundle {
    inherit pkgs;
    name = "pi-subagent-only-runtime";
    extensions = [ "subagent" ];
  };
in
pkgs.runCommand "workflows-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs_24
      pkgs.git
    ];
  }
  ''
    source ${./workflows-runtime-check.sh} \
      ${self} ${piPackage} ${extensionBundle} ${workflowsOnly} ${subagentOnly}
  ''
