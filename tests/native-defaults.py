"""Behavioral tests of the activation script, with no Pi/account/service process."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "nix/merge-native-defaults.py"


class NativeDefaults(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-native-defaults-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.agent = self.root / "agent"
        self.source = self.root / "defaults.json"

    def configure(self, value):
        self.source.write_text(json.dumps(value))

    def run_seed(self, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.agent), str(self.source)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def test_seed_once_private_complete_files_without_unrelated_changes(self):
        self.configure({"settings": {"nested": {"enabled": False}, "list": [1, 2]}, "keybindings": {}})
        self.run_seed()
        original = (self.agent / "settings.json").read_bytes()
        self.assertEqual(json.loads(original), {"nested": {"enabled": False}, "list": [1, 2]})
        for name in ["settings.json", "keybindings.json"]:
            self.assertEqual((self.agent / name).stat().st_mode & 0o777, 0o600)
        (self.agent / "auth.json").write_text("fixture-secret")
        self.configure({"settings": {"replacement": True}, "keybindings": {"replacement": True}})
        self.run_seed()
        self.assertEqual((self.agent / "settings.json").read_bytes(), original)
        self.assertEqual(json.loads((self.agent / "keybindings.json").read_text()), {})
        self.assertEqual((self.agent / "auth.json").read_text(), "fixture-secret")
        self.assertEqual(sorted(p.name for p in self.agent.iterdir()), ["auth.json", "keybindings.json", "settings.json"])

    def test_existing_malformed_files_directories_and_symlinks_are_not_read_or_changed(self):
        self.agent.mkdir()
        self.configure({"settings": {}, "keybindings": {}, "models": {}, "extra": {}})
        (self.agent / "settings.json").write_bytes(b"not-json\xff")
        (self.agent / "keybindings.json").mkdir()
        outside = self.root / "outside.json"
        outside.write_text("unchanged")
        (self.agent / "models.json").symlink_to(outside)
        dangling = self.agent / "extra.json"
        dangling.symlink_to(self.root / "absent")
        result = self.run_seed()
        self.assertIn("leaving symlinked", result.stderr)
        self.assertEqual((self.agent / "settings.json").read_bytes(), b"not-json\xff")
        self.assertTrue((self.agent / "keybindings.json").is_dir())
        self.assertTrue((self.agent / "models.json").is_symlink())
        self.assertTrue(dangling.is_symlink())
        self.assertEqual(outside.read_text(), "unchanged")
        self.assertFalse((self.root / "absent").exists())

    def test_empty_missing_and_malformed_sources(self):
        self.configure({})
        self.run_seed()
        self.assertEqual(list(self.agent.iterdir()), [])
        (self.agent / "settings.json").write_text("keep")
        for contents in ["{", "null", "[]"]:
            with self.subTest(contents=contents):
                self.source.write_text(contents)
                self.run_seed(success=False)
                self.assertEqual((self.agent / "settings.json").read_text(), "keep")
                self.assertEqual([p.name for p in self.agent.iterdir()], ["settings.json"])
        self.source.unlink()
        self.run_seed(success=False)
        self.assertEqual((self.agent / "settings.json").read_text(), "keep")

    def test_concurrent_seeders_publish_one_complete_winner_and_leave_no_temps(self):
        processes = []
        candidates = []
        for i in range(12):
            value = {"winner": i, "payload": str(i) * 10000}
            candidates.append(value)
            source = self.root / f"source-{i}.json"
            source.write_text(json.dumps({"settings": value}))
            processes.append(subprocess.Popen([sys.executable, str(SCRIPT), str(self.agent), str(source)],
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        for process in processes:
            _, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, stderr)
        self.assertIn(json.loads((self.agent / "settings.json").read_text()), candidates)
        self.assertEqual([p.name for p in self.agent.iterdir()], ["settings.json"])

    def test_native_writer_winning_after_exists_check_is_never_overwritten(self):
        self.configure({"settings": {"seed": True}})
        # Inject only a scheduling seam at the actual publication syscall. The
        # production script still performs all checks/writes/link/error cleanup.
        wrapper = '''
import os, pathlib, runpy, sys
original = os.link
def raced_link(source, destination, *args, **kwargs):
    pathlib.Path(destination).write_text('{"nativeWinner":true}\\n')
    return original(source, destination, *args, **kwargs)
os.link = raced_link
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
'''
        result = subprocess.run([sys.executable, "-c", wrapper, str(SCRIPT), str(self.agent), str(self.source)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.agent / "settings.json").read_text()), {"nativeWinner": True})
        self.assertEqual([p.name for p in self.agent.iterdir()], ["settings.json"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
