"""Activation-only native Pi defaults merge; never migrates symlinks or state."""

import json
import os
import pathlib
import sys
import tempfile


def merge(default, user):
    if isinstance(default, dict) and isinstance(user, dict):
        return {key: merge(default[key], user[key]) if key in default and key in user
                else user[key] if key in user else default[key]
                for key in default.keys() | user.keys()}
    return user


agent_dir = pathlib.Path(sys.argv[1])
with open(sys.argv[2], encoding="utf-8") as source:
    defaults = json.load(source)
agent_dir.mkdir(parents=True, exist_ok=True)
for name, default in defaults.items():
    if not default:
        continue
    path = agent_dir / f"{name}.json"
    if path.is_symlink():
        print(f"pi: leaving immutable/symlinked {path} unchanged; remove its previous declarative owner before opting into nativeConfigMode=mutable", file=sys.stderr)
        continue
    try:
        with path.open(encoding="utf-8") as source:
            user = json.load(source)
        if not isinstance(user, dict):
            raise ValueError("expected a JSON object")
    except FileNotFoundError:
        user = {}
    except (ValueError, OSError) as error:
        print(f"pi: leaving {path} unchanged: {error}", file=sys.stderr)
        continue
    result = merge(default, user)
    # Native packages are additive; user-installed packages remain present and
    # declaratively requested packages are not lost behind an existing array.
    if name == "settings" and "packages" in default:
        if not isinstance(user.get("packages", []), list):
            print(f"pi: leaving {path} unchanged: packages must be an array", file=sys.stderr)
            continue
        packages = list(user.get("packages", []))
        for package in default["packages"]:
            if package not in packages:
                packages.append(package)
        result["packages"] = packages
    if path.exists() and result == user:
        continue
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=agent_dir, delete=False) as target:
            temporary = target.name
            json.dump(result, target, indent=2, sort_keys=True)
            target.write("\n")
        # Recheck before replacement: don't replace a link created mid-activation.
        if path.is_symlink():
            raise ValueError("destination became a symlink")
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
