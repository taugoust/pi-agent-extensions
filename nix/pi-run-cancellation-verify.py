"""Read-only validation of the cancellation guards in the shipped Bun executable."""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

binary = Path(sys.argv[1]).read_bytes().decode("utf-8", errors="replace")


def raw_section(text, start, end):
    assert text.count(start) == 1, f"Unexpected section count: {start}"
    offset = text.index(start)
    finish = text.index(end, offset + len(start))
    return text[offset:finish]


def section(start, end):
    return re.sub(r"\s+", "", raw_section(binary, start, end))


loop = section("async function runLoop(", "function declareToolChanges(")
assert loop.count("signal?.throwIfAborted()") == 8, "Missing native loop cancellation guards"
assert "finally{" in loop
assert 'config.restorePendingMessages?.(pendingMessages,pendingKind)' in loop
assert re.search(r'pendingMessages=\[\];for\(constmessage\d*ofadmittedMessages\)', loop)
response = section("async function streamAssistantResponse(", "async function failToolCallsFromTruncatedMessage(")
assert response.count("signal?.throwIfAborted()") == 2, "Missing native model-dispatch guards"
config = section("createLoopConfig(options = {})", "async runWithLifecycle(")
assert config.count("this.signal?.throwIfAborted()") == 2
assert "queue.messages.unshift(...messages)" in config
prompt = section("async _runAgentPrompt(", "async _handlePostAgentRun(")
assert 'this._lastAssistantMessage?.stopReason!=="aborted"' in prompt
assert 'this._lastAssistantMessage?.stopReason==="aborted")' in prompt
assert 'this._finishCancelledRetry()' in prompt
lifecycle = section("async runWithLifecycle(", "async handleRunFailure(")
assert "newAbortController" in lifecycle
assert 'abortController.signal.aborted&&this._state.messages.at(-1)?.stopReason!=="aborted"' in lifecycle
assert 'abortController.signal.throwIfAborted()' in lifecycle
print("PASS shipped native executable: loop=8 guards, dispatch=2 guards, transactional queues, aborted session terminal, fresh controllers", flush=True)

if len(sys.argv) == 4:
    # Do not stop at matching source patterns. Execute the function bodies
    # actually embedded in the shipped executable using the real builtin bundle
    # lexical bindings under Node. No reconstructed cancellation implementation.
    # This is the Node-entry + shipped-bundle validation route, not a claim that
    # the fake-provider harness ran inside the native Pi process.
    source_root = Path(sys.argv[2]).resolve()
    test = Path(sys.argv[3]).resolve()
    chunks = source_root / "dist/bundle/chunks"
    candidates = [p for p in chunks.glob("*.js") if "async function runLoop(" in p.read_text()]
    assert len(candidates) == 1
    source = candidates[0].read_text()
    for start, end in [
        ("async function runLoop(", "function declareToolChanges("),
        ("async function streamAssistantResponse(", "async function failToolCallsFromTruncatedMessage("),
        ("createLoopConfig(options = {})", "async runWithLifecycle("),
        ("async runWithLifecycle(", "async handleRunFailure("),
        ("async _runAgentPrompt(", "async _handlePostAgentRun("),
    ]:
        original = raw_section(source, start, end)
        embedded = raw_section(binary, start, end)
        source = source.replace(original, embedded, 1)
    # Place the fixture beneath source_root so bundled external dependencies
    # resolve to the release's real npm node_modules, never user/global modules.
    with tempfile.TemporaryDirectory(prefix="pi-native-cancellation-", dir=source_root) as directory:
        fixture = Path(directory)
        destination = fixture / "dist/bundle/chunks"
        shutil.copytree(chunks, destination)
        (destination / candidates[0].name).write_text(source)
        subprocess.run(["node", str(test), str(fixture), "bundle", "patched"], check=True, timeout=30)
    print("PASS regression executed cancellation functions extracted from actual shipped native executable", flush=True)
