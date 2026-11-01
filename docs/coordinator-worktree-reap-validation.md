# Coordinator worktree reap validation

## Follow-up: coordinator self-activity and inaccessible external processes

Follow-up base: `77afe3e10e07c7da217a1b7abe94d06c32ac8602`.

The deployed root-only refusal had a concrete self-activity false positive: root inspection unconditionally counted the current authenticated coordinator's cwd (`ctx.cwd`) and its own `/proc/<pid>` cwd/descriptors as independent users, even when the coordinator was idle with no pending messages. For a reserved root only, inspection now excludes those self observations when the existing owner context reports idle and no pending messages. A busy coordinator remains a blocker. Descendants and all other processes retain the existing checks.

For PID 41773, read-only host metadata showed `Name=systemd`, UID 2016, cgroup `/user.slice/user-2016.slice/user@2016.service/init.scope`, `loginuid=2016`, `/proc` directory owner UID 2016, and `ptrace_scope=1`. `readlink /proc/41773/cwd` and `/proc/41773/fd/0` returned EACCES; the proc mount had no `hidepid` option. These observations are consistent with ptrace access restrictions but do **not** prove Yama caused this specific EACCES, nor prove this same-UID process has no worktree cwd/open descriptor. The scanner therefore still fails closed on this external unreadable process. No exception was added for UID, process name, cgroup, age, or EACCES/EPERM. On this host, normal cleanup may remain blocked until activity is inspectable or an independently sound ownership/activity boundary is established.

Regression coverage includes the original root-self scenario, a busy-root negative control, and an unreadable same-UID external PID that must still block without deleting any path. Existing dirty, live-process, foreign-owner, unknown attribution, root-last, and interrupted-removal/retry safeguards remain covered.

Live canary retest after parent review and separately authorized activation: reload the candidate; use a bounded disposable repository and an explicitly isolated coordinator (`worktree: {}`) with one nested worker; read the completed result and normally reap the worker, then request normal coordinator reap. Confirm both exact registered paths are removed while branches/source remain. Do not use paused Goals or real user worktrees. If EACCES recurs, verify all paths remain, record only safe `/proc/<pid>/status` identity/cgroup and error metadata, and stop; do not force-reap or remove paths to get a green result. This test may remain blocked on unreadable external processes and cannot be reported as successful until the live result establishes otherwise.

Focused command:

```sh
node --experimental-transform-types --test shared/worktree-reap.integration.test.mjs shared/worktree-completion.test.ts shared/worktree-completion.integration.test.mjs
```

Passed **43/43** after this follow-up.

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
