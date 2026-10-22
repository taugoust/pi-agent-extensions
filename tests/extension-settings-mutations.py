"""Small mutation-sensitivity check; alter only disposable source copies."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def killed(label, relative, old, new, command, expected_failure):
    with tempfile.TemporaryDirectory(prefix="pi-settings-mutant-") as directory:
        root = Path(directory)
        for subdir in ["tests", "shared", "nix"]:
            (root / subdir).mkdir()
        for path in ["tests/extension-settings.mjs", "tests/native-defaults.py",
                     "shared/snapshot-extension-settings.mjs",
                     "shared/extension-config-manifest.json", "nix/merge-native-defaults.py"]:
            shutil.copyfile(ROOT / path, root / path)
        target = root / relative
        contents = target.read_text()
        assert contents.count(old) == 1, f"mutation anchor changed: {label}"
        target.write_text(contents.replace(old, new))
        result = subprocess.run(command, cwd=root, env=os.environ, capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        if result.returncode == 0 or expected_failure not in output:
            raise AssertionError(f"mutant not killed by expected behavioral test: {label}\n{output}")
        print(f"KILLED: {label} ({expected_failure})", flush=True)


killed(
    "native seed deletes an existing destination before publishing (overwrites user settings)",
    "nix/merge-native-defaults.py",
    "if path.exists():\n        continue",
    "if path.exists():\n        path.unlink()",
    [sys.executable, "tests/native-defaults.py", "NativeDefaults.test_seed_once_private_complete_files_without_unrelated_changes"],
    "FAIL: test_seed_once_private_complete_files_without_unrelated_changes",
)
killed(
    "snapshot stale cleanup also deletes unrelated auth.json",
    "shared/snapshot-extension-settings.mjs",
    "await rm(target, { force: true });",
    'await rm(target, { force: true }); await rm(join(destinationRoot, "auth.json"), { force: true });',
    ["node", "--test", "--test-reporter=tap", "--test-name-pattern=empty source cleans",
     "tests/extension-settings.mjs"],
    "not ok 1 - empty source cleans only approved stale files, never cwd or unrelated files",
)
