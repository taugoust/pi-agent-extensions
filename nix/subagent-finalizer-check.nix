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
    assert.equal(typeof subagentFinalizer, "function", "subagent-finalizer did not export an extension function");
    assert.match(message, /Finish now and return your answer/);

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
    try {
      delete process.env.AGENTSH_SUBAGENT_ID;
      delete process.env.PI_SUBAGENT_ID;

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
    }
    EOF

    node "$workdir/test.mjs" "$outdir"
    grep -F 'PI_SUBAGENT_ID: subagentId' ${self}/subagent/index.ts >/dev/null
    touch "$out"
  ''
