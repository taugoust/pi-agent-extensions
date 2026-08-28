# Mirror Paseo prompts in the terminal

## Status

Resolved.

## Problem

When a terminal-attached Pi session is connected to Paseo, maintained approval,
questionnaire, and review extensions route their interactive prompt exclusively
to Paseo. The terminal should show the same pending decision, with the first
response resolving and dismissing every other presentation while preserving
AgentSH's exact approval scope.

## Resolution

Bridge commit `f11a33198aae758b923ef71b492c5a32062c8004` adds daemon-authoritative,
first-response-wins mirrored selections. Extension commit
`5b5505ebd5576f02b2d83432f677404f1c61962f` uses them for permission-gate,
AgentSH approvals, questionnaires, and slow-mode reviews.
