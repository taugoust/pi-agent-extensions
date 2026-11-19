{
  pkgs,
  self,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "openai-accounts-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs
    ];
  }
  ''
    source ${./openai-accounts-runtime-check.sh} ${self} ${piPackage} ${extensionBundle}
  ''
