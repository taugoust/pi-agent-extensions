# Running workers can notify their parent

## Status
Resolved.

## Resolution
Commit `f04ac7c7dc343ff799a6a955ff9d2648fdd95f08` adds native-child `notify_parent`. Identity is bound by the owning RPC launch, message size/rate are bounded, and private session entries preserve notifications for replay. Routine findings use hidden idle batches; explicit guidance requests use hidden steering at the next model boundary. Existing prompt control replies without terminating the child. Native launches/resumes expose the tool; AgentSH-backed workers are outside this channel.

Live Pi verification: `NOTIFY_GUIDANCE_ACCEPTED_WHILE_RUNNING`, followed by `NOTIFY_ROUNDTRIP_PI_PASS`. The same child sent a question, remained running, accepted parent steering, and returned the requested response. Focused checks also passed for batching, hidden delivery, scope validation, rate limiting, idempotency, and replay after process-state reset. No full test suite was run.
