{ self, pkgs }:
let
  moduleResult = (import ./module-test-harness.nix { inherit self pkgs; }).evaluate {
    agentDir = ".pi/agent";
    extensions.questionnaire.enable = true;
  };
  moduleFiles = moduleResult.home.file;
  questionnaireBundle = self.packages.${pkgs.stdenv.hostPlatform.system}.example-auto-extensions;
in
pkgs.runCommand "questionnaire-check"
  {
    src = self;
    fixtures = ./questionnaire-check;
    inherit questionnaireBundle;
    moduleFileCount = toString (builtins.length (builtins.attrNames moduleFiles));
    moduleShared = moduleFiles.".pi/agent/extensions/shared".source;
    moduleQuestionnaire = moduleFiles.".pi/agent/extensions/questionnaire".source;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./questionnaire-check.sh}
  ''
