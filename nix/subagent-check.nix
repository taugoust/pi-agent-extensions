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
    cp ${self}/subagent/control.ts "$workdir/src/subagent/control.ts"
    cp ${self}/subagent/outcome.ts "$workdir/src/subagent/outcome.ts"
    cp ${self}/subagent/outcome.test.ts "$workdir/src/subagent/outcome.test.ts"
    cp ${self}/subagent/resume.ts "$workdir/src/subagent/resume.ts"
    cp ${self}/subagent/resume.test.ts "$workdir/src/subagent/resume.test.ts"
    cp ${self}/subagent/control.test.ts "$workdir/src/subagent/control.test.ts"
    cp ${self}/subagent/foreground-handoff.ts "$workdir/src/subagent/foreground-handoff.ts"
    cp ${self}/subagent/native-rpc.ts "$workdir/src/subagent/native-rpc.ts"
    cp ${self}/subagent/native-rpc.test.ts "$workdir/src/subagent/native-rpc.test.ts"
    cp ${self}/subagent/parallel-result.ts "$workdir/src/subagent/parallel-result.ts"
    cp ${self}/subagent/permission-proxy.ts "$workdir/src/subagent/permission-proxy.ts"
    cp ${self}/subagent/permission-relay.ts "$workdir/src/subagent/permission-relay.ts"
    cp ${self}/subagent/result-artifact.ts "$workdir/src/subagent/result-artifact.ts"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
    cp ${self}/shared/subagent-permission.ts "$workdir/src/shared/subagent-permission.ts"
    printf '%s\n' '{ "type": "module" }' > "$workdir/src/package.json"

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
      "$workdir/src/subagent/control.ts" \
      "$workdir/src/subagent/outcome.ts" \
      "$workdir/src/subagent/outcome.test.ts" \
      "$workdir/src/subagent/resume.ts" \
      "$workdir/src/subagent/resume.test.ts" \
      "$workdir/src/subagent/control.test.ts" \
      "$workdir/src/subagent/foreground-handoff.ts" \
      "$workdir/src/subagent/native-rpc.ts" \
      "$workdir/src/subagent/native-rpc.test.ts" \
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

    node "$workdir/out/subagent/control.test.js"
    node "$workdir/out/subagent/outcome.test.js"
    node "$workdir/out/subagent/resume.test.js"
    TEST_MKFIFO=${pkgs.coreutils}/bin/mkfifo node "$workdir/out/subagent/native-rpc.test.js"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import net from "node:net";
    import { mkdir, readFile, writeFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";

    const imported = await import(pathToFileURL(process.argv[2]).href);
    const backend = await import(pathToFileURL(process.argv[3]).href);
    const mode = await import(pathToFileURL(process.argv[4]).href);
    const background = await import(pathToFileURL(process.argv[5]).href);
    const handoff = await import(pathToFileURL(process.argv[6]).href);
    const artifacts = await import(pathToFileURL(process.argv[7]).href);
    const permissions = await import(pathToFileURL(process.argv[8]).href);
    const permissionProtocol = await import(pathToFileURL(process.argv[9]).href);
    assert.equal(background.BACKGROUND_SUBAGENT_RELOAD_ADOPTION_TIMEOUT_MS, 65_000);
    assert.equal(permissionProtocol.SUBAGENT_PERMISSION_RELOAD_DRAIN_TIMEOUT_MS, 30_000);
    assert.equal(permissionProtocol.SUBAGENT_PERMISSION_RELOAD_REBIND_TIMEOUT_MS, 30_000);
    assert.equal(background.backgroundSubagentsSurviveShutdown("reload"), true);
    for (const reason of ["quit", "new", "resume", "fork", undefined]) {
      assert.equal(background.backgroundSubagentsSurviveShutdown(reason), false);
    }
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_REPORT_BYTES, 16 * 1024 * 1024);
    assert.equal(artifacts.MAX_RETAINED_SUBAGENT_JOB_BYTES, 32 * 1024 * 1024);
    globalThis[permissionProtocol.SUBAGENT_PERMISSION_SELECTION_KEY] = { protocol: 1, selected: true, conflict: false };
    assert.throws(() => permissionProtocol.currentSubagentPermissionAuthority(), /selected but its authority is unavailable/);
    delete globalThis[permissionProtocol.SUBAGENT_PERMISSION_SELECTION_KEY];

    const permissionRequest = (command) => ({
      subagentId: "reload-child", label: "reload child", task: "survive reload",
      toolCallId: "reload-tool", command, cwd: "/workspace",
    });
    const reloadAuthority = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const firstAuthorityOwner = Symbol("first authority owner");
    let releaseFirstAuthorization;
    const authorityDelegates = [];
    reloadAuthority.bind(firstAuthorityOwner, "reload-session", async (request, _callerSignal, sessionSignal) => {
      authorityDelegates.push(["old", request.command]);
      if (request.command === "drain-before-reload") {
        await new Promise((resolve) => { releaseFirstAuthorization = resolve; });
      }
      assert.equal(sessionSignal.aborted, false);
      return { allowed: true, reason: "old authority" };
    });
    const stableAuthority = reloadAuthority.authority;
    const drainingAuthorization = stableAuthority.authorize(permissionRequest("drain-before-reload"));
    const reloadStarted = reloadAuthority.beginReload(firstAuthorityOwner, "reload-session");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reloadAuthority.phase(), "draining");
    assert.equal(stableAuthority.active, false, "draining authority remained launchable");
    const queuedAuthorization = stableAuthority.authorize(permissionRequest("after-reload"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(authorityDelegates, [["old", "drain-before-reload"]], "reload dispatched a new request through the stale context");
    releaseFirstAuthorization();
    assert.equal((await drainingAuthorization).allowed, true);
    assert.equal(await reloadStarted, true);
    assert.equal(reloadAuthority.phase(), "reloading");
    assert.equal(stableAuthority.active, false, "reload gap remained launchable without a bound parent context");
    const secondAuthorityOwner = Symbol("second authority owner");
    reloadAuthority.bind(secondAuthorityOwner, "reload-session", async (request, _callerSignal, sessionSignal) => {
      authorityDelegates.push(["new", request.command]);
      assert.equal(sessionSignal.aborted, false);
      return { allowed: true, reason: "new authority" };
    });
    assert.equal(reloadAuthority.authority, stableAuthority, "reload replaced the authority captured by a guarded child");
    assert.equal((await queuedAuthorization).reason, "new authority");
    assert.deepEqual(authorityDelegates, [["old", "drain-before-reload"], ["new", "after-reload"]]);
    assert.equal(reloadAuthority.deactivate(firstAuthorityOwner, new Error("stale shutdown")), false, "stale extension revoked the rebound authority");
    assert.equal(stableAuthority.active, true);
    assert.equal(reloadAuthority.deactivate(secondAuthorityOwner, new Error("session quit")), true);
    assert.equal(stableAuthority.active, false);
    await assert.rejects(stableAuthority.authorize(permissionRequest("after-quit")), /session quit/);

    const ticketedHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const ticketedOwner = Symbol("ticketed handoff owner");
    ticketedHandoff.bind(ticketedOwner, "reload-session", async () => ({ allowed: true, reason: "ticketed allow" }));
    const ticketRequest = permissionRequest("ticketed-before-reload");
    const preparedTicket = await ticketedHandoff.authority.prepare(ticketRequest);
    const ticketedReload = ticketedHandoff.beginReload(ticketedOwner, "reload-session");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ticketedHandoff.phase(), "draining", "reload crossed an uncommitted child decision");
    assert.equal(ticketedHandoff.authority.active, false, "draining ticket authority remained launchable");
    assert.equal(ticketedHandoff.authority.commit(preparedTicket.ticket, ticketRequest).allowed, true);
    assert.equal(ticketedHandoff.phase(), "draining", "ticket commit yielded before the relay could queue its response");
    assert.equal(await ticketedReload, true);
    ticketedHandoff.bind(Symbol("ticketed replacement"), "reload-session", async () => ({ allowed: true, reason: "new generation" }));
    assert.throws(() => ticketedHandoff.authority.commit(preparedTicket.ticket, ticketRequest), /invalid or already used/, "authorization ticket replay was accepted after reload");

    const exactTicketAuthority = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    exactTicketAuthority.bind(Symbol("exact ticket owner"), "reload-session", async () => ({ allowed: true, reason: "exact allow" }));
    const exactTicket = await exactTicketAuthority.authority.prepare(permissionRequest("exact-command"));
    assert.throws(() => exactTicketAuthority.authority.commit(exactTicket.ticket, permissionRequest("mutated-command")), /does not match the exact request/);

    const commitValidatorAuthority = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    commitValidatorAuthority.bind(
      Symbol("commit validator owner"),
      "reload-session",
      async () => ({ allowed: true, reason: "stale allow" }),
      () => { throw new Error("command authority changed before commit"); },
    );
    const invalidatedCommitRequest = permissionRequest("invalidated-before-commit");
    const invalidatedCommit = await commitValidatorAuthority.authority.prepare(invalidatedCommitRequest);
    assert.throws(() => commitValidatorAuthority.authority.commit(invalidatedCommit.ticket, invalidatedCommitRequest), /command authority changed before commit/);
    assert.equal(commitValidatorAuthority.phase(), "failed");
    assert.equal(commitValidatorAuthority.authority.revoked.aborted, true);

    const cancelledHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const cancelledOwner = Symbol("cancelled handoff owner");
    cancelledHandoff.bind(cancelledOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" }));
    await cancelledHandoff.beginReload(cancelledOwner, "reload-session");
    const cancelledController = new AbortController();
    const cancelledAuthorization = cancelledHandoff.authority.authorize(permissionRequest("cancelled-during-reload"), cancelledController.signal);
    cancelledController.abort(new Error("caller cancelled"));
    await assert.rejects(cancelledAuthorization, /caller cancelled/);
    assert.equal(cancelledHandoff.phase(), "reloading", "caller cancellation failed the shared reload handoff");
    cancelledHandoff.bind(Symbol("cancel replacement"), "reload-session", async () => ({ allowed: true, reason: "replacement" }));

    const mismatchedHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const mismatchedOwner = Symbol("mismatched handoff owner");
    mismatchedHandoff.bind(mismatchedOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" }));
    await mismatchedHandoff.beginReload(mismatchedOwner, "reload-session");
    assert.throws(() => mismatchedHandoff.bind(Symbol("replacement"), "different-session", async () => ({ allowed: true, reason: "unexpected" })), /different Pi session/);
    assert.equal(mismatchedHandoff.authority.active, false, "cross-session reload mismatch left child authority active");

    const staleOwnerHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const staleOwner = Symbol("stale reload owner");
    staleOwnerHandoff.bind(staleOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" }));
    await staleOwnerHandoff.beginReload(staleOwner, "reload-session");
    assert.throws(() => staleOwnerHandoff.bind(staleOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" })), /stale extension owner/);
    assert.equal(staleOwnerHandoff.authority.revoked.aborted, true);

    const timedOutHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(20);
    const timedOutOwner = Symbol("timed out handoff owner");
    timedOutHandoff.bind(timedOutOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" }));
    await timedOutHandoff.beginReload(timedOutOwner, "reload-session");
    await assert.rejects(timedOutHandoff.authority.authorize(permissionRequest("reload-never-rebound")), /did not rebind/);
    assert.equal(timedOutHandoff.phase(), "failed");
    assert.equal(timedOutHandoff.authority.active, false);

    const hungDrainHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(20);
    const hungDrainOwner = Symbol("hung drain owner");
    hungDrainHandoff.bind(hungDrainOwner, "reload-session", async () => ({ allowed: true, reason: "uncommitted" }));
    const hungDrainRequest = permissionRequest("uncommitted-drain");
    const hungDrainTicket = await hungDrainHandoff.authority.prepare(hungDrainRequest);
    assert.equal(await hungDrainHandoff.beginReload(hungDrainOwner, "reload-session"), false);
    assert.equal(hungDrainHandoff.phase(), "failed", "uncommitted authorization held reload past its drain deadline");
    assert.throws(() => hungDrainHandoff.authority.commit(hungDrainTicket.ticket, hungDrainRequest), /did not drain/);

    const noRequestHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(20);
    const noRequestOwner = Symbol("no request handoff owner");
    noRequestHandoff.bind(noRequestOwner, "reload-session", async () => ({ allowed: true, reason: "unexpected" }));
    await noRequestHandoff.beginReload(noRequestOwner, "reload-session");
    if (!noRequestHandoff.authority.revoked.aborted) {
      await new Promise((resolve) => noRequestHandoff.authority.revoked.addEventListener("abort", resolve, { once: true }));
    }
    assert.equal(noRequestHandoff.phase(), "failed", "reload without a waiting request had no central handoff deadline");

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
    const createTestAuthority = (delegate, timeoutMs = 1000) => {
      const broker = permissionProtocol.createReloadableSubagentPermissionAuthority(timeoutMs);
      const owner = Symbol("test authority");
      broker.bind(owner, "test-session", delegate);
      return { broker, owner, authority: broker.authority };
    };
    const authorityCalls = [];
    const authorityBroker = createTestAuthority(async (request, signal) => {
      authorityCalls.push(request);
      if (request.command === "wait-for-cancel") {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { allowed: false, reason: "cancelled" };
      }
      return { allowed: request.command === "printf safe", reason: request.command === "printf safe" ? "allowed" : "denied" };
    });
    const authority = authorityBroker.authority;
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

    assert.equal(await authorityBroker.broker.beginReload(authorityBroker.owner, "test-session"), true);
    assert.equal(authority.active, false, "reload-suspended authority remained launchable");
    relaySocket.write(JSON.stringify({ v: 1, type: "authorize", id: "request-after-reload", kind: "bash", command: "printf rebound", cwd: "/workspace", tool_call_id: "tool-rebound" }) + "\n");
    const reboundFramePromise = readFrame(relaySocket);
    assert.equal(await Promise.race([
      reboundFramePromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 20)),
    ]), false, "relay emitted a decision while parent authority was suspended");
    authorityBroker.broker.bind(Symbol("replacement test authority"), "test-session", async (request) => ({
      allowed: request.command === "printf rebound",
      reason: "rebound authority",
    }));
    assert.deepEqual(await reboundFramePromise, { v: 1, type: "decision", id: "request-after-reload", allowed: true, reason: "rebound authority", fatal: false });

    const relayDisconnected = relay.failure;
    relaySocket.destroy();
    await assert.rejects(relayDisconnected, /permission proxy disconnected/);
    await assert.rejects(relay.waitForGracefulShutdown(), /permission proxy disconnected/);
    relay.dispose();

    const queuedRelayHandoff = permissionProtocol.createReloadableSubagentPermissionAuthority(1000);
    const queuedRelayOldOwner = Symbol("queued relay old owner");
    const queuedRelayNewOwner = Symbol("queued relay new owner");
    queuedRelayHandoff.bind(queuedRelayOldOwner, "relay-session", async () => ({ allowed: true, reason: "old" }));
    assert.equal(await queuedRelayHandoff.beginReload(queuedRelayOldOwner, "relay-session"), true);
    let queuedRelaySettled = false;
    const queuedRelayPromise = permissions.NativeSubagentPermissionRelay.create({
      authority: queuedRelayHandoff.authority, subagentId: "native-child-queued-reload", label: "queued reload child",
      task: "wait for replacement permission owner", cwd: "/workspace", tools: ["bash"],
    }).finally(() => { queuedRelaySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queuedRelaySettled, false, "relay launch did not wait through the permission reload gap");
    const cancelledQueuedRelayController = new AbortController();
    const cancelledQueuedRelay = permissions.NativeSubagentPermissionRelay.create({
      authority: queuedRelayHandoff.authority, subagentId: "native-child-cancelled-queue", label: "cancelled queued child",
      task: "cancel while waiting for replacement", cwd: "/workspace", tools: ["bash"], signal: cancelledQueuedRelayController.signal,
    });
    cancelledQueuedRelayController.abort(new Error("cancel queued relay"));
    await assert.rejects(cancelledQueuedRelay, /cancel queued relay/);
    queuedRelayHandoff.bind(queuedRelayNewOwner, "relay-session", async () => ({ allowed: true, reason: "new" }));
    const queuedRelay = await queuedRelayPromise;
    queuedRelay.dispose();

    const expiringAuthority = createTestAuthority(async () => ({ allowed: true, reason: "unexpected" }), 30);
    const expiringRelay = await permissions.NativeSubagentPermissionRelay.create({
      authority: expiringAuthority.authority, subagentId: "native-child-expiring", label: "expiring child", task: "reload timeout",
      cwd: "/workspace", tools: ["bash"],
    });
    expiringRelay.bindChild(process.pid);
    const expiringSocket = net.createConnection({ path: expiringRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV] });
    const expiringSocketClosed = new Promise((resolve) => expiringSocket.once("close", resolve));
    expiringSocket.write(JSON.stringify({
      v: 1, type: "hello", token: expiringRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV],
      subagent_id: "native-child-expiring", pid: process.pid,
    }) + "\n");
    assert.equal((await readFrame(expiringSocket)).type, "hello");
    await expiringRelay.ready;
    assert.equal(await expiringAuthority.broker.beginReload(expiringAuthority.owner, "test-session"), true);
    await assert.rejects(expiringRelay.failure, /did not rebind/);
    await expiringSocketClosed;
    assert.equal(expiringSocket.destroyed, true, "reload timeout did not close the retained child relay");
    expiringRelay.dispose();

    const writeFailureAuthority = createTestAuthority(async () => ({ allowed: true, reason: "write should fail" }));
    const writeFailureRelay = await permissions.NativeSubagentPermissionRelay.create({
      authority: writeFailureAuthority.authority, subagentId: "native-child-write-failure", label: "write failure child", task: "force relay write failure",
      cwd: "/workspace", tools: ["bash"],
    });
    writeFailureRelay.bindChild(process.pid);
    const writeFailureSocket = net.createConnection({ path: writeFailureRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_SOCKET_ENV] });
    writeFailureSocket.write(JSON.stringify({
      v: 1, type: "hello", token: writeFailureRelay.environment[permissionProtocol.SUBAGENT_PERMISSION_TOKEN_ENV],
      subagent_id: "native-child-write-failure", pid: process.pid,
    }) + "\n");
    assert.equal((await readFrame(writeFailureSocket)).type, "hello");
    await writeFailureRelay.ready;
    writeFailureRelay.socket.write = (_frame, callback) => {
      queueMicrotask(() => callback(new Error("forced relay write failure")));
      return true;
    };
    writeFailureSocket.write(JSON.stringify({
      v: 1, type: "authorize", id: "write-failure-request", kind: "bash", command: "printf safe",
      cwd: "/workspace", tool_call_id: "write-failure-tool",
    }) + "\n");
    await assert.rejects(writeFailureRelay.failure, /forced relay write failure/);
    await assert.rejects(writeFailureRelay.waitForGracefulShutdown(), /forced relay write failure/);
    writeFailureSocket.destroy();
    writeFailureRelay.dispose();

    const proxyCalls = [];
    const proxyAuthority = createTestAuthority(async (request) => {
      proxyCalls.push(request);
      return { allowed: request.command === "printf proxied", reason: request.command === "printf proxied" ? "parent allowed" : "parent denied" };
    }).authority;
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
      authority: createTestAuthority(async () => { throw new Error("authority transport died"); }).authority,
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

    const launchRaceManager = new background.BackgroundSubagentManager(stateRoot + "-launch-race");
    let racedRunnerStarts = 0;
    const racedLaunch = launchRaceManager.start({ sessionId: "session-launch-race", backend: "native", mode: "single", summary: "launch race" }, async () => {
      racedRunnerStarts += 1;
      return { text: "must not run", failed: false };
    });
    launchRaceManager.requestCancelSession("session-launch-race");
    await assert.rejects(racedLaunch, /session changed|shut down/);
    assert.equal(racedRunnerStarts, 0, "session shutdown launched a background runner after cancellation");

    const reloadLaunchRaceManager = new background.BackgroundSubagentManager(stateRoot + "-reload-launch-race");
    const reloadRacedLaunch = reloadLaunchRaceManager.start({ sessionId: "session-reload-launch-race", backend: "native", mode: "single", summary: "reload launch race" }, async () => {
      racedRunnerStarts += 1;
      return { text: "must not run", failed: false };
    });
    assert.equal(reloadLaunchRaceManager.beginReloadAdoption("session-reload-launch-race", 100), false);
    await assert.rejects(reloadRacedLaunch, /session changed|extension reload/);
    assert.equal(racedRunnerStarts, 0, "reload launched a background runner whose start had not committed");
    assert.equal(reloadLaunchRaceManager.activateSession("session-reload-launch-race"), true);

    const capacityManager = new background.BackgroundSubagentManager(stateRoot + "-capacity");
    const supportedCapacity = 16;
    const capacityRecords = [];
    for (let index = 0; index < supportedCapacity; index += 1) {
      capacityRecords.push(await capacityManager.start(
        { sessionId: "session-capacity", backend: "native", mode: index % 2 === 0 ? "single" : "parallel", summary: `capacity ''${index + 1}` },
        async (signal) => {
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { text: "cancelled capacity fixture", failed: true };
        },
      ));
    }
    assert.equal((await capacityManager.list("session-capacity", 100)).filter(background.isBackgroundSubagentActive).length, supportedCapacity);
    let overflowRunnerStarts = 0;
    await assert.rejects(
      capacityManager.start(
        { sessionId: "session-capacity", backend: "native", mode: "single", summary: "capacity overflow" },
        async () => {
          overflowRunnerStarts += 1;
          return { text: "must not start", failed: false };
        },
      ),
      /concurrency limit reached/,
    );
    assert.equal(overflowRunnerStarts, 0);
    for (const record of capacityRecords) assert.equal((await capacityManager.cancel(record.id)).status, "cancelled");

    const legacyV3Root = stateRoot + "-shared";
    let unsafeLegacyStorageCalls = 0;
    let legacyReloadAdoptions = 0;
    const legacyV3Manager = {
      root: legacyV3Root,
      async initialize() { unsafeLegacyStorageCalls += 1; throw new Error("must not initialize V3 through V4"); },
      async list() { unsafeLegacyStorageCalls += 1; throw new Error("must not list through V3"); },
      adoptReload(sessionId) {
        assert.equal(sessionId, "session-v3-upgrade");
        legacyReloadAdoptions += 1;
        return true;
      },
    };
    const legacyV3JobId = "subagent-job-333333333333333333333333";
    const legacyV3SessionId = "session-v3-upgrade";
    const legacyV3CreatedAt = new Date().toISOString();
    const processStat = await readFile(`/proc/''${process.pid}/stat`, "utf8");
    const processStartToken = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
    const legacyV3State = {
      schemaVersion: 2,
      id: legacyV3JobId,
      sessionId: legacyV3SessionId,
      backend: "native",
      mode: "single",
      summary: "running across V3 to V4 reload",
      createdAt: legacyV3CreatedAt,
      updatedAt: legacyV3CreatedAt,
      ownerPid: process.pid,
      ownerStartToken: processStartToken,
      status: "running",
      latest: "V3 runner is active",
    };
    await mkdir(`''${legacyV3Root}/jobs/''${legacyV3JobId}`, { recursive: true, mode: 0o700 });
    await writeFile(`''${legacyV3Root}/jobs/''${legacyV3JobId}/state.json`, JSON.stringify(legacyV3State), { mode: 0o600 });
    const backgroundRuntime = globalThis.__paeBackgroundSubagentRuntimeV3;
    backgroundRuntime.controllers.set(legacyV3JobId, new AbortController());
    backgroundRuntime.sessions.set(legacyV3SessionId, { phase: "reloading", generation: 2 });

    globalThis.__paeBackgroundSubagentManagersV3 = new Map([[legacyV3Root, legacyV3Manager]]);
    const upgradedSharedManager = background.sharedBackgroundSubagentManager(legacyV3Root);
    assert.notEqual(upgradedSharedManager, legacyV3Manager, "hot upgrade reused an incompatible V3 manager singleton");
    assert.equal(upgradedSharedManager.managerAbiVersion, 4);
    await upgradedSharedManager.initialize();
    assert.equal((await upgradedSharedManager.get(legacyV3JobId)).status, "running", "V4 manager lost a live V3-owned execution");
    assert.equal(unsafeLegacyStorageCalls, 0, "V4 manager invoked unsafe V3 storage methods");
    assert.equal(upgradedSharedManager.activateSession(legacyV3SessionId), true);
    assert.equal(legacyReloadAdoptions, 1, "V4 manager did not acknowledge the V3 reload watchdog");

    const migratedResult = "completed by the retained V3 runner";
    const migratedBytes = Buffer.byteLength(migratedResult);
    const migratedAt = new Date(Date.now() + 1000).toISOString();
    await writeFile(`''${legacyV3Root}/jobs/''${legacyV3JobId}/result-1.md`, migratedResult, { mode: 0o600 });
    await writeFile(`''${legacyV3Root}/jobs/''${legacyV3JobId}/state.json`, JSON.stringify({
      ...legacyV3State,
      updatedAt: migratedAt,
      status: "completed",
      latest: migratedResult,
      result: migratedResult,
      artifacts: [{
        child: 1,
        label: "result",
        bytes: migratedBytes,
        totalBytes: migratedBytes,
        complete: true,
        sha256: createHash("sha256").update(migratedResult).digest("hex"),
      }],
    }), { mode: 0o600 });
    assert.equal((await upgradedSharedManager.get(legacyV3JobId)).status, "completed", "V4 manager did not observe the retained V3 runner's result");
    const migratedPage = await upgradedSharedManager.readResult(legacyV3JobId, 1);
    assert.equal(migratedPage.text, migratedResult);
    assert.equal(Object.hasOwn(migratedPage, "childId"), false, "migrated pre-identity result acquired a controllable ID");
    backgroundRuntime.controllers.delete(legacyV3JobId);
    assert.equal(upgradedSharedManager, background.sharedBackgroundSubagentManager(legacyV3Root));
    delete globalThis.__paeBackgroundSubagentManagersV3;
    const legacyPendingNotifications = new Set(["reload-notification"]);
    const legacyInFlightNotifications = new Set(["reload-notification-in-flight"]);
    globalThis.__paeBackgroundSubagentNotificationV1 = {
      idlePending: legacyPendingNotifications,
      idleInFlight: legacyInFlightNotifications,
      deliveryClaims: new Set(["legacy-claim"]),
    };
    const notificationState = background.sharedBackgroundSubagentNotificationState();
    assert.equal(notificationState.idlePending, legacyPendingNotifications, "notification migration discarded pending delivery");
    assert.equal(notificationState.idleInFlight, legacyInFlightNotifications, "notification migration discarded in-flight delivery");
    assert(notificationState.deliveryClaims instanceof Map, "notification migration retained incompatible claim identity");
    assert(notificationState.consumed instanceof Set, "notification migration omitted consumption arbitration");
    assert(notificationState.consumptionPending instanceof Set, "notification migration omitted accepted-result tracking");
    assert.equal(background.sharedBackgroundSubagentNotificationState(), notificationState);
    notificationState.idlePending.clear();
    notificationState.idleInFlight.clear();
    const reloadManager = background.sharedBackgroundSubagentManager(stateRoot + "-reload");
    let releaseReloadExecution;
    const reloadExecution = await reloadManager.start({ sessionId: "session-reload", backend: "native", mode: "single", summary: "reload survival" }, async () => {
      await new Promise((resolve) => { releaseReloadExecution = resolve; });
      return { text: "completed after reload", failed: false };
    });
    assert.equal(reloadManager.beginReloadAdoption("session-reload", 100), true);
    const reloadedManagerModule = await import(pathToFileURL(process.argv[5]).href + "?manager-v4-reload=1");
    const adoptedReloadManager = reloadedManagerModule.sharedBackgroundSubagentManager(stateRoot + "-reload");
    assert.equal(adoptedReloadManager, reloadManager, "hot reload did not adopt the process-owned V4 manager");
    assert.equal(adoptedReloadManager.adoptReload("session-reload"), true, "replacement extension did not clear the reload watchdog");
    assert.equal((await adoptedReloadManager.get(reloadExecution.id)).status, "running");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseReloadExecution, "function");
    releaseReloadExecution();
    assert.equal((await adoptedReloadManager.wait(reloadExecution.id, 2000)).record.result, "completed after reload");

    const reloadCancelled = await reloadManager.start({ sessionId: "session-reload-cancel", backend: "native", mode: "single", summary: "cancel after adoption" }, async (executionSignal) => {
      if (!executionSignal.aborted) {
        await new Promise((resolve) => executionSignal.addEventListener("abort", resolve, { once: true }));
      }
      return { text: "cancelled by replacement extension", failed: true };
    });
    assert.equal(reloadManager.beginReloadAdoption("session-reload-cancel", 100), true);
    assert.equal(adoptedReloadManager.adoptReload("session-reload-cancel"), true);
    assert.equal((await adoptedReloadManager.cancel(reloadCancelled.id)).status, "cancelled", "replacement extension could not cancel adopted work");

    const missingAdopterManager = background.sharedBackgroundSubagentManager(stateRoot + "-missing-adopter");
    const missingAdopterExecution = await missingAdopterManager.start({ sessionId: "session-missing-adopter", backend: "native", mode: "single", summary: "missing reload adopter" }, async (executionSignal) => {
      if (!executionSignal.aborted) {
        await new Promise((resolve) => executionSignal.addEventListener("abort", resolve, { once: true }));
      }
      return { text: "cancelled after missing adoption", failed: true };
    });
    assert.equal(missingAdopterManager.beginReloadAdoption("session-missing-adopter", 20), true);
    assert.equal((await missingAdopterManager.wait(missingAdopterExecution.id, 2000)).record.status, "cancelled", "missing reload adopter left background work orphaned");

    const success = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "slow review" }, async (_signal, update) => {
      update("working");
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { text: "review complete", failed: false, taskOutcomes: [{child:1,state:"partial",reported:true,summary:"validation still pending",next_action:"run validation"}], reports: [{ label: "review", text: "complete report α\nsecond page" }] };
    });
    assert.match(success.id, background.BACKGROUND_SUBAGENT_ID_PATTERN);
    assert.equal(success.status, "running");
    assert.equal((await manager.wait(success.id, 0)).timedOut, true);
    const completed = await manager.wait(success.id, 2000);
    assert.equal(completed.record.status, "completed");
    assert.equal(completed.record.result, "review complete");
    assert.equal(completed.record.taskOutcomes[0].state, "partial", "execution success was confused with task delivery");
    const outcomeReload = new background.BackgroundSubagentManager(stateRoot);
    assert.equal((await outcomeReload.get(success.id)).taskOutcomes[0].state, "partial", "task outcome did not survive reload");
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

    const childTracker = new background.BackgroundSubagentChildTracker();
    assert.deepEqual(await background.waitForAnyBackgroundSubagentChild(manager, childTracker, [], 10), { timedOut: false, remainingChildren: 0 });
    assert.deepEqual(await background.waitForAllBackgroundSubagentGroups(manager, [], 10), { records: [], timedOut: false });
    const preCancelledWait = new AbortController();
    preCancelledWait.abort(new Error("pre-cancelled wait"));
    await assert.rejects(background.waitForAnyBackgroundSubagentChild(manager, childTracker, [], 10, preCancelledWait.signal), /pre-cancelled wait/);
    await assert.rejects(background.waitForAllBackgroundSubagentGroups(manager, [], 10, preCancelledWait.signal), /pre-cancelled wait/);
    let releaseChildGroup;
    const childGroup = await manager.start({ sessionId: "session-a", backend: "native", mode: "parallel", summary: "parallel 2: child wait" }, async (signal) => {
      await new Promise((resolve, reject) => {
        releaseChildGroup = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { text: "children complete", failed: false };
    });
    childTracker.register(childGroup, [{ label: "task 1", task: "slow" }, { label: "task 2", task: "fast" }]);
    childTracker.update(childGroup.id, [
      { child: 1, label: "task 1", task: "slow", status: "running" },
      { child: 2, label: "task 2", task: "fast", status: "running" },
    ]);
    const waitAnyChild = background.waitForAnyBackgroundSubagentChild(manager, childTracker, [childGroup], 1000);
    setTimeout(() => childTracker.update(childGroup.id, [{ child: 2, label: "task 2", task: "fast", status: "completed" }]), 20);
    const firstChild = await waitAnyChild;
    assert.equal(firstChild.record.id, childGroup.id);
    assert.equal(firstChild.child.child, 2);
    assert.equal(firstChild.child.status, "completed");
    assert.equal(firstChild.remainingChildren, 1);
    const waitAnyTimeout = await background.waitForAnyBackgroundSubagentChild(manager, childTracker, [childGroup], 10);
    assert.equal(waitAnyTimeout.timedOut, true);
    assert.equal(waitAnyTimeout.remainingChildren, 1);
    releaseChildGroup();
    assert.equal((await manager.wait(childGroup.id, 2000)).record.status, "completed");
    assert.equal(childTracker.reconcile(await manager.get(childGroup.id))[0].status, "completed");
    const precedenceTracker = new background.BackgroundSubagentChildTracker();
    const precedenceRecord = { ...childGroup, id: "subagent-job-ffffffffffffffffffffffff", status: "running" };
    precedenceTracker.register(precedenceRecord, [{ label: "authoritative terminal" }]);
    precedenceTracker.update(precedenceRecord.id, [{ child: 1, label: "authoritative terminal", status: "completed" }]);
    precedenceTracker.update(precedenceRecord.id, [{ child: 1, label: "authoritative terminal", status: "failed" }]);
    precedenceTracker.update(precedenceRecord.id, [{ child: 1, label: "stale success", status: "completed" }]);
    assert.equal(precedenceTracker.reconcile(precedenceRecord)[0].status, "failed", "stale success overwrote an authoritative failure");
    const sharedChildTracker = background.sharedBackgroundSubagentChildTracker();
    assert.equal(sharedChildTracker, background.sharedBackgroundSubagentChildTracker());
    const reloadedBackground = await import(pathToFileURL(process.argv[5]).href + "?child-tracker-reload=1");
    assert.equal(reloadedBackground.sharedBackgroundSubagentChildTracker(), sharedChildTracker, "hot reload replaced process-owned child progress");

    let releaseAllOne;
    let releaseAllTwo;
    const allOne = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "wait all one" }, async () => {
      await new Promise((resolve) => { releaseAllOne = resolve; });
      return { text: "all one", failed: false };
    });
    const allTwo = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "wait all two" }, async () => {
      await new Promise((resolve) => { releaseAllTwo = resolve; });
      return { text: "all two", failed: false };
    });
    const waitAllGroups = background.waitForAllBackgroundSubagentGroups(manager, [allOne, allTwo], 1000);
    const laterGroup = await manager.start({ sessionId: "session-a", backend: "native", mode: "single", summary: "launched after wait all" }, async (signal) => {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { text: "unexpected", failed: false };
    });
    releaseAllOne();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseAllTwo();
    const allGroups = await waitAllGroups;
    assert.equal(allGroups.timedOut, false);
    assert.deepEqual(allGroups.records.map((record) => record.status), ["completed", "completed"]);
    assert.equal((await manager.get(laterGroup.id)).status, "running", "wait_all included a group launched after its snapshot");
    const timedOutAll = await background.waitForAllBackgroundSubagentGroups(manager, [laterGroup], 10);
    assert.equal(timedOutAll.timedOut, true);
    assert.equal((await manager.get(laterGroup.id)).status, "running", "timing out wait_all cancelled its child");
    childTracker.register(laterGroup, [{ label: "subagent", task: "cancel wait_any only" }]);
    const cancelledAnyController = new AbortController();
    const cancelledAnyWait = background.waitForAnyBackgroundSubagentChild(manager, childTracker, [laterGroup], 1000, cancelledAnyController.signal);
    cancelledAnyController.abort(new Error("cancel wait_any"));
    await assert.rejects(cancelledAnyWait, /cancel wait_any/);
    assert.equal((await manager.get(laterGroup.id)).status, "running", "cancelling wait_any cancelled its child");
    assert.equal((await manager.cancel(laterGroup.id)).status, "cancelled");

    let rejectFailingGroup;
    const failing = await manager.start({ sessionId: "session-a", backend: "native", mode: "chain", summary: "chain 2: failure" }, async () => {
      await new Promise((_resolve, reject) => { rejectFailingGroup = reject; });
      return { text: "unexpected", failed: false };
    });
    childTracker.register(failing, [{ label: "step 1" }, { label: "step 2" }]);
    childTracker.update(failing.id, [{ child: 1, label: "step 1", status: "running" }]);
    rejectFailingGroup(new Error("expected failure"));
    const failedGroup = (await manager.wait(failing.id, 2000)).record;
    assert.equal(failedGroup.status, "failed");
    assert.deepEqual(childTracker.reconcile(failedGroup).map((child) => child.status), ["failed", "skipped"]);
    assert.equal((await manager.list("session-a", 10)).length, 7);

    const firstParallelChildId = "subagent-child-111111111111111111111111";
    const secondParallelChildId = "subagent-child-222222222222222222222222";
    const parallel = await manager.start({
      sessionId: "session-a", backend: "native", mode: "parallel", summary: "two reports",
      children: [
        { childId: firstParallelChildId, label: "worker", task: "first" },
        { childId: secondParallelChildId, label: "worker", task: "second" },
      ],
    }, async () => ({
      text: "bounded preview", failed: false,
      reports: [
        { child: 2, childId: secondParallelChildId, label: "worker", text: "second full report" },
        { child: 1, childId: firstParallelChildId, label: "worker", text: "first full report" },
      ],
    }));
    const completedParallel = (await manager.wait(parallel.id, 2000)).record;
    assert.deepEqual(completedParallel.artifacts.map((artifact) => [artifact.child, artifact.childId]), [
      [1, firstParallelChildId], [2, secondParallelChildId],
    ], "out-of-order reports lost their stable child mapping");
    await assert.rejects(manager.readResult(parallel.id), /require a child number or child_id/);
    const firstParallelByNumber = await manager.readResult(parallel.id, 1);
    assert.equal(firstParallelByNumber.text, "first full report");
    assert.equal(firstParallelByNumber.childId, firstParallelChildId);
    const secondParallelById = await manager.readResult(parallel.id, secondParallelChildId);
    assert.equal(secondParallelById.child, 2);
    assert.equal(secondParallelById.text, "second full report");
    assert.equal(secondParallelById.childId, secondParallelChildId);

    const preIdentity = await manager.start({
      sessionId: "session-a", backend: "native", mode: "single", summary: "legacy identity boundary",
    }, async () => ({
      text: "legacy preview", failed: false,
      reports: [{ child: 1, childId: firstParallelChildId, label: "legacy", text: "legacy report" }],
    }));
    const completedPreIdentity = (await manager.wait(preIdentity.id, 2000)).record;
    assert.equal(Object.hasOwn(completedPreIdentity.artifacts[0], "childId"), false, "pre-identity artifact minted a controllable child ID");
    assert.equal(Object.hasOwn(await manager.readResult(preIdentity.id, 1), "childId"), false, "pre-identity result exposed a controllable child ID");
    await assert.rejects(manager.readResult(preIdentity.id, firstParallelChildId), /child_id .* is unavailable/);

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
    grep -F 'waitForAnyBackgroundSubagentChild(backgroundManager, childTracker, snapshot' ${self}/subagent/index.ts >/dev/null
    grep -F 'waitForAllBackgroundSubagentGroups(backgroundManager, snapshot' ${self}/subagent/index.ts >/dev/null
    grep -F 'operation === "wait" || operation === "wait_group"' ${self}/subagent/index.ts >/dev/null
    grep -F 'childProgress.capture(partial)' ${self}/subagent/index.ts >/dev/null
    grep -F 'backgroundState: "pending"' ${self}/subagent/index.ts >/dev/null
    grep -F 'releaseForegroundOwnership();' ${self}/subagent/index.ts >/dev/null
    grep -F '.filter((record) => !this.runtime.pendingLaunches.has(record.id))' ${self}/subagent/background.ts >/dev/null
    grep -F 'args.push("--no-extensions", "--extension", permissionProxyEntrypoint);' ${self}/subagent/index.ts >/dev/null
    grep -F 'const permissionAuthority = currentSubagentPermissionAuthority();' ${self}/subagent/index.ts >/dev/null
    grep -F 'SUBAGENT_PERMISSION_BASH_TOOL' ${self}/subagent/index.ts >/dev/null
    grep -F 'trustedNixStoreFile' ${self}/subagent/index.ts >/dev/null
    if grep -F 'this.socket.unref()' ${self}/subagent/permission-proxy.ts >/dev/null; then
      echo 'child permission relay socket must keep Pi RPC mode alive' >&2
      exit 1
    fi
    if grep -F 'isError:' ${self}/subagent/permission-proxy.ts >/dev/null; then
      echo 'child permission proxy must throw fatal tool failures rather than return ignored isError metadata' >&2
      exit 1
    fi
    grep -F 'waitForGracefulShutdown' ${self}/subagent/index.ts >/dev/null
    # The protocol fixture above behaviorally covers steer, follow-up,
    # interruption, handled prompts, ordering, shutdown, and process cleanup.
    grep -F '["--mode", "rpc"]' ${self}/subagent/index.ts >/dev/null
    grep -F 'backgroundSubagentsSurviveShutdown(event.reason)' ${self}/subagent/index.ts >/dev/null
    grep -F 'backgroundManager.beginReloadAdoption(sessionId)' ${self}/subagent/index.ts >/dev/null
    grep -F 'manager.activateSession(sessionId)' ${self}/subagent/index.ts >/dev/null
    grep -F 'generation !== sessionGeneration || lifecycleClosing || sessionContext !== ctx' ${self}/subagent/index.ts >/dev/null
    grep -F 'await permissionAuthority.waitUntilActive(signal)' ${self}/subagent/index.ts >/dev/null
    if grep -F 'permissionAuthority && !permissionAuthority.active' ${self}/subagent/index.ts >/dev/null \
      || grep -F '!permissionAuthority.active || !installedPermissionProxyEntrypoint()' ${self}/subagent/index.ts >/dev/null; then
      echo 'native subagent launch still rejects the bounded Permission Gate reload gap' >&2
      exit 1
    fi
    grep -F 'const committed = this.authority.commit(prepared.ticket, exactRequest);' ${self}/subagent/permission-relay.ts >/dev/null
    grep -F 'Notification: subagent ''${record.id} ''${record.status}. Check its status.' ${self}/subagent/index.ts >/dev/null
    grep -F 'backgroundOperationConsumedJobIds(background)' ${self}/subagent/index.ts >/dev/null
    grep -F 'const durableOperations = deliveredOperationIds(entries);' ${self}/subagent/index.ts >/dev/null
    if grep -F 'consumeForOperation' ${self}/subagent/index.ts >/dev/null; then
      echo 'lifecycle operation still marks consumption before Pi accepts its tool result' >&2
      exit 1
    fi
    grep -F '{ deliverAs: "steer", triggerTurn: true }' ${self}/subagent/index.ts >/dev/null
    if grep -F 'Do not claim dependent work complete' ${self}/subagent/index.ts >/dev/null \
      || grep -F 'running-reminder' ${self}/subagent/index.ts >/dev/null \
      || grep -F 'deliverAs: ctx.isIdle() ? "nextTurn"' ${self}/subagent/index.ts >/dev/null; then
      echo 'background lifecycle text leaked internal model guidance or running reminders' >&2
      exit 1
    fi
    grep -F '(cfg.extensions.sandbox.enable || cfg.extensions.subagent.enable)' ${self}/nix/module.nix >/dev/null
    grep -F 'builtins.elem "sandbox" extensions' ${self}/nix/mk-extension-bundle.nix >/dev/null
    grep -F '"''${extDir}/subagent/backend.ts".source = "''${self}/subagent/backend.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/background.ts".source = "''${self}/subagent/background.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/control.ts".source = "''${self}/subagent/control.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/foreground-handoff.ts".source = "''${self}/subagent/foreground-handoff.ts";' ${self}/nix/module.nix >/dev/null
    grep -F '"''${extDir}/subagent/native-rpc.ts".source = "''${self}/subagent/native-rpc.ts";' ${self}/nix/module.nix >/dev/null
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
      test -f "$bundle/subagent/control.ts"
      test -f "$bundle/subagent/foreground-handoff.ts"
      test -f "$bundle/subagent/native-rpc.ts"
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
