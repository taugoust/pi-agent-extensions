# Pi cancelled runs and stale Goal tool ownership

Status: source fixes implemented; no activation or existing-session reload.

## Two separate reproduced defects

1. Pi's agent loop could admit another model request or consume steering/follow-up
   input after cancellation. Queued input could disappear without being executed.
   A new settled run had a fresh controller: this was not evidence of a globally
   poisoned signal or a Codex CLI defect.
2. After a Goal interruption, its stale-tool guard survived ordinary idle Paseo
   input. Paseo uses `ExtensionAPI.sendUserMessage`, so Pi reports that input as
   `source: extension`, with no streaming behavior. The extension-input branch
   did not release stale ownership. The next tool hook aborted the new run,
   producing `Operation aborted` despite an initially clean signal. A custom
   `harness-state` notification already released the guard.

The second defect matches the collected Eliza sequence: `Wait cancelled`, several
new requests failing with generic aborts, then recovery following a job terminal
notification. It is reproduced against the actual GoalRuntime/lifecycle and SDK
Agent. This is a strong source-backed incident explanation, not retrospective
proof of every live state transition; there was no post-fix live reproduction.

## Fixes

- Stop cancelled execution at model, queue and run-settlement boundaries in both
  the Node SDK and the prebuilt bundle used by standalone Pi. Restore consumed
  but unadmitted queued input transactionally. Do not automatically restart a
  stopped tool, job, Goal or cancelled run.
- A fresh, unowned user-prompt boundary releases stale Goal tool ownership,
  including idle human input arriving through the extension API. Busy steering,
  owned/cancelled Goal markers, continuation markers, recovery and budget-wrap-up
  automation do not acquire that permission.
- Releasing the stale guard does not resume or authorize the paused/blocked Goal,
  reset its budget, or take another workflow's mutex.

## Behavioral checks

```sh
nix build --no-link -L \
  .#checks.x86_64-linux.pi-run-cancellation \
  .#checks.x86_64-linux.goal-fresh-prompt \
  .#checks.x86_64-linux.workflows-runtime
```

The cancellation check observes the original SDK/bundle defects, rejects their
behavior, executes the corrected code and functions extracted from the shipped
native artifact, and runs the actual standalone Pi process through public RPC
against an offline provider/wait-tool fixture. It verifies a cancelled wait is
not replayed, two queued inputs survive, and an explicit fresh request uses a
distinct, clean signal and can execute its tool.

The Goal check uses production lifecycle handlers and GoalRuntime with real SDK
Agent execution and controlled context/session boundaries. Four fresh requests
work for both paused and blocked Goals; budgets, Goal state and a sibling mutex
stay unchanged. Busy steering and automation stay blocked. A mutant restoring
the old guard must fail at the fresh-input/`Operation aborted` assertion.

The consumer's `pi-bridge-native-rpc` check separately verifies the input's actual
provenance through the built bridge artifact, Unix socket and native Pi process.
A full native Goal/Paseo/client interaction is not implied by composing those
focused checks. No live provider, credentials or existing process is required.
