# Native harness workflow continuity

## Status

Open.

## Problem

The Rose campaign audit found four harness gaps: native children lack the parent's durable job interface; log monitoring depends on repeatedly launched LLM workers; execution completion is conflated with task delivery; and terminal child sessions cannot be resumed from durable checkpoints. This creates monitoring gaps and repeated handoff reconstruction.

## Required behavior

Children use scoped parent-owned jobs with fail-closed authorization and read-only adoption of existing work. Monitoring persists without an LLM polling loop and exposes durable deduplicated events. Task outcomes are explicit and independent of process success. Native tasks preserve sessions and support explicit, ownership-checked continuation without automatic relaunch.
