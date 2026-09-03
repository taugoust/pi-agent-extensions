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
    cp ${self}/subagent/background.ts "$workdir/src/subagent/background.ts"
    cp ${self}/subagent/foreground-handoff.ts "$workdir/src/subagent/foreground-handoff.ts"
    cp ${self}/subagent/parallel-result.ts "$workdir/src/subagent/parallel-result.ts"
    cp ${self}/subagent/result-artifact.ts "$workdir/src/subagent/result-artifact.ts"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"

    grep -A12 'const currentResult: SingleResult' ${self}/subagent/index.ts | grep -Fq 'exitCode: -1,'
    grep -A4 'function isFailure' ${self}/subagent/index.ts | grep -Fq 'result.exitCode !== -1'

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$workdir/src" \
      --outDir "$workdir/out" \
      "$workdir/src/subagent/backend.ts" \
      "$workdir/src/subagent/background.ts" \
      "$workdir/src/subagent/foreground-handoff.ts" \
      "$workdir/src/subagent/parallel-result.ts" \
      "$workdir/src/subagent/result-artifact.ts" \
      "$workdir/src/shared/agentsh-mode.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { mkdir, writeFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";

    const imported = await import(pathToFileURL(process.argv[2]).href);
    const backend = await import(pathToFileURL(process.argv[3]).href);
    const mode = await import(pathToFileURL(process.argv[4]).href);
    const background = await import(pathToFileURL(process.argv[5]).href);
    const handoff = await import(pathToFileURL(process.argv[6]).href);
    const artifacts = await import(pathToFileURL(process.argv[7]).href);
    assert.equal(background.MAX_BACKGROUND_SUBAGENTS, 8);
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_REPORT_BYTES, 16 * 1024 * 1024);
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_JOB_BYTES, 32 * 1024 * 1024);
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

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    let finishForeground;
    let updateForeground;
    const foregroundUpdates = [];
    const foreground = new handoff.DetachableForegroundExecution(async (_signal, update) => {
      updateForeground = update;
      return await new Promise((resolve) => { finishForeground = resolve; });
    }, (update) => foregroundUpdates.push(update));
    await tick();
    updateForeground("working");
    finishForeground("foreground-result");
    assert.deepEqual(await foreground.waitForDecision(), { kind: "completed", result: "foreground-result" });
    assert.deepEqual(foregroundUpdates, ["working"]);
    assert.equal(await foreground.detach(async () => "too-late"), undefined);

    let finishDetached;
    let updateDetached;
    let unsubscribeDetached = () => {};
    const detachedForegroundUpdates = [];
    const detachedBackgroundUpdates = [];
    const detached = new handoff.DetachableForegroundExecution(async (_signal, update) => {
      updateDetached = update;
      return await new Promise((resolve) => { finishDetached = resolve; });
    }, (update) => detachedForegroundUpdates.push(update));
    await tick();
    updateDetached("before handoff");
    const detachedValue = await detached.detach(async (execution) => {
      unsubscribeDetached = execution.subscribe((update) => detachedBackgroundUpdates.push(update));
      return "subagent-job-detached";
    });
    assert.equal(detachedValue, "subagent-job-detached");
    assert.deepEqual(await detached.waitForDecision(), { kind: "detached", value: "subagent-job-detached" });
    updateDetached("after handoff");
    assert.deepEqual(detachedForegroundUpdates, ["before handoff"]);
    assert.deepEqual(detachedBackgroundUpdates, ["before handoff", "after handoff"]);
    finishDetached("detached-result");
    assert.equal(await detached.completion, "detached-result");
    unsubscribeDetached();

    let finishDuringFailedAdoption;
    const failedAdoption = new handoff.DetachableForegroundExecution(async () => await new Promise((resolve) => {
      finishDuringFailedAdoption = resolve;
    }));
    await tick();
    await assert.rejects(failedAdoption.detach(async () => {
      finishDuringFailedAdoption("completed-during-adoption");
      await tick();
      throw new Error("adoption unavailable");
    }), /adoption unavailable/);
    assert.deepEqual(await failedAdoption.waitForDecision(), { kind: "completed", result: "completed-during-adoption" });

    const abortedForeground = new handoff.DetachableForegroundExecution(async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    abortedForeground.abort(new Error("foreground stopped"));
    await assert.rejects(abortedForeground.waitForDecision(), /foreground stopped/);

    const stateRoot = `''${process.env.TMPDIR}/background-subagents`;
    const manager = new background.BackgroundSubagentManager(stateRoot);
    await manager.initialize();
    assert.equal(background.sharedBackgroundSubagentManager(stateRoot + "-shared"), background.sharedBackgroundSubagentManager(stateRoot + "-shared"));
    const success = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "slow review" }, async (_signal, update) => {
      update("working");
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { text: "review complete", failed: false, reports: [{ label: "review", text: "complete report α\nsecond page" }] };
    });
    assert.match(success.id, background.BACKGROUND_SUBAGENT_ID_PATTERN);
    assert.equal(success.status, "running");
    assert.equal((await manager.wait(success.id, 0)).timedOut, true);
    const completed = await manager.wait(success.id, 2000);
    assert.equal(completed.record.status, "completed");
    assert.equal(completed.record.result, "review complete");
    assert.equal(completed.record.artifacts.length, 1);
    assert.match(completed.record.artifacts[0].sha256, /^[0-9a-f]{64}$/);
    const firstPage = await manager.readResult(success.id, undefined, 0, 18);
    assert.equal(firstPage.text, "complete report α");
    assert.equal(firstPage.nextOffset, 18);
    const secondPage = await manager.readResult(success.id, 1, firstPage.nextOffset, 1024);
    assert.equal(firstPage.text + secondPage.text, "complete report α\nsecond page");
    assert.equal(secondPage.nextOffset, undefined);
    assert.equal(secondPage.complete, true);
    assert.equal(secondPage.sha256, completed.record.artifacts[0].sha256);
    const resultPath = stateRoot + "/jobs/" + success.id + "/result-1.md";
    await writeFile(resultPath, "x".repeat(completed.record.artifacts[0].bytes), { mode: 0o600 });
    await assert.rejects(manager.readResult(success.id), /checksum mismatch/);
    await writeFile(resultPath, "complete report α\nsecond page", { mode: 0o600 });
    assert.equal(await manager.markNotified(success.id), true);
    assert.equal(await manager.markNotified(success.id), false);

    const waitOnly = await manager.start({ sessionId: "session-a", backend: "agentsh", mode: "single", summary: "wait cancellation" }, async (signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return { text: "unexpected", failed: false };
    });
    const waitAbort = new AbortController();
    const cancelledWait = manager.wait(waitOnly.id, 2000, waitAbort.signal);
    waitAbort.abort(new Error("stop waiting"));
    await assert.rejects(cancelledWait, /stop waiting/);
    assert.equal((await manager.get(waitOnly.id)).status, "running", "cancelled wait stopped the subagent");
    assert.equal((await manager.cancel(waitOnly.id)).status, "cancelled");

    const failing = await manager.start({ sessionId: "session-a", backend: "native", mode: "chain", summary: "failure" }, async () => {
      throw new Error("expected failure");
    });
    assert.equal((await manager.wait(failing.id, 2000)).record.status, "failed");
    assert.equal((await manager.list("session-a", 10)).length, 3);

    const parallel = await manager.start({ sessionId: "session-a", backend: "native", mode: "parallel", summary: "two reports" }, async () => ({
      text: "bounded preview", failed: false,
      reports: [{ label: "task 1", text: "first full report" }, { label: "task 2", text: "second full report" }],
    }));
    await manager.wait(parallel.id, 2000);
    await assert.rejects(manager.readResult(parallel.id), /require a child number/);
    assert.equal((await manager.readResult(parallel.id, 2)).text, "second full report");

    const attached = artifacts.attachRetainedSubagentReports({ content: [{ type: "text", text: "preview" }] }, {
      results: [{ label: "remote", final: "remote complete report" }],
    });
    assert.deepEqual(artifacts.extractRetainedSubagentReports(attached), [{ label: "remote", text: "remote complete report", totalBytes: 22, complete: true }]);
    assert.equal(Object.getOwnPropertySymbols(attached).length, 1);
    assert.equal(JSON.stringify(attached).includes("remote complete report"), false, "ephemeral complete report leaked into serialized tool result");
    assert.deepEqual(artifacts.extractRetainedSubagentReports({ results: [
      { label: "failed", error: "first failed" },
      { label: "complete", final: "second complete" },
    ] }).map((report) => [report.label, report.text]), [["failed", "first failed"], ["complete", "second complete"]]);
    await assert.rejects(manager.readResult(success.id, 1, 17, 8), /UTF-8 character boundary/);

    const longLabel = "λ".repeat(300);
    const labelled = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "long label" }, async () => ({
      text: "preview", failed: false, reports: [{ label: longLabel, text: "report" }],
    }));
    const labelledRecord = (await manager.wait(labelled.id, 2000)).record;
    assert.ok(Buffer.byteLength(labelledRecord.artifacts[0].label, "utf8") <= 256);
    const reloadedLabels = new background.BackgroundSubagentManager(stateRoot);
    await reloadedLabels.initialize();
    assert.equal((await reloadedLabels.get(labelled.id)).artifacts.length, 1);

    const staleRoot = stateRoot + "-stale";
    const staleID = "subagent-job-0123456789abcdef01234567";
    await mkdir(staleRoot + "/jobs/" + staleID, { recursive: true, mode: 0o700 });
    const staleTime = new Date().toISOString();
    await writeFile(staleRoot + "/jobs/" + staleID + "/state.json", JSON.stringify({
      schemaVersion: 1, id: staleID, sessionId: "session-stale", backend: "agentsh", mode: "single",
      summary: "interrupted", createdAt: staleTime, updatedAt: staleTime, ownerPid: 999999,
      ownerStartToken: "reused-pid-defense", status: "running", latest: "partial",
    }), { mode: 0o600 });
    const recovered = new background.BackgroundSubagentManager(staleRoot);
    await recovered.initialize();
    assert.equal((await recovered.get(staleID)).status, "lost");
    EOF

    node "$workdir/test.mjs" "$workdir/out/subagent/parallel-result.js" "$workdir/out/subagent/backend.js" "$workdir/out/shared/agentsh-mode.js" "$workdir/out/subagent/background.js" "$workdir/out/subagent/foreground-handoff.js" "$workdir/out/subagent/result-artifact.js"
    grep -F 'formatParallelResultContent(sections, successCount, MAX_TEXT_PREVIEW_BYTES)' ${self}/subagent/index.ts >/dev/null
    grep -F '(cfg.extensions.sandbox.enable || cfg.extensions.subagent.enable)' ${self}/nix/module.nix >/dev/null
    grep -F 'builtins.elem "sandbox" extensions' ${self}/nix/mk-extension-bundle.nix >/dev/null
    grep -F '"''${extDir}/subagent/backend.ts".source = "''${self}/subagent/backend.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/background.ts".source = "''${self}/subagent/background.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/foreground-handoff.ts".source = "''${self}/subagent/foreground-handoff.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/parallel-result.ts".source = "''${self}/subagent/parallel-result.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/result-artifact.ts".source = "''${self}/subagent/result-artifact.ts";' ${self}/nix/module.nix >/dev/null
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
      test -f "$bundle/subagent/background.ts"
      test -f "$bundle/subagent/foreground-handoff.ts"
      test -f "$bundle/subagent/result-artifact.ts"
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
