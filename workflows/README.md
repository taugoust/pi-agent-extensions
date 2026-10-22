# Worktree and Goal

Copied from the MIT-licensed `pi-worktree` and `pi-goal` packages in `narumiruna/pi-extensions` at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c`. Original notices are retained in `worktree/LICENSE` and `goal/LICENSE`. The Git safety flows and Goal state machine are reused, with public Pi dialogs replacing the terminal toolkit and a private session-scoped service for Paseo.

## Paseo

Open **Work** beside the composer. Goals and worktrees have their own tabs alongside Jobs and Agents:

- **Work → Worktrees:** repository-grouped inventory of isolated branches, associated workers and changed-file counts. A workspace outside Git is treated as a container: discover child repositories up to two directory levels down, skipping hidden/dependency/build directories and directory symlinks. `.git` files and directories are recognized. Container views include clearly labeled, non-removable main checkouts; a single-repository view keeps the existing additional-worktree list. Session-owned repositories outside the workspace remain included. Discovery is cached for 30 seconds and bounded to 64 roots, 256 scanned directories and 4096 entries; inventory is capped at 100 rows with bounded Git work. Partial failures/limits produce warnings without discarding readable repositories. No repository is initialized and no first-repository mutation target is silently chosen. Open uses an existing native workspace ID when available, otherwise explicitly creates a workspace in the parent project. Per-tree removal retains the candidate's exact confirmation and safeguards; it requires a reaped worker and a clean tree. The current Pi conversation stays in its original cwd. Manual create/prune flows remain available through `/worktree`.
- **Work → Goals:** see the current objective, required checklist and blocker/waiting reason. Describe the goal in chat and ask the model to keep working; no mandatory goal-entry form or separate Goal pill remains. Pause/resume and secondary Edit, Clear and Limits controls remain available. Add a task explicitly while paused and idle. Completion evidence remains visible after the active goal clears.

Existing sessions need `/reload` after installation. No Goal is created merely by loading the extension or opening the panel. `/worktree` and the candidate's direct `/goal` commands remain available; terminal menus use public Pi dialogs instead of pi-tui-kit.

## Model-managed goals and tasks

`goal_manage` provides status, create, update, pause, resume and clear. Its objective is a concise, outcome-only statement (what, not how), capped at 320 characters. Model guidance moves implementation, sequencing and verification steps into the goal-linked `update_progress` checklist while preserving user constraints. Model guidelines require an actual relevant user instruction; `user_authorized:true` on create/resume enables the existing autonomous engine. Without authorization, creation stays paused. Token budgets are opt-in: omitted means unlimited. Automatic Goal turns cannot use management mutations to reset themselves or change scope. Existing goals require their exact current ID and are never silently replaced. Tool-driven activation binds the current run rather than recursively dispatching another user prompt.

The existing `update_progress` checklist is the task source. It defaults to the current goal, accepts its exact `goal_id`, and supports `goal_id:null` for standalone work. Goal tasks receive stable IDs: keep an ID when refining wording or adding blocker details, omit it for a new task. Unfinished tasks cannot silently disappear from full-snapshot updates. An explicitly user-authorized scope update may remove exact task descriptions through `goal_manage.remove_tasks`.

Scoped progress is persisted in the same session history, restored on branch/reload/compaction, and retains a stable scope key when Goal rotates its stale-call ID on edit or resume. The current goal and checklist are supplied to model requests, and `goal_complete` rejects pending, in-progress or blocked tasks. Completion still requires evidence for the actual outcome; changing a checkbox alone is not proof. UI task additions are paused/idle-only to avoid racing model checklist replacements.

## Goal boundaries

Default settings are **3 automatic responses** and **2 repeated no-progress runs**. No token budget is applied unless the user explicitly supplies one with `/goal --tokens` or `goal_manage.token_budget`; explicit budgets are positive integers capped at one million. Manual settings in `<getAgentDir()>/pi-goal.json` can change the response/no-progress limits, and the confirmation shows the effective values. Trusted-extension managed-run RPC remains disabled by default.

Goal uses the session's selected model, thinking, active tools and existing permission policy. It does not switch models or bypass the idle guard. Starting/updating/resuming requires Pi to be idle in the native controls; Pause can stop an active Goal turn. Continuation uses the copied settled-boundary dispatcher, stale-goal IDs, usage accounting, waits and circuit breakers. Finishing requires the copied `goal_complete` evidence contract; ordinary text does not count as completion.

These are not dollar caps. The final request can exceed a token budget and may complete the goal in that same response; otherwise exhaustion stops continuation. Initial/manual tool loops, compaction and independent delegated work are not bounded by the automatic-response count. Parent-session token accounting does not impose a budget on independent child agents. Review the model and active tools before enabling autonomy.

Canonical Goal state is persisted in the session. Reload restores paused/limited state without silently resetting counters. Legacy goals carrying the old implicit 250,000-token default migrate to unlimited; if they were stopped by that cap, they restore paused and require an explicit resume. New explicit budgets are marked and preserved across reloads. A legacy 250,000 cap is treated as the old implicit default because older state did not record whether it was explicitly requested. Legacy global state files are left untouched rather than rewritten. Accepted completion state and its matching tool-result evidence are projected separately for the panel.

## Isolated subagent launches

Native Linux subagents accept `worktree: { changes?: "include" | "exclude", base?: string }` on a single launch or each parallel/chain item. Set `cwd` to the source repository (or a directory inside it). Clean checkouts may use `worktree: {}`; the base defaults to the resolved HEAD commit. Any staged, unstaged or untracked changes require an explicit include/exclude choice. Ignored files neither trigger the choice nor get copied.

Include copies staged/unstaged binary patches and untracked files without stashing, committing or modifying the source index/checkout. A dirty include requires HEAD as its base; unresolved merges, unsafe index flags, dirty submodules and oversized snapshots are refused. Exclude uses only the selected commit. Source changes during preparation fail closed. Each requested child gets its own branch and working copy; chain steps do not inherit the previous step's files.

The worker starts in the new working copy, with an explicit instruction to keep edits there. This is Git checkout isolation, not a broader filesystem sandbox; normal permission policy still applies. Resume retains the same working copy. Completion and reap do not merge, remove the worktree or delete its branch. Partial creation failures retain artifacts for inspection. Ownership is persisted and removal refuses attached workers, including idle completed workers until they are reaped. AgentSH-supervised and non-Linux worktree launches are rejected rather than silently using a shared checkout.

## Worktree boundaries

The copied checks protect main/current, dirty/untracked, locked, index-flagged, submodule and unsafe detached worktrees. Ignored files and administrative recovery pointers require their exact preview; inventory and identity are rechecked before Git mutates anything. Branches are never deleted and removal never uses force. Cancel does not roll back an already-applied Git change.

The native backend also checks for open Paseo agents using the selected worktree, including subdirectories and symlink aliases, immediately before forwarding a removal confirmation. It fails closed if the agent inventory is incomplete. This is not an atomic lock against unrelated Git/process activity; keep other processes from modifying a worktree while removing it. Manual workflow Git hooks still run with the host's normal permissions; automated subagent worktree creation disables Git hooks.

Native Git mutation is refused if Pi or Goal becomes active while a preview is open. Native open uses Paseo's workspace API, not session switching or a model prompt. The copied terminal Switch action still uses Pi's public session replacement APIs and its context-preserving flow.

## Transport and tests

Controls bind agent/workspace, Pi session, bridge epoch, service epoch, operation ID, dialog ID and unique request ID. Every confirmation is explicit; no dialog response or mutation is sent automatically on render. Duplicate intent is idempotent; uncertain outcomes require fresh status review and are never automatically retried. Session shutdown invalidates dialogs and cancels owned Git work. Goal status remains readable while Git inventory refreshes independently.

Deterministic SDK tests: `node --test tests/workflows-sdk.mjs`. They exercise real Git and Pi's actual tool/settlement pipeline with fake providers, including destructive-preview races, completion, hard limits, cancellation and reopen. The bridge has compiled client/server/socket tests and an open-agent removal guard test.

The opt-in `PI_WORKFLOWS_LIVE=1 node tests/workflows-live.mjs` creates a disposable local Paseo workspace/Pi session and makes live Luna calls. It verifies native workspace opening, Git guards and branch preservation, then a real Goal-generated/read-back artifact. It cleans up only its owned resources and records evidence under ignored `plans/`. Native device visual/gesture review remains separate.
