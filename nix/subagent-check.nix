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
    cp ${self}/subagent/permission-proxy.ts "$workdir/src/subagent/permission-proxy.ts"
    cp ${self}/subagent/permission-relay.ts "$workdir/src/subagent/permission-relay.ts"
    cp ${self}/subagent/result-artifact.ts "$workdir/src/subagent/result-artifact.ts"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
    cp ${self}/shared/subagent-permission.ts "$workdir/src/shared/subagent-permission.ts"

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
      "$workdir/src/subagent/permission-proxy.ts" \
      "$workdir/src/subagent/permission-relay.ts" \
      "$workdir/src/subagent/result-artifact.ts" \
      "$workdir/src/shared/agentsh-mode.ts" \
      "$workdir/src/shared/subagent-permission.ts"

    mkdir -p "$workdir/out/node_modules/@mariozechner/pi-coding-agent"
    cat > "$workdir/out/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
    { "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }
    EOF
    cat > "$workdir/out/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
    export function createBashTool() {
      return {
        name: "bash",
        label: "bash",
        description: "test bash",
        parameters: {},
        async execute(_id, params) {
          return { content: [{ type: "text", text: "built-in:" + params.command }], details: {}, isError: false };
        },
      };
    }
    EOF

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import net from "node:net";
    import { mkdir, writeFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";

    const imported = await import(pathToFileURL(process.argv[2]).href);
    const backend = await import(pathToFileURL(process.argv[3]).href);
    const mode = await import(pathToFileURL(process.argv[4]).href);
    const background = await import(pathToFileURL(process.argv[5]).href);
    const handoff = await import(pathToFileURL(process.argv[6]).href);
    const artifacts = await import(pathToFileURL(process.argv[7]).href);
    const permissions = await import(pathToFileURL(process.argv[8]).href);
    const permissionProtocol = await import(pathToFileURL(process.argv[9]).href);
    assert.equal(background.MAX_BACKGROUND_SUBAGENTS, 8);
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_REPORT_BYTES, 16 * 1024 * 1024);
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_JOB_BYTES, 32 * 1024 * 1024);
    globalThis[permissionProtocol.SUBAGENT_PERMISSION_SELECTION_KEY] = { protocol: 1, selected: true, conflict: false };
    assert.throws(() => permissionProtocol.currentSubagentPermissionAuthority(), /selected but its authority is unavailable/);
    delete globalThis[permissionProtocol.SUBAGENT_PERMISSION_SELECTION_KEY];
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

    if (process.platform === "linux") {
    const readFrame = (socket) => new Promise((resolve, reject) => {
      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        socket.off("data", onData);
        try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });
    const authorityCalls = [];
    const authority = {
      protocol: 1, selected: true, active: true,
      async authorize(request, signal) {
        authorityCalls.push(request);
        if (request.command === "wait-for-cancel") {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { allowed: false, reason: "cancelled" };
        }
        return { allowed: request.command === "printf safe", reason: request.command === "printf safe" ? "allowed" : "denied" };
      },
    };
    const relay = await permissions.NativeSubagentPermissionRelay.create({
      authority, subagentId: "native-child-1", label: "task 1", task: "review safely", cwd: "/workspace", tools: ["bash"],
    });
    relay.bindChild(process.pid);
    const relaySocket = net.createConnection({ path: relay.environment[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV] });
    relaySocket.write(JSON.stringify({
      v: 1, type: "hello", token: relay.environment[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV],
      subagent_id: "native-child-1", pid: process.pid,
    }) + "\n");
    assert.deepEqual(await readFrame(relaySocket), { v: 1, type: "hello", service: "pi-subagent-permission-relay", tools: ["bash"] });
    await relay.ready;
    relaySocket.write(JSON.stringify({ v: 1, type: "authorize", id: "request-1", kind: "bash", command: "printf safe", cwd: "/workspace", tool_call_id: "tool-1" }) + "\n");
    assert.deepEqual(await readFrame(relaySocket), { v: 1, type: "decision", id: "request-1", allowed: true, reason: "allowed", fatal: false });
    assert.deepEqual(authorityCalls[0], {
      subagentId: "native-child-1", label: "task 1", task: "review safely", command: "printf safe", cwd: "/workspace",
      toolCallId: "subagent-" + createHash("sha256").update("native-child-1\0tool-1").digest("hex"),
    });
    relaySocket.write(JSON.stringify({ v: 1, type: "cancel", id: "request-1" }) + "\n");
    relaySocket.write(JSON.stringify({ v: 1, type: "authorize", id: "request-late", kind: "bash", command: "printf safe", cwd: "/workspace", tool_call_id: "tool-late" }) + "\n");
    assert.deepEqual(await readFrame(relaySocket), { v: 1, type: "decision", id: "request-late", allowed: true, reason: "allowed", fatal: false });
    relaySocket.write(JSON.stringify({ v: 1, type: "authorize", id: "request-2", kind: "bash", command: "wait-for-cancel", cwd: "/workspace", tool_call_id: "tool-2" }) + "\n");
    relaySocket.write(JSON.stringify({ v: 1, type: "cancel", id: "request-2" }) + "\n");
    assert.deepEqual(await readFrame(relaySocket), { v: 1, type: "decision", id: "request-2", allowed: false, reason: "native subagent tool call was aborted", fatal: false });
    const relayDisconnected = relay.failure;
    relaySocket.destroy();
    await assert.rejects(relayDisconnected, /permission proxy disconnected/);
    await assert.rejects(relay.waitForGracefulShutdown(), /permission proxy disconnected/);
    relay.dispose();

    const proxyCalls = [];
    const proxyAuthority = {
      protocol: 1, selected: true, active: true,
      async authorize(request) {
        proxyCalls.push(request);
        return { allowed: request.command === "printf proxied", reason: request.command === "printf proxied" ? "parent allowed" : "parent denied" };
      },
    };
    const proxyRelay = await permissions.NativeSubagentPermissionRelay.create({
      authority: proxyAuthority, subagentId: "native-child-proxy", label: "subagent", task: "exercise proxy",
      cwd: process.cwd(), tools: ["bash"],
    });
    proxyRelay.bindChild(process.pid);
    process.env.PI_SUBAGENT_ID = "native-child-proxy";
    process.env[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV] = proxyRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV];
    process.env[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV] = proxyRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV];
    const proxyModule = await import(pathToFileURL(process.argv[10]).href + "?proxy-check");
    const proxy = proxyModule.default?.default ?? proxyModule.default ?? proxyModule;
    const proxyHandlers = new Map();
    let proxyBash;
    proxy({
      on(name, handler) { proxyHandlers.set(name, handler); },
      registerTool(tool) { if (tool.name === permissionProtocol.SUBAGENT_PERMISSION_BASH_TOOL) proxyBash = tool; },
    });
    assert.equal(process.env[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV], undefined, "child proxy did not delete its socket marker");
    assert.equal(process.env[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV], undefined, "child proxy did not delete its token marker");
    assert(proxyBash, "child proxy did not register the distinct parent-authorized Bash wrapper");
    assert.equal(proxyBash.name, "parent_bash");
    await proxyHandlers.get("session_start")();
    await proxyRelay.ready;
    await proxyHandlers.get("before_agent_start")();
    const proxyController = new AbortController();
    const proxyAllowed = await proxyBash.execute("proxy-tool-1", { command: "printf proxied" }, proxyController.signal);
    assert.equal(proxyAllowed.content[0].text, "built-in:printf proxied");
    const proxyDenied = await proxyBash.execute("proxy-tool-2", { command: "sudo denied" }, proxyController.signal);
    assert.equal(proxyDenied.details.permissionGate, "denied");
    assert.match(proxyDenied.content[0].text, /parent denied/);
    assert.deepEqual(proxyCalls.map((call) => [call.command, call.cwd, call.toolCallId]), [
      ["printf proxied", process.cwd(), "subagent-" + createHash("sha256").update("native-child-proxy\0proxy-tool-1").digest("hex")],
      ["sudo denied", process.cwd(), "subagent-" + createHash("sha256").update("native-child-proxy\0proxy-tool-2").digest("hex")],
    ]);
    let gracefulRelayFailed = false;
    void proxyRelay.failure.catch(() => { gracefulRelayFailed = true; });
    await proxyHandlers.get("session_shutdown")();
    await proxyRelay.waitForGracefulShutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gracefulRelayFailed, false, "normal child shutdown was reported as a mandatory relay failure");
    proxyRelay.dispose();

    const fatalRelay = await permissions.NativeSubagentPermissionRelay.create({
      authority: {
        protocol: 1, selected: true, active: true,
        async authorize() { throw new Error("authority transport died"); },
      },
      subagentId: "native-child-fatal", label: "fatal child", task: "exercise fatal authority loss",
      cwd: process.cwd(), tools: ["bash"],
    });
    fatalRelay.bindChild(process.pid);
    const fatalSocket = net.createConnection({ path: fatalRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV] });
    fatalSocket.write(JSON.stringify({
      v: 1, type: "hello", token: fatalRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV],
      subagent_id: "native-child-fatal", pid: process.pid,
    }) + "\n");
    assert.equal((await readFrame(fatalSocket)).type, "hello");
    await fatalRelay.ready;
    fatalSocket.write(JSON.stringify({
      v: 1, type: "authorize", id: "fatal-request", kind: "bash", command: "sudo true",
      cwd: process.cwd(), tool_call_id: "fatal-tool",
    }) + "\n");
    const fatalDecision = await readFrame(fatalSocket);
    assert.equal(fatalDecision.allowed, false);
    assert.equal(fatalDecision.fatal, true);
    assert.match(fatalDecision.reason, /authority transport died/);
    await assert.rejects(fatalRelay.failure, /authority transport died/);
    await assert.rejects(fatalRelay.waitForGracefulShutdown(), /authority transport died/);
    fatalSocket.destroy();
    fatalRelay.dispose();
    }

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

    node "$workdir/test.mjs" "$workdir/out/subagent/parallel-result.js" "$workdir/out/subagent/backend.js" "$workdir/out/shared/agentsh-mode.js" "$workdir/out/subagent/background.js" "$workdir/out/subagent/foreground-handoff.js" "$workdir/out/subagent/result-artifact.js" "$workdir/out/subagent/permission-relay.js" "$workdir/out/shared/subagent-permission.js" "$workdir/out/subagent/permission-proxy.js"
    grep -F 'formatParallelResultContent(sections, successCount, MAX_TEXT_PREVIEW_BYTES)' ${self}/subagent/index.ts >/dev/null
    grep -F 'args.push("--no-extensions", "--extension", permissionProxyEntrypoint);' ${self}/subagent/index.ts >/dev/null
    grep -F 'const permissionAuthority = currentSubagentPermissionAuthority();' ${self}/subagent/index.ts >/dev/null
    grep -F 'SUBAGENT_PERMISSION_BASH_TOOL' ${self}/subagent/index.ts >/dev/null
    grep -F 'trustedNixStoreFile' ${self}/subagent/index.ts >/dev/null
    if grep -F 'this.socket.unref()' ${self}/subagent/permission-proxy.ts >/dev/null; then
      echo 'child permission relay socket must keep Pi print mode alive' >&2
      exit 1
    fi
    if grep -F 'isError:' ${self}/subagent/permission-proxy.ts >/dev/null; then
      echo 'child permission proxy must throw fatal tool failures rather than return ignored isError metadata' >&2
      exit 1
    fi
    grep -F 'waitForGracefulShutdown' ${self}/subagent/index.ts >/dev/null
    grep -F 'Notification: subagent ''${record.id} ''${record.status}. Check its status.' ${self}/subagent/index.ts >/dev/null
    if grep -F 'Do not claim dependent work complete' ${self}/subagent/index.ts >/dev/null \
      || grep -F 'running-reminder' ${self}/subagent/index.ts >/dev/null; then
      echo 'background lifecycle text leaked internal model guidance or running reminders' >&2
      exit 1
    fi
    grep -F '(cfg.extensions.sandbox.enable || cfg.extensions.subagent.enable)' ${self}/nix/module.nix >/dev/null
    grep -F 'builtins.elem "sandbox" extensions' ${self}/nix/mk-extension-bundle.nix >/dev/null
    grep -F '"''${extDir}/subagent/backend.ts".source = "''${self}/subagent/backend.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/background.ts".source = "''${self}/subagent/background.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/foreground-handoff.ts".source = "''${self}/subagent/foreground-handoff.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/parallel-result.ts".source = "''${self}/subagent/parallel-result.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/permission-proxy.ts".source = "''${self}/subagent/permission-proxy.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/permission-relay.ts".source = "''${self}/subagent/permission-relay.ts";' ${self}/nix/module.nix >/dev/null
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
      test -f "$bundle/subagent/permission-proxy.ts"
      test -f "$bundle/subagent/permission-relay.ts"
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
