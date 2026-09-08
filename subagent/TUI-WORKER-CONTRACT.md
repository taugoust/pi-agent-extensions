# Native TUI subagent integration contract

## Implemented boundary

**The Linux native route is wired into the actual `subagent/index.ts` tool execution and dashboard adapters.** `TuiNativeManager` handles single/parallel/chain launches, discovery, notifications, control, waits, cancellation, promotion, retained results and explicit resume/reap. This is one real interactive Pi per child, not an RPC console or a second Pi renderer. Full AgentSH execution retains its previous backend; this work adds no Darwin route.

Runtime files:

- `subagent/tui-native.ts`: durable session-owned groups/attempts, serialized scheduler, task projections and parent lifecycle integration.
- `subagent/group-wait.ts`: one snapshot/deadline across native and legacy groups; previously finished children and newly started groups do not join a wait.
- `shared/tui-worker-protocol.ts`: bounded authenticated control and public discovery allowlist.
- `subagent/tui-worker-store.ts`: private manifests, atomic/fsynced state and retained artifacts.
- `subagent/tui-worker-server.ts`: child-hosted socket, durable dispatch receipts, live activity, current-turn outcome and idle reap seal.
- `subagent/tui-worker-extension.ts`: real TUI input/session/report hooks and mandatory local notification/outcome tools.
- `subagent/tui-worker-client.ts`: control and distinct operator-capability clients.
- `subagent/tui-worker-tmux.ts`: immutable launcher contract, owned placement, promotion and verified dead-pane reap.

## Placement, scheduling and lifetime

A background single creates a new window in the calling parent's tmux session. Parallel/chain children share their group's window. Limits remain 16 background groups (`MAX_BACKGROUND_SUBAGENTS` supplied by the existing entry point), eight parallel specifications, four simultaneously launched children per group. The explicit default model remains `openai-codex/gpt-6-astra:low`, not inherited parent medium.

Unpromoted foreground groups stage on the same server in a group-specific infrastructure session/window tagged `@pi_infrastructure=1`. They remain parent-bound: normal shutdown cancels foreground work; a child watchdog verifies the parent PID/start token and exits on parent death. Reload does not silently create a new foreground owner. Background children do not depend on a parent pipe/socket/PID lifetime.

Promotion moves the whole group window into the current caller session without restarting Pi, changing PIDs, or leaving child-local job panes behind. Child jobs use their actual local `TMUX`/`TMUX_PANE`, not an RPC parent job proxy. Promotion persists durable ownership before movement and requires the original server epoch.

Session-owned group records rehydrate after parent crash. Already launched background children continue independently. **Pending parallel/chain children are scheduled upon parent reattachment; no scheduler runs while the parent is absent.** There is no automatic reopening of dead/reaped attempts. One PID/start-token-fenced parent scheduler may write a session's groups at a time.

## Authority and input

`PI_TUI_WORKER_LAUNCHER` must resolve to an executable immutable `/nix/store/` path. `PI_TUI_WORKER_LAUNCH_MODE=guard-only|none` must match the actual parent disposition. Missing, mismatched, unavailable or full-supervisor dispositions fail closed. Pending launches re-resolve the current launcher environment rather than trusting a retained executable path.

The guarded launcher starts a fresh `agentsh permission-gate run -- rawPi` for each child. Parent relay credentials are removed. Children use their own gate/local extensions; prompts/tools remain blocked until child-local authority is active. Initial requested tools restrict extension tools too, with mandatory `notify_parent` and `task_outcome` retained.

Operator mode has a separate capability/hash and request namespace. The generic control token cannot change permission mode. Every new initial application, pending launch and resumed attempt queries the current live parent `__PAE_PERMISSION_GATE_OPERATOR_V1__.status(owner)` and validates its exact session identity. Retained `operatorEnabled` JSON is observational, never authority to restore prompts-off. Existing children may retain previously authorized mode. Explicit live operator events propagate through a separate serialized queue, not behind slow model launches.

Parent/model instructions use custom `harness-control` messages prefixed **“Supervising-agent instructions (not direct user input)”**. They do not enter slash-command dispatch. Child guidance gives direct human TUI/Paseo instructions precedence and requests parent notification on material scope changes. Human keyboard/Paseo remains actual user input. Owned session switching/forking is blocked to preserve session identity.

## Control, results and waits

The child owns the control socket and durable request receipts. Observer disconnection, bounded-wait cancellation and parent SIGKILL do not control background worker lifetime. Retry an uncertain mutation only with the same request ID; persisted intent without confirmed dispatch returns `ambiguous`, never automatic replay. Receipt capacity fails closed.

Private manifests are 0600 under validated 0700 directories. Public discovery uses an explicit allowlist and omits control/operator credentials. Launcher-set `PI_HARNESS_{PARENT_SESSION_ID,TASK_ID,GROUP_ID,CHILD_ID,ATTEMPT,RUNTIME_ID,CONTROL_SOCKET}` are identity/discovery, not authorization.

Root list/tasks merge native and retained legacy inventory. Global `wait_any`/`wait_all` use one active snapshot across both backends and one deadline; cancellation stops observation only. Group-specific controls remain backend-owned. Structured routine updates go through `quietState.enqueue`, with persisted per-child replay cursors; there are no routine parent transcript injections. Explicit guidance is separately bounded. Findings are rate-limited and remain retained alongside model-reported task outcomes.

`agent_settled` writes retained reports while leaving Pi idle/messageable. New direct turns clear the old current-turn report/outcome without deleting artifacts. An assistant `stopReason: aborted` is **cancelled**, not completed, and a chain does not advance from it. Current-turn snapshots prevent old replayed outcome events from resurrecting stale delivery claims.

Live idle resume continues in the same Pi process. Dead/reaped resume is explicit, verifies old endpoint/process death and retained reap identity, copies the retained session into a new owned attempt, and preserves task ID while incrementing attempt. Checkpoint/high-context continuations require compaction; rejecting `compact:false` is deliberate.

## Cancel versus reap

Cancel aborts work but never closes a pane. Idle-only `prepare_reap` synchronously seals input, persists the receipt and requests graceful Pi shutdown. On the sealed path only, the worker emits:

```ts
pi.events.emit('harness-runtime-reaping', { runtimeId, childId, workerEpoch });
```

Ordinary exit/failure/cancellation is not reap. Bridge/server owners handle the public tombstone and managed-agent archival. The launcher waits for real process exit; it will not kill a live Pi to satisfy reap. It verifies server epoch, pane identity/nonce, process identity and dead state at the destructive tmux boundary. Retried deletion uses a retained intent/tombstone. Parent, sibling worker/job panes and reports remain intact.

## Trusted child-local Jobs dashboard

With parent authorization, `background-job/index.ts` now publishes a distinct in-process `__paeLocalJobControllerV1` (`shared/background-job.ts`). It is bound to the actual current Pi session, checks session lifetime on every call, and invokes the ordinary local job tool with its existing `assertOwned` checks. The original delegated parent broker is unchanged. There is no foreign-session argument, delegated child override, model-supplied scope or new shell authority.

The dashboard resolves an owned task/attempt, authenticates to its child-hosted TUI endpoint with the complete parent/worker epoch identity, then requests `jobs` operations. The worker verifies that its local controller belongs to the worker's actual current Pi session. This supports list/status/output/bounded wait/cancel/reap and watches/events/ack/unwatch only. Start, adopt, signal, commands, arbitrary log paths and session/cwd overrides are rejected. Mutations retain durable request deduplication. No model turn is started or tool allowlist changed.

The human dashboard shows build output/status and offers separately confirmed cancellation (retaining pane/output) and reap (explicit cleanup). Root-local or sibling job IDs fail the existing ownership checks. An unavailable or reaped child is reported clearly; its jobs are not implicitly stopped and there is no parent-wide fallback. Re-adopting surviving job panes in a live Pi remains an explicit recovery path.

## Validation and packaging

No billed provider requests: `tui-worker-test-provider.ts` is an explicit local deterministic fixture. Tests include:

- `group-wait.test.ts`: mixed backend snapshots, legacy-first completion, stale finished siblings, deadline, empty snapshot and abort.
- `tui-native-observe.test.ts`: real control-server observation, new-turn outcome clearing, aborted settlement, skipped chain successor, cancelled aggregate and owned/foreign/reaped dashboard job routing.
- `tui-worker-jobs.test.ts`: bounded existing-job actions and rejection of shell/start/adopt/signal/foreign-scope overrides.
- `dashboard.test.ts`: output, separately confirmed cancel/reap and watch controls without model turns.
- `tui-worker-{protocol,server,extension,seal}.test.ts`: validation/auth/dedup, guard failure, source/tool restrictions, sealed-only reap event and retained resources.
- `tui-worker-tmux.test.ts`: real Pi TUI/keyboard, group placement, observer crash, PID-preserving promotion, live input/reap races, retained reports and sibling safety.
- `tui-root.test.ts` / `tui-root-test-extension.ts`: actual registered root tool in real Pi, parent SIGKILL/rehydration, same-PID live resume, explicit reaped new attempt, readonly tools, outcomes/quiet receipts, guarded bash and operator propagation, real keyboard Esc and no chain advance. Legacy-manager fixtures exercise the actual mixed root wait entry point. Real background-job fixtures exercise child-local creation through the normal guarded model tool, parent-local cross-session denial, authenticated list/output/cancel/wait/reap, and unchanged child PID/activity sequence.

Guarded root command:

```sh
PI_TUI_ROOT_LAUNCHER=/nix/store/55ar22w07dsrl0v75vgp0nf8vnsg8p0q-pi-tui-worker/bin/pi-tui-worker \
PI_TUI_ROOT_MODE=guard-only \
node --experimental-strip-types --test subagent/tui-root.test.ts
```

For native real-Pi tests set `PI_TUI_TEST_PI` and `PI_TUI_ROOT_LAUNCHER` to the immutable raw Pi. Without those binaries live tests explicitly skip; mocks alone are not durability evidence. `nix/subagent-check.nix` includes the tests and accepts optional `piPackage`/`tuiWorkerLauncher` supplied by parent composition. Parent owns overall README/declarative packaging/release; **include new `subagent/group-wait.ts` in runtime module links**. This workstream does not commit or publish.
