# Native subagent reap races with pane process exit

## Status
Fix implemented locally and tested; not published or deployed.

## Evidence and mechanism
Rose session `49397c02-bb99-45b7-a6fc-42e726cd636c` recorded `subagent reap` for `subagent-job-5b7b2557d40488b2309d3c3d` failing at 2026-09-14T18:25:32.386Z with ENOENT reading `/proc/1520964/stat`. The retained group now records its child completed/reaped after a later successful attempt. Inspection was read-only.

`TuiWorkerTmux.inspect` could see a live tmux pane, then attempt a process-token read after the process exited. The missing proc entry was surfaced directly rather than obtaining a fresh pane snapshot. Missing proc metadata alone must not authorize deletion.

## Fix and validation
Retry ENOENT at most twice, with a short delay and full server epoch, ownership nonce, group, pane PID and process identity checks on each fresh snapshot. Revalidate the located server epoch too. Other errors and changed identities remain failures. Deterministic tests cover live-to-dead races and ownership changes; full subagent Nix check and real installed-Pi TUI tests passed.

The broader native-RPC test failure was an assertion mismatch, not a proven production defect: deliberate termination can reject an in-flight operation with `native subagent RPC process exited` as well as the two previously expected errors. The test now accepts that exact error and additionally verifies inactivity, absence of protocol error, and the process-close trace. No production RPC behavior changed.
