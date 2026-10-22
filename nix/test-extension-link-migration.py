"""Run the production helper and real generated HM activation blocks, offline."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

helper, contract_file, old_generation, new_generation, activation = sys.argv[1:]
sys.argv = sys.argv[:1]
spec = importlib.util.spec_from_file_location("migration", helper)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
contract = json.loads(Path(contract_file).read_text())
root = contract["root"]
paths = [f"{root}/extensions/{name}" for name in contract["names"]]
old_files = (Path(old_generation) / "home-files").resolve()


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        (self.home / root / "extensions").mkdir(parents=True)
        for path in paths:
            (self.home / path).symlink_to(old_files / path)
        self.preferences = self.home / root / "settings.json"
        self.preferences.write_text('mutable preferences')
        self.auth = self.home / root / "auth.json"
        self.auth.write_text('credentials')

    def tearDown(self):
        self.assertEqual(self.preferences.read_text(), 'mutable preferences')
        self.assertEqual(self.auth.read_text(), 'credentials')
        self.temp.cleanup()

    def run_block(self, name, dry=False, generation=old_generation, profile='', modern_dry=False):
        # Only relocate the declared home for sandbox fixtures. All executable
        # code, paths, canonical names and HM check/link logic are production.
        block = contract[name].replace('/fixture-home', str(self.home))
        script = 'set -e\n' + contract['initialization'] + '\n' + block
        env = dict(os.environ, HOME=str(self.home), oldGenPath=generation,
                   genProfilePath=str(profile),
                   newGenPath=new_generation, DRY_RUN_CMD='echo' if dry else '',
                   HOME_MANAGER_BACKUP_EXT='', HOME_MANAGER_BACKUP_COMMAND='',
                   HOME_MANAGER_BACKUP_OVERWRITE='', VERBOSE_ARG='')
        env.pop('DRY_RUN', None)
        if modern_dry:
            env['DRY_RUN'] = '1'
        return subprocess.run(['bash', '-c', script], env=env, text=True, capture_output=True)

    def backups(self):
        return list(self.home.glob('.pi-extension-link-backup-*/link-*/original'))

    def test_real_hm_collision_migration_link_and_retry(self):
        before = self.run_block('collision')
        self.assertNotEqual(before.returncode, 0, before.stdout + before.stderr)
        self.assertIn('would be clobbered', before.stdout + before.stderr)
        result = self.run_block('migration')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        backups = self.backups()
        self.assertEqual(len(backups), len(paths))
        self.assertEqual({os.readlink(p) for p in backups}, {str(old_files / p) for p in paths})
        for p in backups:
            self.assertTrue(p.is_symlink())
            self.assertEqual(stat.S_IMODE(p.parent.parent.stat().st_mode), 0o700)
        for name in ('migration', 'collision', 'linking', 'migration', 'collision'):
            result = self.run_block(name)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.backups(), backups)
        for path in paths:
            self.assertFalse((self.home / path).is_symlink())
            self.assertTrue((self.home / path / 'index.ts').is_symlink())
            self.assertEqual((self.home / path / 'index.ts').read_text().strip(), 'new')
        # The archived source and the entire old generation remain intact.
        self.assertEqual((old_files / paths[0] / 'index.ts').read_text().strip(), 'old')

    def test_dry_run(self):
        for kwargs in ({'dry': True}, {'modern_dry': True}):
            result = self.run_block('migration', **kwargs)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.backups(), [])
        for path in paths:
            self.assertEqual(os.readlink(self.home / path), str(old_files / path))

    def test_missing_or_unrelated_generation(self):
        migration.migrate(self.home, '', paths)
        migration.migrate(self.home, self.home, paths)
        migration.migrate(self.home, new_generation, paths)
        self.assertEqual(self.backups(), [])
        self.assertTrue(all((self.home / path).is_symlink() for path in paths))

    def test_cross_host_old_generation_with_proven_profile_history(self):
        profile = self.home / 'profiles' / 'home-manager'
        profile.parent.mkdir()
        (profile.parent / 'home-manager-11-link').symlink_to(old_generation)
        (profile.parent / 'home-manager-12-link').symlink_to(new_generation)
        profile.symlink_to('home-manager-12-link')
        result = self.run_block('migration', generation=new_generation, profile=profile)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.backups()), len(paths))
        self.assertEqual(self.run_block('collision').returncode, 0)

    def test_unproven_store_tree_and_fake_history_are_not_ownership(self):
        profile = self.home / 'profiles' / 'home-manager'
        profile.parent.mkdir()
        # Even a genuine home-files tree isn't proof without an HM generation.
        (profile.parent / 'home-manager-1-link').symlink_to(old_files)
        (profile.parent / 'not-home-manager-2-link').symlink_to(old_generation)
        migration.migrate(self.home, new_generation, paths, profile=profile)
        self.assertEqual(self.backups(), [])
        self.assertTrue(all((self.home / path).is_symlink() for path in paths))

    def test_unknown_manual_and_custom_store_sources(self):
        for path in paths:
            (self.home / path).unlink()
        (self.home / paths[0]).mkdir()
        custom = self.home / paths[1]
        custom.symlink_to((old_files / paths[1]).resolve())
        (self.home / paths[2]).symlink_to('/unrelated/manual')
        unknown = self.home / root / 'extensions/disabled'
        unknown.symlink_to(old_files / paths[0])
        migration.migrate(self.home, old_generation, paths)
        self.assertEqual(self.backups(), [])
        self.assertTrue((self.home / paths[0]).is_dir())
        self.assertEqual(os.readlink(custom), str((old_files / paths[1]).resolve()))
        self.assertEqual(os.readlink(unknown), str(old_files / paths[0]))

    def test_wrong_relative_target(self):
        p = self.home / paths[0]
        p.unlink()
        p.symlink_to(old_files / paths[1])
        migration.migrate(self.home, old_generation, [paths[0]])
        self.assertEqual(self.backups(), [])
        self.assertTrue(p.is_symlink())

    def test_backup_and_rename_failures_preserve_original(self):
        for target in ('mkdir', 'rename'):
            with patch.object(migration.os, target, side_effect=OSError('injected failure')):
                with self.assertRaises(OSError):
                    migration.migrate(self.home, old_generation, paths)
            self.assertEqual(self.backups(), [])
            for path in paths:
                self.assertEqual(os.readlink(self.home / path), str(old_files / path))

    def test_existing_backup_link_not_followed_or_overwritten(self):
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        marker = outside / 'original'
        marker.write_text('untouched')
        collision = self.home / '.pi-extension-link-backup-collision'
        collision.symlink_to(outside)
        with patch.object(migration.secrets, 'token_hex', return_value='collision'):
            with self.assertRaises(FileExistsError):
                migration.migrate(self.home, old_generation, paths)
        self.assertTrue(collision.is_symlink())
        self.assertEqual(marker.read_text(), 'untouched')
        self.assertEqual(list(outside.iterdir()), [marker])
        self.assertTrue(all((self.home / path).is_symlink() for path in paths))

    def test_symlink_ancestor_not_traversed(self):
        agent = self.home / root
        moved = self.home / 'outside'
        agent.rename(moved)
        agent.symlink_to(moved)
        migration.migrate(self.home, old_generation, paths)
        self.assertEqual(self.backups(), [])
        for path in paths:
            self.assertTrue((self.home / path).is_symlink())

    def test_disallowed_path_not_traversed(self):
        with patch.object(migration, 'open_parent', side_effect=AssertionError('traversed')):
            for path in ('../extensions/stamp', '/tmp/extensions/stamp', 'x/../extensions/stamp',
                         './extensions/stamp', 'x//extensions/stamp'):
                with self.assertRaises(ValueError):
                    migration.migrate(self.home, old_generation, [path])
        self.assertEqual(self.backups(), [])

    def test_generated_activation_order_and_canonical_scope(self):
        text = Path(activation).read_text()
        self.assertLess(text.index('"Activating %s" "piMigrateExtensionLinks"'), text.index('"Activating %s" "checkLinkTargets"'))
        self.assertLess(text.index('"Activating %s" "checkLinkTargets"'), text.index('"Activating %s" "writeBoundary"'))
        self.assertIn(f'{root}/extensions/openai-accounts', contract['migration'])
        self.assertNotIn(f'{root}/extensions/accounts ', contract['migration'])
        for name in ('auth.json', 'settings.json', 'skills/', 'extensions/usage'):
            self.assertNotIn(name, contract['migration'])


unittest.main()
