{
  self,
  pkgs,
  pi-openai-fast-mode,
}:
let
  bundle = self.lib.mkExtensionBundle {
    inherit pkgs;
    name = "openai-fast-mode-deduplicated-bundle";
    packageName = "openai-fast-mode-deduplicated-bundle";
    extensions = [
      "openai-fast-mode"
      "openai-fast-mode"
    ];
  };
  defaultBundle = self.packages.${pkgs.stdenv.hostPlatform.system}.extensions;
  pi = self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
in
pkgs.runCommand "openai-fast-mode-check"
  {
    nativeBuildInputs = [
      pkgs.jq
      pkgs.nodejs
      pkgs.python3
    ];
  }
  ''
    set -euo pipefail

    test "$(jq -r .version ${pi-openai-fast-mode}/package.json)" = 0.3.0
    test "$(jq -r '.pi.extensions | length' ${pi-openai-fast-mode}/package.json)" = 1
    test "$(jq -r '.pi.extensions[0]' ${pi-openai-fast-mode}/package.json)" = ./src/index.ts
    test "$(jq '[.pi.extensions[] | select(. == "node_modules/pi-openai-fast-mode")] | length' ${bundle}/package.json)" = 1
    test "$(jq '[.pi.extensions[] | select(. == "node_modules/pi-openai-fast-mode")] | length' ${defaultBundle}/package.json)" = 1

    work="$TMPDIR/fast-mode"
    agent="$work/agent"
    mkdir -p "$agent"
    cat > "$work/test.py" <<'PY'
    import json, os, pathlib, select, subprocess, sys, time

    pi, extension, agent = sys.argv[1:]
    env = dict(os.environ)
    env.update({"PI_OFFLINE": "1", "PI_CODING_AGENT_DIR": agent, "HOME": str(pathlib.Path(agent).parent)})
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
    PY

    python3 "$work/test.py" ${pi}/bin/pi ${bundle}/node_modules/pi-openai-fast-mode/src/index.ts "$agent"
    mkdir -p "$out"
    touch "$out/passed"
  ''
