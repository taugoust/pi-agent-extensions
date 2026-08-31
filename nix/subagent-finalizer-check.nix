{ self, pkgs }:

pkgs.runCommand "subagent-finalizer-check"
  {
    nativeBuildInputs = [
      pkgs.gnugrep
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/subagent-finalizer-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir" "$outdir"

    cp -r ${self}/subagent-finalizer "$srcdir/"
    printf '%s\n' '{"type":"module"}' > "$srcdir/package.json"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/subagent-finalizer/index.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const compiledRoot = process.argv[2];
    const moduleUrl = pathToFileURL(path.join(compiledRoot, "subagent-finalizer/index.js")).href;
    const imported = await import(moduleUrl);
    const subagentFinalizer = imported.default?.default ?? imported.default ?? imported;
    const message = imported.SUBAGENT_FINALIZE_MESSAGE ?? imported.default?.SUBAGENT_FINALIZE_MESSAGE;
    const deadlineMessage = imported.SUBAGENT_DEADLINE_FINALIZE_MESSAGE ?? imported.default?.SUBAGENT_DEADLINE_FINALIZE_MESSAGE;
    const deadlineEnv = imported.AGENTSH_SUBAGENT_DEADLINE_ENV ?? imported.default?.AGENTSH_SUBAGENT_DEADLINE_ENV;
    const deadlineLead = imported.SUBAGENT_DEADLINE_WARNING_LEAD_MS ?? imported.default?.SUBAGENT_DEADLINE_WARNING_LEAD_MS;
    const deadlineWarningAt = imported.subagentDeadlineWarningAt ?? imported.default?.subagentDeadlineWarningAt;
    assert.equal(typeof subagentFinalizer, "function", "subagent-finalizer did not export an extension function");
    assert.match(message, /Finish now and return your answer/);
    assert.match(deadlineMessage, /execution deadline is near/);
    assert.equal(deadlineLead, 300000, "maximum deadline warning lead is not five minutes");
    assert.equal(deadlineWarningAt(1000, 121000), 91000, "two-minute deadline did not retain three quarters of its runtime before warning");
    assert.equal(deadlineWarningAt(1000, 7201000), 6901000, "long deadline did not retain the five-minute warning lead");

    function createPi() {
      const handlers = new Map();
      const sent = [];
      return {
        handlers,
        sent,
        on(event, handler) {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        },
        sendUserMessage(content, options) {
          sent.push({ content, options });
        },
      };
    }

    function turn(stopReason = "toolUse") {
      return {
        type: "turn_end",
        turnIndex: 1,
        message: { role: "assistant", stopReason },
        toolResults: [],
      };
    }

    function context(percent) {
      return {
        getContextUsage() {
          return { tokens: percent === null ? null : percent * 2000, contextWindow: 200000, percent };
        },
      };
    }

    const oldAgentSHId = process.env.AGENTSH_SUBAGENT_ID;
    const oldPiId = process.env.PI_SUBAGENT_ID;
    const oldDeadline = process.env[deadlineEnv];
    try {
      delete process.env.AGENTSH_SUBAGENT_ID;
      delete process.env.PI_SUBAGENT_ID;
      delete process.env[deadlineEnv];

      const parentPi = createPi();
      subagentFinalizer(parentPi);
      assert.equal(parentPi.handlers.size, 0, "top-level Pi unexpectedly enabled the subagent finalizer");

      process.env.AGENTSH_SUBAGENT_ID = "subagent-test";
      const agentShPi = createPi();
      subagentFinalizer(agentShPi);
      const handler = agentShPi.handlers.get("turn_end")?.[0];
      assert.equal(typeof handler, "function", "AgentSH subagent did not register a turn_end handler");

      await handler(turn(), context(null));
      await handler(turn(), context(90));
      await handler(turn("stop"), context(95));
      assert.equal(agentShPi.sent.length, 0, "finalizer fired without a continuing turn above 90%");

      await handler(turn(), context(90.01));
      assert.deepEqual(agentShPi.sent, [{ content: message, options: { deliverAs: "steer" } }]);

      await handler(turn(), context(99));
      assert.equal(agentShPi.sent.length, 1, "finalizer sent more than one urgent message");

      process.env[deadlineEnv] = String(Date.now() + 200);
      const deadlinePi = createPi();
      subagentFinalizer(deadlinePi);
      const deadlineStart = deadlinePi.handlers.get("session_start")?.[0];
      const deadlineTurn = deadlinePi.handlers.get("turn_end")?.[0];
      assert.equal(typeof deadlineStart, "function", "deadline finalizer did not register session_start");
      await deadlineStart({}, {});
      assert.equal(deadlinePi.sent.length, 0, "short deadline finalizer fired immediately at startup");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(deadlinePi.sent, [{ content: deadlineMessage, options: { deliverAs: "steer" } }]);
      await deadlineTurn(turn(), context(99));
      assert.equal(deadlinePi.sent.length, 1, "deadline and context pressure produced duplicate warnings");

      process.env[deadlineEnv] = String(Date.now() + 200);
      const shutdownPi = createPi();
      subagentFinalizer(shutdownPi);
      await shutdownPi.handlers.get("session_start")?.[0]({}, {});
      await shutdownPi.handlers.get("session_shutdown")?.[0]({}, {});
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(shutdownPi.sent.length, 0, "deadline warning fired after session shutdown");

      delete process.env[deadlineEnv];
      delete process.env.AGENTSH_SUBAGENT_ID;
      process.env.PI_SUBAGENT_ID = "native-subagent-test";
      const nativePi = createPi();
      subagentFinalizer(nativePi);
      const nativeHandler = nativePi.handlers.get("turn_end")?.[0];
      assert.equal(typeof nativeHandler, "function", "native subagent did not register a turn_end handler");
      await nativeHandler(turn("length"), context(91));
      assert.equal(nativePi.sent.length, 1, "length-limited native subagent did not receive the urgent message");
    } finally {
      if (oldAgentSHId === undefined) delete process.env.AGENTSH_SUBAGENT_ID;
      else process.env.AGENTSH_SUBAGENT_ID = oldAgentSHId;
      if (oldPiId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = oldPiId;
      if (oldDeadline === undefined) delete process.env[deadlineEnv];
      else process.env[deadlineEnv] = oldDeadline;
    }
    EOF

    node "$workdir/test.mjs" "$outdir"
    grep -F 'PI_SUBAGENT_ID: subagentId' ${self}/subagent/index.ts >/dev/null
    grep -F 'args.push("--extension", finalizerEntrypoint)' ${self}/subagent/index.ts >/dev/null
    touch "$out"
  ''
