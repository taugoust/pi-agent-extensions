# Native harness workflow continuity

## Status

Resolved.

## Problem

The Rose campaign audit found four harness gaps: native children lack the parent's durable job interface; log monitoring depends on repeatedly launched LLM workers; execution completion is conflated with task delivery; and terminal child sessions cannot be resumed from durable checkpoints. This creates monitoring gaps and repeated handoff reconstruction.

## Resolution

- `5643b99`: scoped parent-owned jobs for native children and read-only adoption.
- `2996da1`: persistent literal-pattern log/status monitoring with durable cursors, event acknowledgements, and parent wakeups.
- `272783d`: explicit model-reported task outcomes separate from execution status.
- `0d6553c`: private retained task sessions, stable task ownership, explicit resume, and checkpoint compaction.

A live Pi workflow created a durable child job, reported a partial task outcome despite clean execution, emitted and acknowledged stage/terminal watch events, and resumed the same task with a successor child to report delivery without relaunching the job. Earlier focused job/RPC/outcome checks passed; final validation uses live workflows as requested.

## Required behavior

Children use scoped parent-owned jobs with fail-closed authorization and read-only adoption of existing work. Monitoring persists without an LLM polling loop and exposes durable deduplicated events. Task outcomes are explicit and independent of process success. Native tasks preserve sessions and support explicit, ownership-checked continuation without automatic relaunch.
