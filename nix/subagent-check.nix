{ self, pkgs }:

let
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self;
    lib = pkgs.lib;
  };
  sandboxOnlyBundle = mkExtensionBundle {
    inherit pkgs;
    name = "sandbox-only-subagent-check-bundle";
    extensions = [ "sandbox" ];
  };
  subagentOnlyBundle = mkExtensionBundle {
    inherit pkgs;
    name = "subagent-only-finalizer-check-bundle";
    extensions = [ "subagent" ];
  };
in
pkgs.runCommand "subagent-check"
  {
    nativeBuildInputs = [
      pkgs.gnugrep
      pkgs.jq
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/subagent-check"
    mkdir -p "$workdir/src/subagent" "$workdir/src/shared" "$workdir/out"
    cp ${self}/subagent/backend.ts "$workdir/src/subagent/backend.ts"
    cp ${self}/subagent/parallel-result.ts "$workdir/src/subagent/parallel-result.ts"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$workdir/src" \
      --outDir "$workdir/out" \
      "$workdir/src/subagent/backend.ts" \
      "$workdir/src/subagent/parallel-result.ts" \
      "$workdir/src/shared/agentsh-mode.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";

    const imported = await import(pathToFileURL(process.argv[2]).href);
    const backend = await import(pathToFileURL(process.argv[3]).href);
    const mode = await import(pathToFileURL(process.argv[4]).href);
    const format = imported.formatParallelResultContent ?? imported.default?.formatParallelResultContent;
    const nativeStartup = mode.classifyAgentSHStartup({});
    const fullStartup = mode.classifyAgentSHStartup({ PI_SUPERVISED: "1" });
    assert.equal(typeof format, "function");
    assert.deepEqual(backend.selectSubagentBackend(undefined, nativeStartup), { kind: "native" });
    assert.deepEqual(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: false, active: false, protocol: "" }) }, nativeStartup), { kind: "native" });
    assert.deepEqual(backend.selectSubagentBackend(undefined, mode.classifyAgentSHStartup({ AGENTSH_PERMISSION_GATE_SOCKET: "/guard" })), { kind: "native" });
    assert.equal(backend.selectSubagentBackend({ subagentAdapter: {} }, nativeStartup).kind, "unavailable");
    const adapter = { execute() {}, detailsFailed() { return false; }, renderCall() {}, renderResult() {} };
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: true, protocol: "rest", status: "connected" }), subagentAdapter: adapter }, nativeStartup).kind, "agentsh");
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: false, active: true }), subagentAdapter: adapter }, nativeStartup).kind, "agentsh");
    assert.equal(backend.selectSubagentBackend(undefined, fullStartup).kind, "unavailable");
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: true, protocol: "rest", status: "connected" }), subagentAdapter: {} }, fullStartup).kind, "unavailable");
    const unavailable = backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: false, protocol: "rest", status: "connecting" }) }, nativeStartup);
    assert.equal(unavailable.kind, "unavailable");
    assert.match(unavailable.message, /native fallback is disabled/);
    assert.equal(backend.adaptiveDispositionError({ action: "review" }), "Draft disposition requires both action and draft_id");
    assert.equal(backend.adaptiveDispositionError({ action: "review", draft_id: "session-x" }), "Draft disposition requires mode=draft");
    assert.equal(backend.adaptiveDispositionError({ mode: "draft", action: "review", draft_id: "session-x" }), undefined);
    assert.equal(backend.nativeSubagentRequestSupported({ mode: "shared", task: "ok" }), true);
    assert.equal(backend.nativeSubagentRequestSupported({ mode: "draft", task: "no" }), false);
    assert.equal(backend.nativeSubagentRequestSupported({ mode: "draft", action: "review", draft_id: "session-x" }), false);

    const first = "first-start\n" + "a".repeat(4000) + "\nfirst-tail";
    const second = "second-start\n" + "b".repeat(4000) + "\nsecond-tail";
    const complete = format([
      { label: "task 1", status: "completed", output: first },
      { label: "task 2", status: "completed", output: second },
    ], 2);
    assert.match(complete, /first-tail/);
    assert.match(complete, /second-tail/);
    assert.ok(!complete.includes("completed: first-start\n" + "a".repeat(89) + "..."));

    const crowded = format(Array.from({ length: 8 }, (_, index) => ({
      label: `task ''${index + 1}`,
      status: "completed",
      output: `child-''${index + 1}-sentinel\n` + "🌍".repeat(20000),
    })), 8);
    assert.ok(Buffer.byteLength(crowded, "utf8") <= 50 * 1024);
    for (let index = 1; index <= 8; index++) {
      assert.match(crowded, new RegExp(`\\[task ''${index}\\] completed:`));
      assert.match(crowded, new RegExp(`child-''${index}-sentinel`));
    }
    assert.ok(!crowded.includes("�"), "UTF-8 truncation introduced a replacement character");
    EOF

    node "$workdir/test.mjs" "$workdir/out/subagent/parallel-result.js" "$workdir/out/subagent/backend.js" "$workdir/out/shared/agentsh-mode.js"
    grep -F 'formatParallelResultContent(sections, successCount, MAX_TEXT_PREVIEW_BYTES)' ${self}/subagent/index.ts >/dev/null
    grep -F '(cfg.extensions.sandbox.enable || cfg.extensions.subagent.enable)' ${self}/nix/module.nix >/dev/null
    grep -F 'builtins.elem "sandbox" extensions' ${self}/nix/mk-extension-bundle.nix >/dev/null
    grep -F '"''${extDir}/subagent/backend.ts".source = "''${self}/subagent/backend.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/parallel-result.ts".source = "''${self}/subagent/parallel-result.ts";' ${self}/nix/module.nix >/dev/null
    if grep -F 'name: "subagent"' ${self}/sandbox/index.ts >/dev/null; then
      echo 'sandbox still registers a duplicate subagent tool' >&2
      exit 1
    fi
    if grep -F 'function subagentParams' ${self}/sandbox/index.ts >/dev/null; then
      echo 'sandbox still owns a dead model-facing subagent schema' >&2
      exit 1
    fi
    for bundle in ${sandboxOnlyBundle} ${subagentOnlyBundle}; do
      test "$(jq '[.pi.extensions[] | select(. == "subagent")] | length' "$bundle/package.json")" -eq 1
      test "$(jq '[.pi.extensions[] | select(. == "subagent-finalizer")] | length' "$bundle/package.json")" -eq 1
      test -f "$bundle/subagent/index.ts"
      test -f "$bundle/subagent-finalizer/index.ts"
      test -f "$bundle/shared/agentsh-mode.ts"
    done
    test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' ${sandboxOnlyBundle}/package.json)" -eq 1
    test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' ${subagentOnlyBundle}/package.json)" -eq 0
    if grep -F 'output.slice(0, 100)' ${self}/subagent/index.ts >/dev/null; then
      echo 'parallel results still use the lossy 100-character preview' >&2
      exit 1
    fi
    touch "$out"
  ''
