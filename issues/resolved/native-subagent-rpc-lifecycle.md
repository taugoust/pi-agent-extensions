# Native subagent RPC lifecycle regressions

## Status

Resolved.

## Resolution

Commit `8396718d6d672e7d47442581a65424dd515f1b6f` fixes RPC content reconstruction, cancellation safety, visible completion reporting, raw exit diagnostics, process-group control-channel ownership, and misleading tmux exit footers. The fix was hot-deployed and live-tested locally; Rose deployment is handled separately.

## Findings

The RPC refactor skipped thinking content indices, then spread sparse content arrays into explicit undefined entries. Progress extraction dereferenced these entries; RPC observation swallowed the exceptions, while cancellation let one escape and crash the parent before terminating its child.

Background completion messages were hidden from the transcript. Unexpected-exit reports discarded raw exit/signal evidence.

A separate live failure was reproduced with syscall tracing: the process-group anchor sent `kill(0, SIGKILL)` without a parent cancellation request. A model-free reproducer narrowed this to completing one process, launching successors, and forcing Bun garbage collection. The successor's extra-stdio control channel received EOF, triggering the anchor's parent-death cleanup. Replacing child_process-owned extra pipes with an explicitly owned named FIFO eliminated the reproduction.

## Validation

Local live Pi tests exercised streaming, cancellation during partial text with a throwing progress observer, retained exit diagnostics, and visible background completion messages. The sequential-process/forced-GC reproducer failed before the FIFO change and passed afterward. Context-limit finalizer behavior was not changed.
