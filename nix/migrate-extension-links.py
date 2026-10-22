"""Archive legacy directory links proven by active or retained HM generations.

Invoked before checkLinkTargets (intentionally before writeBoundary). Never follows
home-relative ancestor links or extension links. Unknown paths remain for HM to
reject. Backups contain the link itself, not its source, and are reversible.
"""

import argparse
import os
from pathlib import Path
import re
import stat
import secrets


DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_parent(home_fd, parts):
    """Return a no-follow parent FD; a symlink ancestor is not ours to traverse."""
    fd = os.dup(home_fd)
    try:
        for part in parts:
            next_fd = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except OSError:
        os.close(fd)
        raise


def generation_files(old_gen, profile):
    """Only active/prior HM generations, never arbitrary Nix store directories.

    A shared home can have a different host's active generation. The retained
    profile history is also authoritative; do not assume oldGenPath owns every
    currently installed home link (failed activations can leave the same state).
    """
    generations = [Path(old_gen)] if old_gen else []
    if profile:
        profile = Path(profile)
        try:
            generations.extend(p for p in profile.parent.iterdir()
                               if re.fullmatch(re.escape(profile.name) + r"-[0-9]+-link", p.name)
                               and p.is_symlink())
        except OSError:
            pass
    files = set()
    for generation in generations:
        try:
            generation = generation.resolve(strict=True)
            if not re.fullmatch(r"/nix/store/[0-9a-z]{32}-home-manager-generation", str(generation)):
                continue
            link = generation / "home-files"
            if not link.is_symlink():
                continue
            tree = link.resolve(strict=True)
            if re.fullmatch(r"/nix/store/[0-9a-z]{32}-home-manager-files", str(tree)):
                files.add(tree)
        except (OSError, RuntimeError):
            continue
    return files


def migrate(home, old_gen, paths, dry_run=False, profile=""):
    proven_files = generation_files(old_gen, profile)
    if not proven_files:
        return

    with_fd = os.open(home, DIRECTORY)
    backup = None
    backup_fd = None
    try:
        for relative in paths:
            parts = relative.split("/")
            # Reject before inspecting ANY home-relative path.
            if len(parts) < 3 or any(p in ("", ".", "..") for p in parts):
                raise ValueError(f"Unsafe extension migration path: {relative!r}")
            if parts[-2] != "extensions" or parts[0].startswith(".pi-extension-link-backup-"):
                raise ValueError(f"Unsafe extension migration path: {relative!r}")
            try:
                parent_fd = open_parent(with_fd, parts[:-1])
            except OSError:
                continue
            try:
                try:
                    link = os.readlink(parts[-1], dir_fd=parent_fd)
                except OSError:
                    continue
                # In a legacy generation the directory itself was a home.file
                # link. A recursive tree, absent declaration, custom source, or
                # merely store-looking target is not ownership proof.
                if not any(link == str(tree / relative) and (tree / relative).is_symlink()
                           for tree in proven_files):
                    continue
                print(f"Archive legacy Home Manager extension link: {relative}", flush=True)
                if dry_run:
                    continue
                if backup is None:
                    # Exclusive private directory directly under the open home
                    # FD, outside Pi autoload paths. Never traverse a backup link.
                    backup = ".pi-extension-link-backup-" + secrets.token_hex(12)
                    os.mkdir(backup, 0o700, dir_fd=with_fd)
                    backup_fd = os.open(backup, DIRECTORY, dir_fd=with_fd)
                    mode = os.fstat(backup_fd)
                    if mode.st_uid != os.getuid() or stat.S_IMODE(mode.st_mode) != 0o700:
                        raise RuntimeError("Extension migration backup is not private")
                    print(f"Legacy extension link backup: {Path(home) / backup}", flush=True)
                # Exclusive slot; rename moves the LINK, never its contents. If
                # creating a slot or rename fails the original remains in place.
                slot = "link-" + secrets.token_hex(12)
                os.mkdir(slot, 0o700, dir_fd=backup_fd)
                slot_fd = os.open(slot, DIRECTORY, dir_fd=backup_fd)
                try:
                    # Retest after backup creation; never move a changed path.
                    if os.readlink(parts[-1], dir_fd=parent_fd) != link:
                        raise RuntimeError("Extension link changed during migration")
                    os.rename(parts[-1], "original", src_dir_fd=parent_fd, dst_dir_fd=slot_fd)
                finally:
                    os.close(slot_fd)
            finally:
                os.close(parent_fd)
    finally:
        if backup_fd is not None:
            os.close(backup_fd)
        os.close(with_fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True)
    parser.add_argument("--old-generation", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--profile", default="")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    migrate(args.home, args.old_generation, args.paths, args.dry_run, args.profile)
