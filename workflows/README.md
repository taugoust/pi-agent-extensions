# Worktree and Goal

Copied from the MIT-licensed `pi-worktree` and `pi-goal` packages in `narumiruna/pi-extensions` at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c`. Original notices are retained in `worktree/LICENSE` and `goal/LICENSE`. The Git safety flows and Goal state machine are reused, with public Pi dialogs replacing the terminal toolkit and a private session-scoped service for Paseo.

## Paseo

Open **Workflows** beside the composer. The agent-bound panel has two sections:

- **Git worktrees:** inspect branches/paths/HEADs, create, remove and prune through the candidate's exact previews and confirmations. **Open new workspace** explicitly allocates a native workspace in the existing project; it never infers workspace identity from a directory. The current Pi conversation stays in its original cwd. Starting another Pi session there is an explicit native app action.
- **Goal:** enter an objective and total token budget, review the model/workspace/limits, then confirm. Pause, resume/wake, edit and clear are explicit controls. Completion evidence remains visible after the candidate automatically clears its completed active goal.

Existing sessions need `/reload` after installation. No Goal is created merely by loading the extension or opening the panel. `/worktree` and the candidate's direct `/goal` commands remain available; terminal menus use public Pi dialogs instead of pi-tui-kit.

## Goal boundaries

Default settings are **3 automatic responses**, **2 repeated no-progress runs**, and **250,000 cumulative main-session tokens** for a new goal. The native UI requires a positive budget, capped at one million; it never offers unlimited operation. Manual settings in `<getAgentDir()>/pi-goal.json` can change the response/no-progress limits, and the confirmation shows the effective values. Trusted-extension managed-run RPC remains disabled by default.

Goal uses the session's selected model, thinking, active tools and existing permission policy. It does not switch models or bypass the idle guard. Starting/updating/resuming requires Pi to be idle in the native controls; Pause can stop an active Goal turn. Continuation uses the copied settled-boundary dispatcher, stale-goal IDs, usage accounting, waits and circuit breakers. Finishing requires the copied `goal_complete` evidence contract; ordinary text does not count as completion.

These are not dollar caps. The final request can exceed a token budget and may complete the goal in that same response; otherwise exhaustion stops continuation. Initial/manual tool loops, compaction and independent delegated work are not bounded by the automatic-response count. Parent-session token accounting does not impose a budget on independent child agents. Review the model and active tools before enabling autonomy.

Canonical Goal state is persisted in the session. Reload restores paused/limited state without silently resetting counters. A legacy unbudgeted canonical goal gains the conservative default budget. Legacy global state files are left untouched rather than rewritten. Accepted completion state and its matching tool-result evidence are projected separately for the panel.

## Worktree boundaries

The copied checks protect main/current, dirty/untracked, locked, index-flagged, submodule and unsafe detached worktrees. Ignored files and administrative recovery pointers require their exact preview; inventory and identity are rechecked before Git mutates anything. Branches are never deleted and removal never uses force. Cancel does not roll back an already-applied Git change.

The native backend also checks for open Paseo agents using the selected worktree, including subdirectories and symlink aliases, immediately before forwarding a removal confirmation. It fails closed if the agent inventory is incomplete. This is not an atomic lock against unrelated Git/process activity; keep other processes from modifying a worktree while removing it. Repository Git hooks still run with the host's normal permissions.

Native Git mutation is refused if Pi or Goal becomes active while a preview is open. Native open uses Paseo's workspace API, not session switching or a model prompt. The copied terminal Switch action still uses Pi's public session replacement APIs and its context-preserving flow.

## Transport and tests

Controls bind agent/workspace, Pi session, bridge epoch, service epoch, operation ID, dialog ID and unique request ID. Every confirmation is explicit; no dialog response or mutation is sent automatically on render. Duplicate intent is idempotent; uncertain outcomes require fresh status review and are never automatically retried. Session shutdown invalidates dialogs and cancels owned Git work. Goal status remains readable while Git inventory refreshes independently.

Deterministic SDK tests: `node --test tests/workflows-sdk.mjs`. They exercise real Git and Pi's actual tool/settlement pipeline with fake providers, including destructive-preview races, completion, hard limits, cancellation and reopen. The bridge has compiled client/server/socket tests and an open-agent removal guard test.

The opt-in `PI_WORKFLOWS_LIVE=1 node tests/workflows-live.mjs` creates a disposable local Paseo workspace/Pi session and makes live Luna calls. It verifies native workspace opening, Git guards and branch preservation, then a real Goal-generated/read-back artifact. It cleans up only its owned resources and records evidence under ignored `plans/`. Native device visual/gesture review remains separate.
