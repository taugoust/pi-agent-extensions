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
        entry.write_text(entry.read_text() + "\nexport { installQuietState as reloadProbe, requireAcceptance as acceptanceProbe, defaultSubagentModel as modelProbe, dispatchIdleDecision as idleDecisionProbe };\n")
    old_config = root / "old/subagent/config.ts"
    old_config.write_text(old_config.read_text().replace('defaultModel: "gpt-6-luna"', 'defaultModel: "legacy-default"'))
    old_outcome = root / "old/subagent/outcome.ts"
    old_outcome.write_text(old_outcome.read_text().replace(
        "export function requireAcceptance(", "function priorRequireAcceptance("))
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
import {{ reloadProbe, acceptanceProbe, modelProbe, idleDecisionProbe }} from {json.dumps(str(live / "subagent/index.ts"))};
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
  pi.registerCommand("idleprobe", {{handler: async (_, ctx) => {{
    const params = {{child_id:"subagent-child-" + "a".repeat(24), request_id:"idle:" + "b".repeat(32), worker_epoch:"c".repeat(32), choice:"compact"}};
    let received;
    await idleDecisionProbe({{operation: async (actual, owner) => {{ received = {{actual, owner}}; return true; }} }}, params, "parent-session");
    if (received.actual.worker_epoch !== params.worker_epoch || received.actual.request_id !== params.request_id || received.owner !== "parent-session") throw new Error("idle decision identity forwarding failed");
    ctx.ui.notify("IDLE-FORWARD-OK");
  }}}});
  pi.registerCommand("modelprobe", {{handler: async (_, ctx) => {{ ctx.ui.notify(modelProbe); }}}});
  pi.registerCommand("acceptance", {{handler: async (_, ctx) => {{
    if (typeof acceptanceProbe !== "function") {{ ctx.ui.notify("OLD-ACCEPTANCE"); return; }}
    const criteria = acceptanceProbe(["Verify reload behavior"]);
    if (criteria[0] !== "Verify reload behavior") throw new Error("acceptance lost");
    let rejected = false;
    try {{ acceptanceProbe(undefined); }} catch {{ rejected = true; }}
    if (!rejected) throw new Error("missing acceptance was allowed");
    ctx.ui.notify("NEW-ACCEPTANCE");
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
        command("idleprobe", "IDLE-FORWARD-OK")
        command("acceptance", "OLD-ACCEPTANCE")
        command("modelprobe", "openai/legacy-default:low")
        for folder in folders:
            link = live / folder
            link.unlink()
            link.symlink_to(root / "new" / folder)
        command("reloadtest")
        command("probe", "WAKE")
        command("acceptance", "NEW-ACCEPTANCE")
        command("modelprobe", "openai/gpt-6-luna:low")
        assert process.pid == pid and process.poll() is None
        print("PASS: same-process subagent reload refreshed completion wake behavior")
    finally:
        process.terminate()
        process.communicate(timeout=5)
