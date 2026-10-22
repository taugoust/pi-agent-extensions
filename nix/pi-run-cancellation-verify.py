"""Read-only validation of the cancellation guards in the shipped Bun executable."""
import re
import sys
from pathlib import Path

binary = Path(sys.argv[1]).read_bytes().decode("utf-8", errors="replace")


def section(start, end):
    assert binary.count(start) == 1, f"Unexpected native section count: {start}"
    offset = binary.index(start)
    finish = binary.index(end, offset + len(start))
    return re.sub(r"\s+", "", binary[offset:finish])


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
print("PASS shipped native executable: loop=8 guards, dispatch=2 guards, transactional queues, aborted session terminal, fresh controllers")
