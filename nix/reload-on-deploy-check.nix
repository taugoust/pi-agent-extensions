{ self, pkgs }:
pkgs.runCommand "reload-on-deploy-check" { nativeBuildInputs = [ pkgs.bun ]; } ''
  cp -R ${self}/reload-on-deploy ./reload-on-deploy
  chmod -R u+w ./reload-on-deploy
  bun test ./reload-on-deploy/fingerprint.test.ts
  touch "$out"
''
