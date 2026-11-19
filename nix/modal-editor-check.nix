{ self, pkgs }:

pkgs.runCommand "modal-editor-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./modal-editor-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./modal-editor-check.sh}
  ''
