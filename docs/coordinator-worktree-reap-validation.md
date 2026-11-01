# Coordinator worktree reap validation

Base: `02ab4282c1419c160576be345fc75cfb96e7f075`.
All model/runtime fixtures use disposable local state and synthetic providers; no user workers, accounts or paid inference are used by these tests.

## Local guarded-service regression

```sh
node --experimental-transform-types --test shared/worktree-reap.integration.test.mjs shared/worktree-completion.test.ts shared/worktree-completion.integration.test.mjs
```

Passed **40/40** (15 reap integration tests and 25 existing completion tests). Evidence includes parent-provisioned unreleased roots; nested, multi-repository ownership; preserved unmerged commits; foreign/active/dirty/retained protection; root-last partial cleanup; interrupted-removal recovery; force audit history/idempotency/capacity; and late inventory reconciliation.

## Nix checks

Task gate command:

```sh
nix build .#checks.x86_64-linux.subagent .#checks.x86_64-linux.workflows-runtime .#checks.x86_64-linux.subagent-profiles --no-link --keep-going -L
```

Final task-gate result is recorded below after the retained-source checks finish.

The broader command was also run:

```sh
nix flake check --keep-going -L
```

It **does not fully pass**. The following sanitized baseline comparison is retained so these failures cannot be mistaken for green regression evidence.

```sh
base=02ab4282c1419c160576be345fc75cfb96e7f075
for check in openai-fast-mode agentsh-mode; do
  nix eval --raw "git+file://$PWD?rev=$base#checks.x86_64-linux.$check.drvPath"
done
```

Both untouched-base and task-tree evaluations fail identically:

```text
error: The option `assertions' does not exist.
The option definition `programs.pi.extensions.pager' ... no longer has any effect
```

The full run additionally failed `sandbox`, `goal-fresh-prompt`, `fetch` and `slow-mode`. The same four builds fail at the untouched base:

```sh
base=02ab4282c1419c160576be345fc75cfb96e7f075
nix build "git+file://$PWD?rev=$base#checks.x86_64-linux.sandbox" \
  "git+file://$PWD?rev=$base#checks.x86_64-linux.goal-fresh-prompt" \
  "git+file://$PWD?rev=$base#checks.x86_64-linux.fetch" \
  "git+file://$PWD?rev=$base#checks.x86_64-linux.slow-mode" \
  --no-link --keep-going -L
```

Sanitized matching base/current failure evidence:

| Check | Both base and task tree |
| --- | --- |
| `sandbox` | `ERR_MODULE_NOT_FOUND`: `@earendil-works/pi-ai` from compiled `subagent/guidance-extension.js` |
| `goal-fresh-prompt` | `MODULE_NOT_FOUND`: `../workflows/goal/runtime.ts` from the standalone `goal-progress-unification.mjs` fixture |
| `slow-mode` | `MODULE_NOT_FOUND`: `../shared/extension-defaults.js` from compiled `slow-mode/index.js` |
| `fetch` | Builder exits 1; retained `nix log` is empty for both base and task derivations |

No unrelated fixture repairs are included. This comparison is not a green full-flake result or waived acceptance.

## Backend and retention limits

Normal opted-in legacy subprocess/RPC reap fails closed because complete recursive worktree ancestry cannot be proven by that backend. Forced legacy reap records known direct/task-store-attributed registry leftovers plus explicit inventory uncertainty, without removing worktrees. Native cleanup covers registered harness-owned worktrees only, not arbitrary external/unregistered filesystem trees. Force never means force-delete.

The implementation branch/worktree is retained for parent review; no merge, publication, pin update or deployment is performed.
