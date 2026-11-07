# Inference-free forge subscriptions and revision approval

## Status

In progress. GitLab live qualification and final publication/review remain required.

## Problem

Idle Goal coordinators need relevant PR/MR changes without periodic model calls, and completion must not confuse notifications or checklist state with current-revision human approval. Agent actions still need their direct MCP tools.

## Desired outcome

An explicitly subscribed, durable MCP watcher for GitHub PRs and GitLab MRs, with bounded polling and deterministic fresh approval checks before Goal completion. No n8n, public ingress, universal forge CRUD layer, approval/merge mutation, or host deployment.

## Remaining work

The GitLab official MCP endpoint requires a separate human OAuth `mcp` grant; the existing CLI PAT was rejected and the login questionnaire timed out without an answer. Authenticated MR schema, pagination, and revision-bound approval evidence are not yet qualified, and that backend fails closed. The generic/GitHub receipt and guard review corrections have passed focused independent checks; full-feature independent acceptance still depends on GitLab qualification. The producer review, authorized consumer pin/MR, and human approval of the final reviewable revision are not yet delivered.

See [implementation and current limitations](../forge-watch/README.md) and the [evidence ledger](../docs/forge-watch-validation.md). Mock/fixture checks, live forge reads, and final human approval are separate evidence classes.
