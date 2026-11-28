{ self, pkgs }:
pkgs.runCommand "sandbox-check"
  {
    src = self;
    fixtures = ./sandbox-check;
    nativeBuildInputs = [
      pkgs.bun
      # Real `git worktree add` fixture for auto-approval worktree detection.
      pkgs.git
      pkgs.nodejs
      pkgs.typescript
    ];
    recoverySuccess = pkgs.writeShellScript "pi-agentsh-recovery-success" ''
      source ${./sandbox-check/recovery-success.sh} ${pkgs.jq}
    '';
    recoveryAutomatic = pkgs.writeShellScript "pi-agentsh-recovery-automatic" ''
      source ${./sandbox-check/recovery-automatic.sh} ${pkgs.jq} ${pkgs.coreutils}
    '';
    recoveryFailure = pkgs.writeShellScript "pi-agentsh-recovery-failure" ''
      source ${./sandbox-check/recovery-failure.sh}
    '';
    recoverySwap = pkgs.writeShellScript "pi-agentsh-recovery-swap" ''
      source ${./sandbox-check/recovery-swap.sh} ${pkgs.coreutils}
    '';
    localStart = pkgs.writeShellScript "pi-agentsh-local-start" ''
      source ${./sandbox-check/local-start.sh}
    '';
    recoverySlow = pkgs.writeShellScript "pi-agentsh-recovery-slow" ''
      source ${./sandbox-check/recovery-slow.sh} ${pkgs.coreutils}
    '';
  }
  ''
    source ${./sandbox-check.sh}
  ''
