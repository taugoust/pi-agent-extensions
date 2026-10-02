# Partial model stream looked like a hung task_outcome tool

## Status

Resolved for harness observability and regression coverage. The external cause of the original provider stream stall is not established.

## Evidence

The retained `inspect-latest-llm-agents` worker completed its last notification at 2026-10-02T13:36:54Z. Its next assistant response remained incomplete until supervisor cancellation at 13:53:47Z. The cancelled message contains a partial `task_outcome` call; there is no corresponding tool result or outcome event. It was a model-response wait, not demonstrated deadlock inside the outcome handler. Cancellation ended the wait but was not itself a fix.

## Resolution

`7cda2f9` adds a five-minute model-stream inactivity observer. It covers requests before the first response byte, excludes executing tools, sends one parent guidance request per stall, and retains a visible TUI warning until progress or a lifecycle transition. It does not cancel or replay work, invent completion, or weaken reap/authorization checks.

A real Pi 1.0 fixture yields a partial outcome frame and records a private marker before pausing. The test waits for that marker, verifies no outcome was dispatched, exercises responsive status/cancellation, verifies cancellation did not fabricate an outcome, and reaps the owned worker. Timer tests cover warning/reset/clear behavior. Full extension flake checks and strict core typecheck passed; the final subagent check passed all 61 tests.
