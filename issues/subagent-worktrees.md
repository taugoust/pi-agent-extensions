# Isolated subagent worktrees

## Implemented for review

- Native Linux single, parallel and chain launches accept a per-worker `worktree` object. Unsupported backends reject it rather than falling back to shared cwd.
- Clean sources allow omitted changes policy and default to HEAD. Any staged, unstaged or untracked changes require explicit `include` or `exclude`. Ignored files are excluded.
- Include transfers binary staged/unstaged patches and bounded untracked contents without stashing or changing the parent checkout/index. Unsafe states and changing snapshots fail closed.
- Ownership binds session/task/attempt child identity. Resume retains the tree; reap releases attachment but never deletes the tree or branch. Creation failures retain artifacts.
- Workflows inventory includes the session's source repositories even when its cwd is not a Git checkout. It exposes ownership and change counts and blocks attached-worker removal.
- Paseo Worktrees is a compact inventory with selected Open/Remove actions. Open reuses an existing workspace ID when possible; candidate destructive confirmations remain intact.

## Review status

No tests, smoke scripts or check suites were run, per user instruction. Production build and switch succeeded: `/nix/store/4rf09yn5mzda5dhhy9br65crxzd2r7hv-nixos-system-matebook-26.05.20260916.4c78701`. Normal Nix check/smoke settings were restored in source after deployment. Live launch, include/exclude, resume and cleanup behavior remains unexercised until actual use. Changes remain unpublished pending explicit approval.

## Boundaries

Git working-copy isolation is not an OS sandbox. Each child isolates only its cwd repository; each chain item has its own snapshot. Normal permissions remain unchanged. Worktrees and branches require explicit review and cleanup. Dirty submodules and unsafe index flags are not silently flattened or copied.
