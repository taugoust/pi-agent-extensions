# Compact job and progress tool display

## Status
In progress.

## Scope
Use human job names in native Pi background-job calls and status headers, retain
ID fallback, make successful reap output minimal, and propagate observed terminal
job failures to tool error styling. Render progress updates as one compact Unicode
summary without raw argument JSON or a duplicate success result.

Model-facing job output and progress persistence must remain useful. Do not change
job execution, retention, tmux integration or subagent execution placement.

Validation for this change is source/diff review only: user requested no tests or
typechecks. Deployment/restarts require separate approval.
