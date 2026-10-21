# Worktrees in multi-repository workspace folders

## Request

Work → Worktrees showed `git rev-parse --show-toplevel failed: The current Pi workspace is not inside a Git repository.` for shared directories such as `/home/taugoust/Workspace` containing multiple repositories. Do not initialize a dummy parent repository or change repository structure.

## Implementation

- `workflows/worktree/repositories.ts` treats both Git's raw non-repository error and the existing helper's sanitized `not inside a Git repository` message as a normal container case. The old service catch only matched `not a git repository`, so its own sanitized error escaped the fallback.
- Inside a repository, preserve single-repository discovery. Otherwise search two directory levels, recognize `.git` files/directories, skip hidden/dependency/build directories and directory symlinks, and stop descending when a repository is found.
- Bound discovery to 64 roots, 256 scanned directories, 4096 entries and a ten-second child scan; cache it for 30 seconds. Keep session-owned repositories even outside the container.
- Inventory has a separate time budget and a 100-row cap. Per-repository failures retain other readable rows and surface warnings. A truly empty container has neutral UI copy.
- Container views include main checkouts, labeled and protected from removal. Rows carry repository path/label and sort into stable groups. Inside a single repository, unowned main checkouts remain omitted as before.
- Open/Remove resolve against freshly discovered repositories and current Git registration. Existing dirty/main/current/attached-worker/open-agent protections stay in place. Mutations without a repository target in a container fail with an explicit selection message, not a raw Git error; no first repository is silently selected.
- Bridge schema and Worktrees UI accept the additive metadata and render group headers. No Git init, fetch, branch creation or removal is performed by discovery.

## Review/deployment

No tests or additional validation scripts under the user's review constraint. Source inspected and formatted. Production build/switch succeeded as `job-284eb913a7248ef0e420c4cf`; output read and job reaped. Deployed system: `/nix/store/gm79v1i3p57407xj10xarqznj3glcn39-nixos-system-matebook-26.05.20260916.4c78701`.

Normal `doCheck` and installed smoke settings are restored. Changes remain unpublished. Actual post-restart repository discovery/UI behavior remains for user confirmation.

This changes the Pi workflow service, not just the client. The user previously confirmed `/remote-reload` retained old Nix-backed extension code; a full process restart/resume loaded it successfully. Do not automatically restart the active turn. Tell the user this update needs the same full restart, and keep actual post-restart UI behavior unverified until confirmed.
