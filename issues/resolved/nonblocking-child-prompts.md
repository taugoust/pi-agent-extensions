# Child steering blocks the parent until the entire child run finishes

## Status

Resolved.

## Resolution

Commit `fa20985aee091621d3567b9abddaa2110ff818db` separates prompt acceptance from optional full-run response collection. Live-tested locally; Rose deployment is handled separately.

## Problem

On Rose, the parent sent a steering instruction to a long-running build supervisor with `operation=prompt`. The tool waited for `agent_settled`, blocking the parent while the child continued polling builds. Message acceptance was incorrectly coupled to full-run response collection for ordinary supervisory instructions.

## Behavior

Prompt control now returns on RPC acceptance by default. `wait_for_response: true` explicitly requests the previous full-run response behavior. Acceptance is not completion or proof of processing. A non-blocking request returns `busy` without dispatch if another control owns the channel. Older live handles lacking this capability reject explicitly rather than silently blocking or relaunching work.

## Validation

Focused native RPC and control registry tests pass, including a child that accepts messages but never settles. A live Pi child accepted the default steering call in 2 ms and remained running; the test child was then explicitly cancelled and its cancellation confirmed. No Rose workers were interrupted.
