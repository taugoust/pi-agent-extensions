{
  self,
  pkgs,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:
{
  package = import ./package.nix {
    inherit
      self
      pkgs
      pi-mcp-adapter
      pi-openai-fast-mode
      ;
  };
  format = import ./format-check.nix { inherit self pkgs; };
  fetch = import ./fetch-check.nix { inherit self pkgs; };
  http-transport = import ./http-transport-check.nix { inherit self pkgs; };
  session-routing = import ./session-routing-check.nix { inherit self pkgs; };
  ssh = import ./ssh-check.nix { inherit self pkgs; };
  questionnaire = import ./questionnaire-check.nix { inherit self pkgs; };
  slow-mode = import ./slow-mode-check.nix { inherit self pkgs; };
  fence = import ./fence-check.nix { inherit self pkgs; };
  direnv = import ./direnv-check.nix { inherit self pkgs; };
  permission-gate = import ./permission-gate-check.nix { inherit self pkgs; };
  pdf = import ./pdf-check.nix { inherit self pkgs; };
  reload-on-deploy = import ./reload-on-deploy-check.nix { inherit self pkgs; };
  sandbox = import ./sandbox-check.nix { inherit self pkgs; };
}
