# Explicit owner-coordinator worktree completion

Completion is an explicit owner/coordinator judgment, not PR/CI detection. Neither worker exit, reaping, release nor a clean checkout marks work complete. A coordinator is a role using the existing parent/child relationship, not an additional security hierarchy.

## Existing command and service surfaces

- `/worktree complete <subagent-task-id> <rationale>` confirms and records completion only.
- `/worktree cleanup <subagent-task-id>` separately confirms cleanup of an already completed harness-owned checkout and branch.
- The owner-session workflow service accepts `operation: "start", action: "worktree.complete", taskId, reason` or `action: "worktree.cleanup", taskId`, with its existing `sessionId`, `serviceEpoch` and `requestId` envelope and confirmation-dialog protocol. A cleanup request cannot replace the rationale. Caller-supplied owner/profile fields and path-based completion are rejected.

The snapshot advertises `capabilities.ownedWorktreeCompletion: true` and returns owner-only `worktreeCompletions` audit entries, including cleaned resources after they leave the worktree inventory. Entries contain the completion marker plus `path`, `branch` and recorded `retained` state; `worktreeCompletionError` separately reports unreadable audit inventory without disabling unrelated workflows. These are audit data, not deletion capabilities.

Owner identity comes from the current Pi context's session manager, checked against the existing private ownership registry. Worker identity comes from the existing owner-bound subagent `sessionSource` method (manifest, attempt, runtime and worker-state validation). Its inventory is used only to locate that identity; retained list snapshots are not cleanup authority. An unrelated session or a child posing as a coordinator cannot clean the parent's resources. No coordinator profile string grants additional permission. These additions require neither goals nor Git for unrelated workflow operations, and add no worker hierarchy, watchers or native UI changes.

## Audit and ordering

The ownership record's additive `completion` field stores version, task/owner/deciding session, rationale, timestamp, immutable branch OID and reference-history fingerprint. Optional `retain: true` explicitly prevents cleanup. This backend metadata safeguard has no automatic unretain operation; releasing retention requires explicit operator review of the private ownership record. Existing failed/preparing/error records and non-successful worker evidence remain retained. Repeated completion returns the original decision and cannot move its snapshot to a newer branch.

The durable phases are `marked` → `removal-pending` → `worktree-removed` → `cleaned`. Registry writes fsync the temporary record, atomically rename it, then fsync the directory. Cleanup keeps registry metadata after both resources are removed. A blocked attempt preserves its phase and a truthful `blockedReason`; retrying is idempotent. Worktree removal is non-force; branch deletion compares the exact expected OID, even when that commit has not been merged. No merge inference or automatic merge is performed.

Provisioning, resume, release and completion share task serialization and an exclusive filesystem lock. Interrupted locks are **not** stolen automatically; an operator must inspect the interrupted operation before clearing a lock. Completed checkouts cannot be resumed through the worker launcher.

## Cleanup safeguards

Every destructive operation rechecks ownership, source/common-directory and administrative inode identity, branch association/history, release status, current session/idle state, agent evidence and filesystem inventory. Cleanup refuses main/user worktrees, reused/replaced paths, moved/linked checkouts, branches checked out elsewhere, locked/stale registrations, dirty tracked files, untracked/ignored files, untracked empty directories, protected index flags and initialized submodules. It never uses force removal or accepts an arbitrary caller path.

The active-user check synchronously inspects same-UID Linux processes' current directories and open descriptors. Unsupported platforms or inaccessible evidence fail closed, preserving an explicit reason. On hosts restricting `/proc`, completion can still be recorded, but cleanup may remain blocked until safe process inspection is available. No inaccessible process is silently assumed idle. Registry release alone is not proof that a user has stopped using the checkout.

A missing path is accepted only after durable removal intent and only when Git registration/branch evidence excludes a moved checkout. Reuse after removal blocks branch deletion. Ref history/stat fingerprints detect advance-and-reset/replacement, in addition to OID changes. Missing reflog evidence blocks cleanup. Checks are repeated immediately before destructive Git calls; ordinary Git/filesystem operations do not provide an atomic lock against arbitrary non-cooperating external processes, so this does not claim an OS-wide transaction.

Confirmation remains mandatory on both command and service paths. Cancellation/context replacement invalidates the operation. There is no automatic cleanup scanner.

## Offline verification

```sh
node --experimental-transform-types --test \
  shared/worktree-completion.test.ts \
  shared/worktree-completion.integration.test.mjs \
  workflows/worktree-completion-service.test.mjs \
  workflows/delegated-service.test.mjs
```

The tests cover lifecycle ordering/idempotence, explicit completion, fixed snapshots, actual disposable Git checkout/branch deletion, command confirmations, service identity/schema, retained evidence, ignored/untracked/empty-directory artifacts, active fixture processes, inaccessible process evidence, changed/replaced branches/checkouts, linked paths, late artifacts and post-removal persistence failure recovery. Actual-Git tests create all repositories/worktrees under disposable temporary directories and restrict the test process inventory to fixture processes via a test-only filesystem seam. No production worktree, preserved evidence, live goal, provider or native application is modified.
