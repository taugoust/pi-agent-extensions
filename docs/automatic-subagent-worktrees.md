# Automatic subagent worktrees

This lifecycle applies to ordinary delegation, with or without a Goal. It adds no planning, approval, merge or review requirement. Git isolation is not an OS sandbox and grants no new permissions.

## Launch policy

The trusted **spawning parent's** profile controls the default:

- `automaticWorktrees: true` on the bundled `coordinator` enables automatic isolation for the workers it launches, including ordinary workers/scouts.
- Other profiles and ordinary parents preserve opt-in isolation. Selecting a coordinator *child*, naming an agent coordinator, a prompt, an environment flag, or having a Goal does not enable the parent's policy.
- The resolved boolean is pinned in the private worker manifest and retained spec. The worker extension installs it only after verifying the actual session/manifest binding. Legacy manifests default off. Profile edits affect new launches, not retained attempts.
- Automatic isolation of the Goal/coordinator launch itself is not added here.

Each launch (or each parallel/chain item) may override `worktree`:

```json
{"task":"Implement the bounded change","acceptance":["Verify the change"],"worktree":true}
{"task":"Inspect this non-Git workspace","acceptance":["Report findings"],"worktree":false}
{"task":"Use a fresh snapshot","acceptance":["Verify isolation"],"worktree":{"changes":"exclude"}}
```

`true` reuses an exact supervisor-owned worktree when the selected cwd is inside it; otherwise it provisions a new isolated checkout. `false` disables automatic isolation. An object retains the existing **explicit new-worktree** behavior, including `base` and dirty-source `changes: "include" | "exclude"`.

Discover/select the actual repository cwd before launching an automatically isolated worker. Non-Git cwd, provisioning failures, invalid ownership and unavailable activity evidence fail clearly; there is no fallback to the primary checkout. New dirty sources still require an explicit include/exclude choice. Automatic provisioning never guesses whether to copy or discard working changes. Ignored files are not copied.

New branches are descriptive and contain no task/child/session IDs: an explicit `worktree.branch` wins; recognizable task intent (`Implement …` → `feat/…`, `Fix …` → `fix/…`, `Upgrade …` → `upgrade/…`) selects the prefix, while a meaningful `displayName` (then legacy `name`) supplies the concise subject. If neither is meaningful, the subject comes from the first seven words of the task's opening line. For example, an upgrade task can create `upgrade/paseo-0.15.0`. Set `worktree.branch` on the explicit object form to request a preferred literal branch name; Git ref validation rejects invalid names and checkout shorthand such as `@{-1}`. Generated lockfile subjects use `-lock` rather than Git's forbidden `.lock` suffix, including after truncation. If a local branch or default target path is already occupied, provisioning selects the next readable `-2`, `-3`, … suffix. It never checks out or reuses an unrelated branch. Stable task/child/session IDs remain in private ownership metadata and continue to govern resume, borrowing and cleanup.

## Reuse and partial work

A reused checkout is not copied, reset, merged or transferred to another owner. Staged, unstaged and untracked partial work stays in place. The private registry retains the original physical creator identity and records exact borrower attachments. Resume updates the exact released prior attempt; stale attempts cannot release a replacement.

Reuse requires verified checkout/admin-directory/common-repository/branch identity, ready lifecycle, no completion/removal/evidence-retention marker, authenticated supervisor ownership and fresh harness-managed activity inspection. A supervisor can lend its own launch checkout, or its authenticated borrowed checkout through the recorded supervisor chain. Foreign and sibling ownership cannot be claimed by cwd or name.

Only one leaf worker may be attached at a time; active supervising ancestors are not independent conflicting borrowers. Pending/active sibling borrowers, unreaped users of the same checkout, unknown activity, failed preparation and identity changes block reuse. Parallel/chain preparation requesting the same retained checkout for multiple workers fails rather than sharing it silently; choose separate explicit snapshots or delegate/reap sequentially. Attachment history is bounded (32 task identities per physical tree); capacity and interrupted locks require owner review, never silent history eviction or lock stealing.

Normal worker/scout reap releases its exact attachment but retains the checkout and branch. Launch failure releases any newly acquired attachments durably while preserving files and failed-creation evidence. The registry and retained manager records support reload/retry, nested supervision and dynamically selected repositories; the top-level parent need not enumerate repositories in advance.

## Parent-controlled reap and cleanup

```json
{"operation":"reap","job_id":"subagent-job-…"}
{"operation":"reap","job_id":"subagent-job-…","cleanup_worktree":true}
{"operation":"reap","job_id":"subagent-job-…","force":true,"reason":"Preserve investigation evidence for later owner review"}
```

Ordinary reap retains trees. `cleanup_worktree: true` explicitly requests guarded physical cleanup in the same operation. Once requested, cleanup intent is durable: a blocked retry cannot accidentally close the worker by omitting the flag. Dirty/ignored/untracked/empty-directory artifacts, shared attachments, active/unknown managed users, retention, ownership changes and branch/path changes block cleanup with remaining paths. Branch refs and commits are preserved; this is not branch deletion or merge automation.

The coordinator's existing `cleanupWorktreesOnReap` policy remains mandatory on normal reap, even if `cleanup_worktree` is false. It cleans genuinely owned trees across authenticated nested sessions/repositories before closing. Blocked owned trees retain the coordinator for repair/retry. A coordinator borrowing an ancestor-owned root cleans its own attributable descendants first, then releases its borrower attachment; the parent-owned root remains the original owner's responsibility. Explicit `cleanup_worktree: true` on that shared physical root still blocks while its creator/supervisor or another user remains attached—it is not silently converted to detach-only cleanup.

`force: true` remains a reap flag, requires a reason, and records verification/removal bypasses plus discoverable physical leftovers durably. It never means force-delete, fabricated acceptance, ownership transfer, permission bypass, or skipping active-worker/job/descendant/pane safety. Later normal cleanup can reconcile audited leftovers using the guarded service.

## Supported boundaries

Native Linux managed workers support provisioning, reuse and parent cleanup. Unsupported backends reject worktree requests rather than falling back; legacy record-only reap cannot satisfy explicit physical cleanup. Existing legacy forced audit limitations remain documented in [coordinator validation](coordinator-worktree-reap-validation.md).

Ownership covers registered harness trees only, not arbitrary external/unregistered checkouts. As in existing coordinator cleanup, activity checks cover authenticated harness-managed workers/jobs, not arbitrary untracked host editors or shells. Ordinary explicit worktree completion retains its existing broader host-process checks. Neither policy kills unrelated processes or changes host permissions. Durable creator/borrower identities, original branches, user retention and investigation artifacts remain authoritative.
