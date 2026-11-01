# Coordinator worktree reap validation

## Follow-up: coordinator managed-activity boundary

Follow-up base: `0d1ace7479a70ee2d56cca318c97032850b45cd2`.

The root-only refusal was caused by counting the authenticated coordinator's own cwd and `/proc/<pid>` cwd/descriptors as independent users, even when idle. `0d1ace7` corrected that self false-positive. Parent-provided live evidence also showed PID 41773 as same-UID `systemd` in `/user.slice/user-2016.slice/user@2016.service/init.scope`, with `ptrace_scope=1`; read-only `readlink` of its cwd/fd returned EACCES and `/proc` had no `hidepid` option. This is consistent with ptrace restrictions, but does **not** prove Yama caused this EACCES. The process is not assumed idle; after the user's explicit acceptance of the narrower harness-managed boundary, coordinator reap no longer inspects unrelated host processes, so this external PID is outside that policy.

Coordinator cleanup-on-reap now uses the existing reserved native/foreground worker controllers. Each launcher captures the physical activity checkout at spawn: native Tmux captures it alongside the exact canonical pane cwd; headless captures it immediately before spawn. For worktree-backed tasks, the provisioned `worktreeInfo.path` is the effective activity root and must still resolve to that exact canonical path, with the spawn cwd beneath it. The launch identity is written to the private worker manifest and persisted on its owner-private child record; reload can recover a missing group copy only from a matching authenticated manifest, and resume/replacement attempts capture a fresh identity. Legacy/unavailable launch identity fails closed for non-reaped workers. Controllers compare these immutable launch-time identities, not the current resolution of mutable lexical cwd symlinks. Fully reaped records are skipped before path resolution, so stale records for removed worktrees do not permanently block cleanup. Existing worker `prepareReap` still verifies/reaps authenticated descendants and supervised jobs before worktree cleanup. The authenticated idle owner self-observation is excluded; busy owner, active managed worker/job, unknown managed inventory, dirty/unpreserved/retained/foreign identity, and root-last/retry protections remain. Ordinary `/worktree cleanup` retains host-wide same-UID cwd/fd inspection.

Accepted boundary: coordinator reap does **not** inspect arbitrary untracked editors, terminals, shells, or other non-harness processes. A harness-managed worker known to use the same checkout remains a blocker even outside the current ancestry. No process is killed/restarted and no host/Yama permission is changed.

Regression coverage includes the original root-self case, busy-root negative control, unreadable unrelated PID bypass under managed scope, active/unavailable managed activity blockers, and an external unreaped controller-owned worker sharing the checkout. Native launcher coverage retargets a lexical symlink after cwd resolution and verifies its manifest retains the spawn-time physical path. Both native and foreground controllers test stable and retargeted aliases, missing/legacy launch identity, unresolved physical identity, unrelated activity, and fully reaped removed-worktree records. Existing dirty, foreign, attribution, root-last and interrupted-removal/retry safeguards remain covered.

Live canary retest after parent review and separately authorized activation: reload the candidate; use a bounded disposable repository and an explicitly isolated coordinator (`worktree: {}`) with one nested worker; read the completed result and normally reap the worker, then request normal coordinator reap. Confirm both exact registered paths are removed while branches/source remain. Also confirm a synthetic or known managed worker sharing a target checkout blocks reap until normally reaped. Do not use paused Goals or real user worktrees. If any managed activity/controller evidence is unavailable, verify all paths remain and stop; do not force-reap or remove paths to get a green result.

Focused commands:

```sh
node --experimental-transform-types --test shared/worktree-reap.integration.test.mjs shared/worktree-completion.test.ts shared/worktree-completion.integration.test.mjs
```

Passed **44/44** shared lifecycle tests. The Nix subagent suite includes **179/179** passing native/runtime tests (including launch-time symlink-retarget coverage for both controllers); workflows-runtime passes **114/114**. The isolated native coordinator canary passes: it removes its guarded root and preserves source/branch. Full task gate command passed:

```sh
nix build .#checks.x86_64-linux.subagent .#checks.x86_64-linux.workflows-runtime .#checks.x86_64-linux.subagent-profiles --no-link --keep-going -L
```

After parent review and separately authorized activation, use this disposable installed-runtime canary:

1. From a clean disposable Git repository, launch one native `subagent` with `agent: "coordinator"`, `worktree: {}`, and a task directing it to launch exactly one nested worker with its own `worktree: {}`, read the nested result, and normally reap that worker. Do not involve Goals.
2. Read the coordinator result, then normally `reap` the coordinator group. Verify both exact registered worktree directories are absent, their branches remain, and the source branch/tree is unchanged.
3. In a separate fixture only, have a known managed worker share the coordinator checkout; confirm coordinator reap blocks until that worker is normally reaped. If relevant worker/job inventory is unavailable, verify all paths remain and stop. Do not force-reap or clean paths manually to manufacture success.

The user-accepted policy intentionally does not check unrelated untracked editors/terminals.

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

**Passed, exit 0**, against committed implementation `5546473760e5f94432eef7f5ebea6aca20403f65`:

```text
subagent: legacy reap 27/27; config 6/6; profiles 20/20; routing 13/13
subagent native/runtime suite: 176/176
workflows-runtime: 110/110
PASS actual dedicated coordinator: launch/resume retains trusted policy
PASS actual isolated coordinator: guarded root removal before reap; source and branch preserved
PASS native Pi named-profile acceptance: offline requests, saved/resumed contract,
     single/parallel/chain dispatch, and fail-before-launch boundaries
```

The isolated raw-Pi profile fixture explicitly attests an empty local job inventory because it installs no job tool or prior job state. Production missing/unknown job-controller refusal is unchanged. The fixture now also supplies the already-required confirmed continuation limits and expects the mandatory guidance tool; no production Goal-limit behavior was changed.

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
