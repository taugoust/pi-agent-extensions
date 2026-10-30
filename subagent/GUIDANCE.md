# Coordinator-first structured guidance

Native workers use two deliberately separate interaction lanes:

- **`request_guidance({prompt, context?})`** asks the directly owning coordinator an ordinary implementation/work question. The tool remains pending until that coordinator resolves the exact waiter. A coordinator uses **`guidance`** with `list`, `reply`, or `escalate` (outside its assignment). `list` returns exact targets and bounded pagination; `reply` requires that target, an explicit `replyId`, and implementation guidance.
- **`questionnaire`** is for genuine human decisions. In newly bound native workers its existing interaction-service lookup forwards the questionnaire through owning coordinators, without asking intermediate workers' humans. Only the top-level coordinator's `guidance operation=human` invokes the existing `questionnaire` tool and returns its actual result. The model cannot submit a human answer through `guidance`.

`notify_parent` remains notification-only. `subagent operation=prompt` still only delivers instructions. Neither resolves a structured guidance waiter. Guidance and questionnaire answers **never approve permissions**: the existing authenticated permission route is unchanged, and permission payloads are rejected by this lane.

## Implementation and authority

`guidance.ts` owns the separate private Unix-socket broker and atomic/fsynced journal. Trusted native launch code allocates a per-worker capability; models cannot supply launch identity. Every request/target binds owner session, owner runtime epoch, native task, child, attempt, worker launch epoch, worker process epoch, optional delegated goal ID, request ID, and revision. Reply IDs and canonical payload fingerprints are persisted before resolving the socket-backed promise. Identical receipts are idempotent only in the same live owner epoch; conflicting payloads, stale revisions/epochs, foreign identities and duplicate waiter creation fail closed.

`guidance-worker.ts` registers the worker tool and a separately scoped human-escalation service. The service checks its exact launch binding and current session and is revoked/aborted on shutdown. `shared/foreground-tasks.ts` preferentially routes **only questionnaires in an explicitly bound worker**. Missing/stale worker guidance never falls back to a child-to-human prompt. Root questionnaires and permission interactions retain their existing services.

`guidance-extension.ts` installs the owner broker and coordinator tool through `subagent/index.ts`. Notifications use the existing quiet-state surface; there is no additional UI/inbox or human attention badge. Ordinary questions first notify only the direct parent; human-only requests forward automatically to the root. A native foreground launch returns the coordinator's turn when guidance is pending, leaving the child live. The headless chain/parallel scheduler also remains live so later children are not abandoned. Yielded foreground tasks still emit deduplicated terminal completion notifications; yielding does not implicitly promote a task or change its pane/process lifetime ownership.

### Shared applicability

- **Native TUI:** `tui-worker-tmux.ts` creates the exact binding at launch; `tui-worker-extension.ts` installs the worker tool/service and activates the coordinator tool for nested owners.
- **Headless foreground:** `headless-foreground.ts` creates the same binding; its existing `tui-worker-extension.ts` loads the same worker implementation. Foreground waiting yields when guidance is pending, not when a child is complete.
- **Dedicated goals and native RPC:** `index.ts`'s native launch seam binds the retained task/attempt plus the dedicated goal's worker epoch and entry ID, and explicitly loads `guidance-worker`. Existing questionnaire execution already uses the common interaction-service resolver. No model-facing `goals.answer` operation is added.

Legacy AgentSH supervisor workers are not silently rebound to this native lane. Existing runtimes without a guidance binding retain their existing behavior. New native launches always receive either an exact capability or an explicit unavailable marker; owner startup failure must not enable a child-to-human fallback. A bound worker whose owner is unavailable fails closed instead of borrowing an ancestor's or a human's authority.

## Failure and retention

Each owner session's journal is under `state/coordinator-guidance-v1`. A verified process-identity lock prevents concurrent writers. Active broker sockets are private, ephemeral, owner-epoch specific. Requests are durably recorded before notification. Graceful abort records cancellation; a dropped connection/owner loss records unavailable. Owner restart marks orphaned pending records unavailable and does **not** reconstruct promises, reconnect old bindings, or replay answers. Replacing an attempt revokes its capability and cancels its pending waiters. An uncertain receipt write never resolves a waiter or permits a conflicting retry.

Pending/history records remain available through `guidance list`. Retention is bounded and fails closed at capacity (1024 records/64 live waiters, plus the existing private-state byte limit), rather than silently dropping active requests. Reloaded retained workers need a new explicit launch/attempt before using this lane; automatic rebinding is intentionally excluded.

If the top-level existing questionnaire tool/service is unavailable or a nested tool call fails, the request remains truthfully pending or unavailable. No answer is synthesized. Questionnaire tool results now distinguish bounded failure metadata from explicit human cancellation provenance; ambiguous legacy cancellation results are not trusted as human cancellations. The TaskInteractionAnswer wire DTO is unchanged. Human cancellations return to the originating waiter as cancellations. This does not introduce a human questionnaire renderer for an otherwise unsupported root runtime.

## Isolated validation

```
node --experimental-transform-types --test subagent/guidance.test.ts subagent/guidance-integration.test.ts
```

Tests exercise real Unix sockets, actual registered worker/coordinator tools, actual questionnaire execution with a deterministic authenticated-human fixture, nested ordinary/human resolution, exact scope/epoch/revision rejection, idempotency/conflict, owner/worker replacement, cancellation, permission separation, single-flight human calls and receipt write failure. Foreground manager tests stub only physical launch/observation and prove that the real native/headless wait loops yield without terminating the worker or abandoning a chain. Static launch-contract assertions prove dedicated goals load the same tested worker code and bind their goal/epoch.

These are not paid-model experiments, live tmux/session mutations, live human approvals, or an end-to-end native-device/browser test. No bridge DTO or human answer endpoint is changed.
