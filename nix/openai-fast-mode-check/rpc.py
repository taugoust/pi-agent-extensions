# Usage: python3 rpc.py PI EXTENSION AGENT_DIR
import json
import os
import pathlib
import select
import subprocess
import sys
import time

pi, extension, agent = sys.argv[1:]
env = dict(os.environ)
env.update({"PI_OFFLINE": "1", "PI_CODING_AGENT_DIR": agent,
            "HOME": str(pathlib.Path(agent).parent)})
process = subprocess.Popen([
    pi, "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extension,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)


def request(message_type, **extra):
    request.i += 1
    payload = {"id": request.i, "type": message_type, **extra}
    process.stdin.write(json.dumps(payload) + "\n")
    process.stdin.flush()
    deadline = time.time() + 15
    while time.time() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], 0.2)
        if not ready:
            continue
        line = process.stdout.readline()
        if not line:
            break
        message = json.loads(line)
        if message.get("id") == request.i:
            if message.get("error"):
                raise RuntimeError(message)
            return message
    raise RuntimeError(f"timed out waiting for {payload}")


request.i = 0

commands = request("get_commands")
encoded = json.dumps(commands)
if encoded.count('"fast"') != 1:
    raise RuntimeError(f"fast command was not loaded exactly once: {encoded}")

config = pathlib.Path(agent) / "extensions" / "pi-openai-fast-mode" / "config.json"
deadline = time.time() + 5
while not config.exists() and time.time() < deadline:
    time.sleep(0.05)
if not config.exists() or json.loads(config.read_text()).get("enabled") is not False:
    raise RuntimeError("fast mode did not initialize disabled")

expected = [("on", True), ("off", False), ("", True), ("toggle", False)]
for argument, value in expected:
    suffix = f" {argument}" if argument else ""
    request("prompt", message=f"/fast{suffix}")
    deadline = time.time() + 5
    while time.time() < deadline:
        if json.loads(config.read_text()).get("enabled") is value:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError(f"/fast {argument} did not persist {value}")

process.stdin.close()
process.terminate()
process.wait(timeout=5)
stderr = process.stderr.read()
if stderr.strip():
    raise RuntimeError(f"unexpected pi stderr: {stderr}")
