{ self, pkgs }:

let
  consumerNames = [
    "background-job"
    "direnv"
    "fetch"
    "pdf"
    "permission-gate"
    "sandbox"
    "ssh"
    "subagent"
  ];
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self;
    lib = pkgs.lib;
  };
  bundles = map (name: mkExtensionBundle {
    inherit pkgs;
    name = "agentsh-mode-${name}-bundle-check";
    extensions = [ name ];
  }) consumerNames;
  homeFilesFor = name:
    let
      evaluated = pkgs.lib.evalModules {
        modules = [
          {
            options.home.packages = pkgs.lib.mkOption {
              type = pkgs.lib.types.listOf pkgs.lib.types.package;
              default = [ ];
            };
            options.home.file = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
          }
          self.homeManagerModules.default
          {
            programs.pi.enable = true;
            programs.pi.package = null;
            programs.pi.extensions.${name}.enable = true;
          }
        ];
        specialArgs = { inherit pkgs; };
      };
    in
    evaluated.config.home.file;
in
pkgs.runCommand "agentsh-mode-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/agentsh-mode-check"
    mkdir -p "$workdir/src/shared" "$workdir/out"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
    printf '{"type":"module"}\n' > "$workdir/src/package.json"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$workdir/src" \
      --outDir "$workdir/out" \
      "$workdir/src/shared/agentsh-mode.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const mode = await import(pathToFileURL(path.join(process.argv[2], "shared/agentsh-mode.js")).href);
    const classify = mode.classifyAgentSHStartup;
    const runtime = mode.agentSHRuntimeDisposition;

    assert.deepEqual(classify({}), { kind: "native", protocol: "", startSupervisor: false });
    const fullSignals = [
      { PI_SUPERVISED: "1" },
      { PI_AUTO: "1" },
      { PI_AGENTSH_REMOTE: "ssh" },
      { PI_AGENTSH_READ_MODE: "supervised" },
      { AGENTSH_SESSION_SUPERVISOR: "unix:///run/agentsh.sock" },
      { PI_AGENTSH_MOCK_SUPERVISOR: "/run/mock.sock" },
      { PI_AGENTSH_ENABLE: "1" },
      { AGENTSH_CHILD_CAPABILITY: "capability" },
    ];
    for (const env of fullSignals) assert.equal(classify(env).kind, "full", JSON.stringify(env));
    assert.equal(classify({ PI_SUPERVISED: " 1 " }).kind, "full");
    assert.equal(classify({ PI_SUPERVISED: "true", PI_AGENTSH_ENABLE: "yes" }).kind, "native");
    assert.deepEqual(classify({ AGENTSH_PERMISSION_GATE_SOCKET: "/run/gate.sock" }), {
      kind: "guard-only", protocol: "permission-gate", startSupervisor: false,
    });
    assert.equal(classify({ AGENTSH_PERMISSION_GATE_SOCKET: "" }).kind, "guard-only");
    assert.deepEqual(classify({ AGENTSH_APPROVAL_UI_SOCKET: "/run/approval.sock" }), {
      kind: "guard-only", protocol: "legacy-approval-ui", startSupervisor: false,
    });
    assert.deepEqual(classify({ PI_AGENTSH_ENABLE: "1", AGENTSH_APPROVAL_UI_SOCKET: "/run/approval.sock" }), {
      kind: "full", protocol: "rest", startSupervisor: true,
    });
    const conflict = classify({
      PI_SUPERVISED: "1",
      AGENTSH_PERMISSION_GATE_SOCKET: "/run/gate.sock",
      AGENTSH_SESSION_SUPERVISOR: "unix:///run/supervisor.sock",
    });
    assert.deepEqual(conflict, { kind: "conflict", protocol: "rest", startSupervisor: false });
    assert.equal(classify({
      PI_AGENTSH_MOCK_SUPERVISOR: "/run/mock.sock",
      AGENTSH_SESSION_SUPERVISOR: "unix:///run/rest.sock",
    }).protocol, "mock-ndjson");

    const native = classify({});
    const guard = classify({ AGENTSH_PERMISSION_GATE_SOCKET: "/run/gate.sock" });
    const full = classify({ PI_SUPERVISED: "1" });
    assert.deepEqual(runtime(native), { kind: "native", protocol: "" });
    assert.deepEqual(runtime(guard), { kind: "guard-only", protocol: "permission-gate" });
    assert.equal(runtime(full).kind, "unavailable");
    assert.equal(runtime(conflict).kind, "unavailable");
    assert.deepEqual(runtime(full, {
      configured: true, active: true, protocol: "rest", status: "connected",
    }), { kind: "full", protocol: "rest" });
    assert.deepEqual(runtime(native, {
      configured: true, active: true, protocol: "mock-ndjson", status: "pending",
    }), { kind: "full", protocol: "mock-ndjson" });
    assert.equal(runtime(native, {
      configured: true, active: false, protocol: "rest", status: "error",
    }).kind, "unavailable");
    assert.equal(runtime(native, {
      configured: true, active: true, protocol: "rest", status: "error",
    }).kind, "unavailable");
    assert.equal(runtime(full, {
      configured: true, active: true, protocol: "legacy-approval-ui", status: "connected",
    }).kind, "unavailable");
    assert.deepEqual(runtime(native, {
      configured: true, active: true, protocol: "legacy-approval-ui", status: "connected",
    }), { kind: "guard-only", protocol: "legacy-approval-ui" });
    assert.deepEqual(runtime(native, { configured: true, active: true }), {
      kind: "full", protocol: "",
    });
    assert.equal(runtime(native, { configured: true, active: false }).kind, "unavailable");
    assert.equal(runtime(native, {
      configured: true, active: true, protocol: "", status: "connected",
    }).kind, "unavailable");
    assert.equal(runtime(classify({ AGENTSH_SESSION_SUPERVISOR: "unix:///run/old.sock" }), {
      configured: true, active: true, status: "connected",
    }).kind, "full");
    assert.equal(runtime(native, {
      configured: true, active: true, protocol: "unknown", status: "connected",
    }).kind, "unavailable");
    assert.equal(runtime(native, { configured: "yes", active: true }).kind, "unavailable");
    assert.equal(runtime(native, "malformed").kind, "unavailable");
    assert.equal(mode.agentSHSupervisorProtocol(guard), "");
    assert.equal(mode.agentSHSupervisorProtocol(classify({ PI_AGENTSH_ENABLE: "1" })), "rest");
    EOF

    node "$workdir/test.mjs" "$workdir/out"

    ${pkgs.lib.concatMapStringsSep "\n" (bundle: ''
      test -f ${bundle}/shared/agentsh-mode.ts
    '') bundles}

    ${pkgs.lib.concatMapStringsSep "\n" (name:
      let files = homeFilesFor name; in ''
        test -f ${files.".pi/agent/extensions/shared".source}/agentsh-mode.ts
      '') consumerNames}

    touch "$out"
  ''
