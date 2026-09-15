"""Real Pi regression: replacing Nix-style links must refresh imported tool schemas.
Run with PI_BIN pointing to the supported Pi binary. No model/API calls or jobs.
"""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

source = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="pi-job-reload-") as tmp:
    root = Path(tmp)
    agent = root / "agent"
    extensions = agent / "extensions"
    extensions.mkdir(parents=True)
    for version in ("old", "new"):
        for folder in ("background-job", "shared"):
            destination = root / version / folder
            shutil.copytree(source / folder, destination)
            destination.chmod(0o700)
            for directory in destination.rglob("*"):
                if directory.is_dir():
                    directory.chmod(0o700)
    schema = root / "old/shared/background-job.ts"
    schema.chmod(0o600)
    schema.write_text(schema.read_text().replace("43_200_000", "30000"))
    for folder in ("background-job", "shared"):
        (extensions / folder).symlink_to(root / "old" / folder)
    (extensions / "probe.ts").write_text('''
export default function(pi) {
  pi.registerCommand("schema", {handler: async (_, ctx) => {
    const tool = pi.getAllTools().find(t => t.name === "background_job");
    ctx.ui.notify("MAX=" + tool?.parameters?.properties?.timeout_ms?.maximum);
  }});
  pi.registerCommand("reloadtest", {handler: async (_, ctx) => { await ctx.reload(); }});
}
''')
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
    process = subprocess.Popen(
        [os.environ["PI_BIN"], "--mode", "rpc", "--no-session"],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    buffered = b""

    def command(name, expected=None):
        global buffered
        request_id = f"{name}-{time.monotonic_ns()}"
        process.stdin.write((json.dumps({"id": request_id, "type": "prompt", "message": "/" + name}) + "\n").encode())
        process.stdin.flush()
        deadline = time.monotonic() + 15
        replied = False
        observed = expected is None
        while time.monotonic() < deadline:
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                frame = json.loads(line)
                if frame.get("id") == request_id:
                    assert frame.get("success"), frame
                    replied = True
                if frame.get("message") == expected:
                    observed = True
                if replied and observed:
                    return
            if select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                data = os.read(process.stdout.fileno(), 65536)
                assert data, "Pi exited before replying"
                buffered += data
        raise AssertionError(f"{name}: response={replied}, expected={expected}, observed={observed}")

    try:
        pid = process.pid
        command("schema", "MAX=30000")
        for folder in ("background-job", "shared"):
            link = extensions / folder
            link.unlink()
            link.symlink_to(root / "new" / folder)
        command("reloadtest")
        command("schema", "MAX=43200000")
        assert process.pid == pid and process.poll() is None
        print("PASS: same-process reload refreshed the background-job schema to 12 hours")
    finally:
        process.terminate()
        process.communicate(timeout=5)
