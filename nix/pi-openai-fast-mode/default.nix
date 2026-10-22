{
  fetchurl,
  lib,
  stdenvNoCC,
  src ? fetchurl {
    url = "https://registry.npmjs.org/pi-openai-fast-mode/-/pi-openai-fast-mode-0.3.0.tgz";
    hash = "sha256-xOKmU/45Qny4X/19wa18d8ZPxgXyW/BfswExIgr+bRQ=";
  },
}:

stdenvNoCC.mkDerivation {
  pname = "pi-openai-fast-mode";
  version = "0.3.0";
  inherit src;

  # Works with both the npm tarball and the pinned upstream source input.
  patches = [ ./managed-defaults.patch ];
  postPatch = ''
    awk '
      1;
      /let currentModel: ModelRef \| undefined;/ {
        found++;
        while ((getline line < "${./control.ts.inc}") > 0) print line;
        close("${./control.ts.inc}");
      }
      END { if (found != 1) exit 1; }
    ' src/index.ts > src/index.ts.new
    mv src/index.ts.new src/index.ts
  '';

  dontConfigure = true;
  dontBuild = true;
  doCheck = false;
  doInstallCheck = false;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -R . "$out/"
    runHook postInstall
  '';

  meta = {
    description = "Pi OpenAI Fast Mode with managed defaults and session-scoped operator control";
    homepage = "https://github.com/johncmunson/pi-openai-fast-mode";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
