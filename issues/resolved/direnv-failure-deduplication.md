# Deduplicate supervised direnv failures

## Status

Resolved.

## Problem

The direnv extension refreshed after every supervised Bash result. When an `.envrc` was not yet allowed, each refresh repeated the same warning. If the supervisor subsequently became unavailable, secondary direnv transport errors added more noise after the primary tool failure.

## Resolution

Commit `063ac8c` reports only the first consecutive direnv failure in a session. Successful `loaded` or `unchanged` refreshes reset the failure state, so a later genuine failure is still reported.

The direnv check verifies that repeated `not_allowed` results produce one actionable warning and that a new session still reports its first policy denial.
