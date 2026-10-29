# Model-managed goals and linked progress

## Status

Implemented and deployed for unpublished review. Production build/switch succeeded to `/nix/store/ip74hv8lyg858hhd1ij9m48nf8haipp8-nixos-system-matebook-26.05.20260916.4c78701`. Normal Nix check/smoke settings were restored in source afterward. Active Pi sessions require reload; live goal/tool/UI behavior remains for user review.

## Changes

Historical deployment notes below describe the prior contract. The goal/checklist API unification supersedes its standalone-write and create-paused defaults; see [current API and migration notes](../workflows/README.md#existing-per-childterminal-goal-engine-model-managed-goals-and-tasks). This does not claim deployment of that follow-up.

- `goal_manage` creates, inspects, updates, pauses, resumes and clears the existing candidate Goal engine from chat. Explicit user authorization enables autonomy; automatic turns cannot mutate Goal controls to reset themselves.
- Activation joins the current tool run, not recursive prompt submission. Existing budget, continuation, no-progress, wait and blocker safeguards remain.
- `update_progress` is still the checklist source. It defaults to the current goal; `goal_id:null` supports standalone work. Scoped session entries and stable task IDs preserve progress across wording changes, goal-instance rotation, reload, branching and compaction.
- Unfinished tasks cannot be silently removed. Explicit user-requested scope edits may remove them. Current goal/checklist reminders are included in model context, and completion rejects unfinished required tasks.
- Work now includes Goals; the separate Goal pill and mandatory creation form are removed. The tab provides the objective, tasks, state/reason, pause/resume, conditional edit/limits controls, and paused/idle task addition.
- Empty Goals supports creating a persisted paused goal without model dispatch. Older running Pi workflow services omit the `createPausedGoal` capability; the bridge keeps the draft input visible but disables submission and instructs a full Pi restart. Creation does not call the model-managed start path; Resume remains explicit.
- Paseo's native progress result parser accepts the optional goal association while preserving its existing checklist projection.

## Verification boundary

No tests, typechecks, smoke scripts or live model probes are run for this review batch, per user instruction. Source review and production build/deployment do not establish live autonomous-goal or UI correctness. User authorization is interpreted by the model under explicit tool guidelines; the harness additionally rejects management mutations from automatic Goal turns. Completion still requires honest outcome evidence, not merely completed checklist statuses.
