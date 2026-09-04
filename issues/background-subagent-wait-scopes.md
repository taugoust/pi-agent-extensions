# Add child, group, and global background-subagent waits

## Status
In progress.

## Problem
The background `subagent` lifecycle can wait for one aggregate job, but it cannot wait for the next child completion across groups or for every currently active group. Supervisors otherwise need to poll each group manually.

## Desired behavior
- `wait_any` waits for one currently unfinished child across all groups owned by the current Pi session; simultaneous completions remain observable through group status/results rather than forming a queue.
- `wait_group` waits for one complete aggregate and keeps `wait` as a compatibility alias.
- `wait_all` waits for every group that is active when the operation begins.
- Every wait is bounded by `wait_ms`; cancelling a wait never cancels execution.
- Child progress survives same-process extension reload and works for native and AgentSH single, parallel, and chain groups.
- Groups launched after `wait_any` or `wait_all` starts do not extend that wait.
