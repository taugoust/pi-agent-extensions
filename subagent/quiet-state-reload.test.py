"""Exercise the real subagent import graph across Nix-style activation + Pi reload.
No model calls: intercept the wake send at the public extension API boundary.
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
with tempfile.TemporaryDirectory(prefix="pi-completion-reload-") as tmp:
    root = Path(tmp)
    agent = root / "agent"
    extensions = agent / "extensions"
    extensions.mkdir(parents=True)
    live = root / "live"
    live.mkdir()
    folders = ("subagent", "shared", "background-job", "permission-gate")
    for version in ("old", "new"):
        for folder in folders:
            destination = root / version / folder
            shutil.copytree(source / folder, destination)
            destination.chmod(0o700)
            for item in destination.rglob("*"):
                item.chmod(0o700 if item.is_dir() else 0o600)
        # Expose the entrypoint's actual imported binding to the fixture, without
        # initializing the subagent launcher or changing production exports.
        entry = root / version / "subagent/index.ts"
        entry.write_text(entry.read_text() + "\nexport { installQuietState as reloadProbe };\n")
    (root / "old/shared/quiet-state.ts").write_text('''
export function installQuietState(pi) {
  return { enqueue(ctx, update) {
    pi.appendEntry("old-quiet-fixture", update);
    ctx.ui.notify("SILENT");
    return true;
  }};
}
export function notifyParent() { throw new Error("not used by this fixture"); }
''')
    for folder in folders:
        (live / folder).symlink_to(root / "old" / folder)
    (extensions / "probe.ts").write_text(f'''
import {{ reloadProbe }} from {json.dumps(str(live / "subagent/index.ts"))};
export default function(pi) {{
  let current;
  let sequence = 0;
  const quiet = reloadProbe({{ ...pi, sendMessage(message, options) {{
    if (message.customType !== "harness-state" || options.triggerTurn !== true)
      throw new Error("completion did not request a model wake");
    current.ui.notify("WAKE");
  }} }}, 0);
  pi.registerCommand("probe", {{handler: async (_, ctx) => {{
    current = ctx;
    quiet.enqueue(ctx, {{kind:"subagent", id:"reload-probe-" + (++sequence), completion:true, state:"completed"}});
  }}}});
  pi.registerCommand("reloadtest", {{handler: async (_, ctx) => {{ await ctx.reload(); }} }});
}}
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
                if frame.get("id") == request_id:
                    assert frame.get("success"), frame
                    replied = True
                if frame.get("message") == expected:
                    observed = True
                if replied and observed:
                    return
            if select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                data = os.read(process.stdout.fileno(), 65536)
                if not data:
                    stderr = process.stderr.read().decode("utf-8", errors="replace")
                    raise AssertionError(f"Pi exited before replying (returncode={process.poll()}): {stderr[-8000:]}")
                buffered += data
        raise AssertionError(f"{name}: reply={replied}, expected={expected}, observed={observed}")

    try:
        pid = process.pid
        command("probe", "SILENT")
        for folder in folders:
            link = live / folder
            link.unlink()
            link.symlink_to(root / "new" / folder)
        command("reloadtest")
        command("probe", "WAKE")
        assert process.pid == pid and process.poll() is None
        print("PASS: same-process subagent reload refreshed completion wake behavior")
    finally:
        process.terminate()
        process.communicate(timeout=5)
