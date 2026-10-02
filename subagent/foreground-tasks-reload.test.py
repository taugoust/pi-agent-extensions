"""Exercise foreground-task imports across same-process Nix-style retarget + Pi reload."""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

source = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="pi-foreground-reload-") as tmp:
    root = Path(tmp)
    agent = root / "agent"
    extensions = agent / "extensions"
    extensions.mkdir(parents=True)
    live = root / "live"
    live.mkdir()
    folders = ("permission-gate", "questionnaire", "shared")
    new_source = root / "new"
    for folder in folders:
        destination = new_source / folder
        shutil.copytree(source / folder, destination)
        destination.chmod(0o700)
        for item in destination.rglob("*"):
            item.chmod(0o700 if item.is_dir() else 0o600)
    old_source = root / "old"
    for folder in folders:
        (old_source / folder).mkdir(parents=True)
    # Previous source was healthy but predates this new shared module.
    (old_source / "permission-gate/index.ts").write_text('''
export default function(pi) {
  pi.registerCommand("permission-gate", { handler: async (_args, ctx) => ctx.ui.notify("OLD_GATE") });
}
''')
    (old_source / "questionnaire/index.ts").write_text('''
export default function(pi) {
  pi.registerCommand("questionnaire", { handler: async (_args, ctx) => ctx.ui.notify("OLD_QUESTIONNAIRE") });
}
''')
    for folder in folders:
        (live / folder).symlink_to(old_source / folder)

    (extensions / "probe.ts").write_text(f'''
import gate from {json.dumps(str(live / "permission-gate/index.ts"))};
import questionnaire from {json.dumps(str(live / "questionnaire/index.ts"))};
export default function(pi) {{ gate(pi); questionnaire(pi); }}
''')
    (extensions / "controller.ts").write_text('''
export default function(pi) {
  pi.registerCommand("reloadtest", {handler: async (_, ctx) => { await ctx.reload(); }});
  pi.registerCommand("gateprobe", {handler: async (_, ctx) => {
    const operator = globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__;
    if (!operator) throw new Error("permission-gate operator not registered");
    ctx.ui.notify("GATE_PROBE_OK");
  }});
}
''')

    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
    for key in list(env):
        if key.startswith(("AGENTSH_", "PI_SUBAGENT_", "PI_TUI_WORKER_")):
            del env[key]
    process = subprocess.Popen(
        [os.environ["PI_BIN"], "--mode", "rpc", "--no-session"],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    buffered = b""
    observed_frames = []

    def command(name, expected=None):
        global buffered
        request_id = f"{name}-{time.monotonic_ns()}"
        process.stdin.write((json.dumps({"id": request_id, "type": "prompt", "message": "/" + name}) + "\n").encode())
        process.stdin.flush()
        deadline = time.monotonic() + 15
        replied, observed = False, expected is None
        while time.monotonic() < deadline:
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                frame = json.loads(line)
                observed_frames.append(frame)
                if frame.get("id") == request_id:
                    assert frame.get("success"), frame
                    replied = True
                if expected and expected in json.dumps(frame):
                    observed = True
                if replied and observed:
                    return
            if select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                data = os.read(process.stdout.fileno(), 65536)
                if not data:
                    stderr = process.stderr.read().decode("utf-8", errors="replace")
                    raise AssertionError(f"Pi exited (returncode={process.poll()}): {stderr[-8000:]}")
                buffered += data
        raise AssertionError(f"{name}: reply={replied}, expected={expected}, observed={observed}; frames={observed_frames[-30:]!r}")

    try:
        command("permission-gate", "OLD_GATE")
        command("questionnaire", "OLD_QUESTIONNAIRE")
        # Retarget the Nix-style source link and reload the actual importing
        # extension in the same Pi process. The new entrypoints require a shared
        # module absent from old_source; successful registration proves the
        # explicit .ts imports resolve relative to the replacement source.
        for folder in folders:
            link = live / folder
            link.unlink()
            link.symlink_to(new_source / folder)
        command("reloadtest")
        command("gateprobe", "GATE_PROBE_OK")
        print("PASS: old .js import fails across symlink retarget; explicit .ts import reloads successfully")
    finally:
        process.terminate()
        process.communicate(timeout=5)
