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
    mkdir -p "$workdir/src" "$workdir/out"
    cp ${self}/subagent/backend.ts "$workdir/src/backend.ts"
    cp ${self}/subagent/parallel-result.ts "$workdir/src/parallel-result.ts"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$workdir/src" \
      --outDir "$workdir/out" \
      "$workdir/src/backend.ts" \
      "$workdir/src/parallel-result.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";

    const imported = await import(pathToFileURL(process.argv[2]).href);
    const backend = await import(pathToFileURL(process.argv[3]).href);
    const format = imported.formatParallelResultContent ?? imported.default?.formatParallelResultContent;
    assert.equal(typeof format, "function");
    assert.equal(backend.agentSHExpected({}), false);
    assert.equal(backend.agentSHExpected({ PI_SUPERVISED: "1" }), true);
    assert.equal(backend.agentSHExpected({ PI_AUTO: "1" }), true);
    assert.equal(backend.agentSHExpected({ PI_AGENTSH_REMOTE: "ssh" }), true);
    assert.equal(backend.agentSHExpected({ AGENTSH_SESSION_SUPERVISOR: "unix:///run/test.sock" }), true);
    assert.deepEqual(backend.selectSubagentBackend(undefined), { kind: "native" });
    assert.deepEqual(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: false, active: false }) }), { kind: "native" });
    const adapter = { execute() {}, detailsFailed() { return false; }, renderCall() {}, renderResult() {} };
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: true }), subagentAdapter: adapter }).kind, "agentsh");
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: false, active: true }), subagentAdapter: adapter }).kind, "agentsh");
    assert.equal(backend.selectSubagentBackend(undefined, true).kind, "unavailable");
    assert.equal(backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: true }), subagentAdapter: {} }).kind, "unavailable");
    const unavailable = backend.selectSubagentBackend({ getSupervisorState: () => ({ configured: true, active: false, status: "connecting" }) });
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

    node "$workdir/test.mjs" "$workdir/out/parallel-result.js" "$workdir/out/backend.js"
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
    done
    test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' ${sandboxOnlyBundle}/package.json)" -eq 1
    test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' ${subagentOnlyBundle}/package.json)" -eq 0
    if grep -F 'output.slice(0, 100)' ${self}/subagent/index.ts >/dev/null; then
      echo 'parallel results still use the lossy 100-character preview' >&2
      exit 1
    fi
    touch "$out"
  ''
