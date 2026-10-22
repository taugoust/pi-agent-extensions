"""Activation-only native Pi seeding; never reconciles existing files or state.

Publish complete files with an atomic, non-replacing hard link. An existing
native file (including one concurrently created by Pi) always wins. We do not
read/merge/replace preferences, so no native writer lock protocol is needed.
"""

import json
import os
import pathlib
import sys
import tempfile

agent_dir = pathlib.Path(sys.argv[1])
with open(sys.argv[2], encoding="utf-8") as source:
    defaults = json.load(source)
agent_dir.mkdir(parents=True, exist_ok=True)
for name, default in defaults.items():
    path = agent_dir / f"{name}.json"
    if path.is_symlink():
        print(f"pi: leaving symlinked {path} unchanged; mutable mode never migrates previous declarative owners", file=sys.stderr)
        continue
    if path.exists():
        continue
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=agent_dir, delete=False) as target:
            temporary = target.name
            json.dump(default, target, indent=2, sort_keys=True)
            target.write("\n")
        try:
            # Unlike replace/rename, link never overwrites an existing file,
            # symlink, or concurrently created native settings destination.
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
