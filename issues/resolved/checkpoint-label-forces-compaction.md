# Native resume compacted low-context milestone checkpoints

## Status

Resolved.

## Evidence

On eliza.dos, Carbonara's worker used a 1,000,000-token model window but compacted at 105,228 tokens (2026-10-01 16:37 UTC) and 50,001 tokens (16:58 UTC). The measured `requiresCompaction` flag was false. Native resume nevertheless ORed that flag with the model's `checkpointed` outcome, turning ordinary saved milestones into mandatory compactions.

The parent did not request `compact:true`. Its 30-second control timeout expired before the final compaction completed roughly 70 seconds later, so the continuation was never dispatched.

## Resolution

`b02252f` uses measured context pressure (at least 80% of the model window) or an explicit `compact:true` request. `checkpointed` remains task-outcome metadata and no longer forces compaction. Low-context checkpoints accept `compact:false`; measured high-context resumes still reject disabling necessary compaction. Both live and new-attempt compaction requests have a five-minute deadline; live observation respects cancellation.

Nix subagent checks passed (47 tests). The native regression exercises 50,000 and 105,228 token checkpoints without compaction, the 800,000-token threshold, explicit compaction, failure recovery, and subsequent dispatch. Existing worker/session history is retained; the foreground-task UI work is separate.
