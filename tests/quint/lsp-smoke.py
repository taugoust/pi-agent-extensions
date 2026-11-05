"""Template LSP smoke test adapted to the actual retained-task specification.

Based on taugoust/flake-templates at ab2a17e, quint/tests/lsp-smoke.py.
The server receives edits in memory; the source file is never modified.
"""

import json
import pathlib
import queue
import subprocess
import sys
import threading
import time


server = subprocess.Popen(
    ["quint-language-server", "--stdio"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)
messages = queue.Queue()


def read_messages():
    try:
        while True:
            headers = {}
            while line := server.stdout.readline():
                if line == b"\r\n":
                    break
                key, value = line.decode().split(":", 1)
                headers[key.lower()] = value.strip()
            if not headers:
                return
            messages.put(json.loads(server.stdout.read(int(headers["content-length"]))))
    except Exception as error:
        messages.put(error)


def send(method, params=None, request_id=None):
    message = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        message["params"] = params
    if request_id is not None:
        message["id"] = request_id
    body = json.dumps(message).encode()
    server.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    server.stdin.flush()


def receive_until(predicate):
    deadline = time.monotonic() + 20
    while True:
        message = messages.get(timeout=max(0, deadline - time.monotonic()))
        if isinstance(message, Exception):
            raise message
        if predicate(message):
            return message


threading.Thread(target=read_messages, daemon=True).start()
try:
    source = pathlib.Path(sys.argv[1]).resolve()
    uri = source.as_uri()
    send("initialize", {"processId": None, "rootUri": source.parent.as_uri(), "capabilities": {}}, 1)
    initialized = receive_until(lambda m: m.get("id") == 1)
    assert initialized["result"]["capabilities"]["hoverProvider"]
    send("initialized", {})
    send("textDocument/didOpen", {"textDocument": {
        "uri": uri, "languageId": "quint", "version": 1,
        "text": "module native_task { pure val broken = missingName }",
    }})
    errors = receive_until(lambda m: m.get("method") == "textDocument/publishDiagnostics"
                           and m["params"]["uri"] == uri
                           and any(d.get("severity") == 1 for d in m["params"]["diagnostics"]))
    assert any("missingName" in d["message"] for d in errors["params"]["diagnostics"])
    send("textDocument/didChange", {
        "textDocument": {"uri": uri, "version": 2},
        "contentChanges": [{"text": source.read_text()}],
    })
    receive_until(lambda m: m.get("method") == "textDocument/publishDiagnostics"
                  and m["params"]["uri"] == uri and not m["params"]["diagnostics"])
    send("textDocument/documentSymbol", {"textDocument": {"uri": uri}}, 2)
    symbols = receive_until(lambda m: m.get("id") == 2)
    assert "state" in json.dumps(symbols["result"]), symbols
    send("shutdown", request_id=3)
    shutdown = receive_until(lambda m: m.get("id") == 3)
    assert "error" not in shutdown, shutdown
    send("exit")
    assert server.wait(timeout=10) == 0
    print("LSP smoke test passed: initialize, diagnostics, real-model edits, symbols, shutdown")
finally:
    if server.poll() is None:
        server.kill()
        server.wait()
    server.stdin.close()
    server.stdout.close()
