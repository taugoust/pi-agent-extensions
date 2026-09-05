# Task management UX

## Status

Resolved.

## Resolution

Commit `d82c4c3` adds human task/watch/job controls, clear task outcome labels, reload-aware alert deduplication, and managed adoption of existing tmux panes. Pane adoption was live-tested across controller exit and re-registration using only pane ID/socket: output/wait/signal/cancel work without restarting the original pane or affecting unrelated panes. Real Pi selector interactions were exercised without an LLM turn. Bridge commit `97da203` preserves outcome and attempt metadata for the matching Paseo mapper integration.

## Problem

Execution completion was visually easy to confuse with task delivery. Task, child, job and watch identifiers dominated output, and human operators lacked task-centric resume/report/build/alert controls. Persisted but unacknowledged watch notifications could be replayed after reload.

## Required behavior

Task-titled views distinguish delivery outcomes from worker execution, group current attempts and related jobs/watches, and expose explicit safe actions through terminal and Paseo selectors. Watch acknowledgement only consumes the displayed range. Stopping observation must not stop builds. Persisted notifications should not be replayed merely because the runtime reloads.
