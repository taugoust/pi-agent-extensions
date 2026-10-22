"""Exercise cancellation code embedded in the shipped Bun executable.

The extracted production functions run with their real release-bundle bindings
under Node. This validates the native artifact's code, not native-process I/O.
No guard counts or implementation-string matches stand in for behavior tests.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if len(sys.argv) != 4:
    raise SystemExit("Usage: verify.py NATIVE_BINARY RELEASE_ROOT REGRESSION_TEST")

binary = Path(sys.argv[1]).read_bytes().decode("utf-8", errors="replace")
source_root = Path(sys.argv[2]).resolve()
test = Path(sys.argv[3]).resolve()


def raw_section(text, start, end):
    # These checks validate the extraction, not the cancellation implementation.
    if text.count(start) != 1:
        raise ValueError(f"Ambiguous release function boundary: {start}")
    offset = text.index(start)
    finish = text.index(end, offset + len(start))
    return text[offset:finish]


chunks = source_root / "dist/bundle/chunks"
candidates = [p for p in chunks.glob("*.js") if "async function runLoop(" in p.read_text()]
if len(candidates) != 1:
    raise ValueError("Cannot uniquely identify the release's execution bundle")
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

# Keep fixtures beneath the release so real pinned npm dependencies resolve;
# never substitute a reimplementation of the Agent or its execution queues.
with tempfile.TemporaryDirectory(prefix="pi-native-cancellation-", dir=source_root) as directory:
    fixture = Path(directory)
    destination = fixture / "dist/bundle/chunks"
    shutil.copytree(chunks, destination)
    (destination / candidates[0].name).write_text(source)
    subprocess.run(["node", str(test), str(fixture), "bundle", "patched"], check=True, timeout=30)
print("PASS behavior of cancellation functions extracted from the shipped native executable", flush=True)
