# Runtime-verified subagent acceptance

`acceptance: string[]` remains required for every new task. It describes the requirements; the worker's `task_outcome` is **model-reported evidence**, never a runtime check or independent review.

Optional `verification` supplies explicit command gates, separately from those criteria:

```json
{
  "task": "Implement the requested change",
  "acceptance": ["The requested behavior is implemented and tested"],
  "background": true,
  "verification": [
    { "command": "nix develop --command make test", "timeoutMs": 120000 },
    {
      "command": "./check-report",
      "output": "json",
      "schema": {
        "type": "object",
        "properties": { "verdict": { "type": "string", "enum": ["ok", "blocked"] } },
        "required": ["verdict"],
        "additionalProperties": false
      },
      "verdict": { "path": ["verdict"], "equals": "ok" }
    }
  ]
}
```

Configure gates on each parallel/chain item, not on the group. There are 1–8 gates, at most 32 KiB of configuration, commands at most 8192 UTF-8 bytes, and a per-gate timeout of 1–600000 ms (default 120000). Unsupported fields reject before launch. No cwd/env overrides, inferred commands, allowed failures, result caching, or added delegation are supported. Retained attempts keep their gates; control/resume operations cannot replace them.

## Authority and backends

Native Linux TUI workers execute commands through their own existing durable background-job supervisor in the **actual worker cwd/worktree**, with live session-bound Permission Gate authorization for that exact command and cwd. The worker must already have `bash` authority; a read-only allowlist cannot gain command execution from verification. The controller's existing model-callable job operations are not broadened. Jobs use the worker's ordinary session ownership, placement, cancellation, and recursive cleanup rules, not direct host-shell spawning.

Verification requires a live supervised job controller and permission authority. A missing controller/permission, full AgentSH job backend, or unsupported placement is **Unavailable**, not success. Headless foreground helpers currently have no tmux job placement and therefore cannot verify commands: configured gates are retained and produce Unavailable/failed delivery. Full AgentSH and non-Linux legacy execution reject configured verification before launching a worker; no native fallback occurs. Use a native background task when actual runtime checking is required. None of this changes Paseo UI or activates/restarts a running Pi.

## Separate states

- Worker execution can finish without reporting delivery.
- `task_outcome` remains the worker's claim and criterion evidence.
- `verification.status` describes runtime checks: `not-configured`, `checking`, `passed`, `failed`, `unavailable`, `interrupted`, `cancelled`, `timed-out`, or `stale`.
- `accepted_delivery` requires a settled worker, a delivered claim, and **all configured gates passing for the current workspace**. Unconfigured checks are never labeled passed; legacy ungated delivery remains a claim without independent verification.
- `review: "not-configured"` is independent. Passing commands do not prove every requirement correct or imply review.

Configured nonpass gates block accepted delivery and failed/unavailable checks produce a failed native result. A checking worker remains active for lifecycle purposes even though model execution finished. No delivered outcome wake/terminal success is sent before verification and supervised cleanup settle. Existing terminal notification deduplication and explicit reap remain in effect.

Current acceptance is revoked **before** a fresh native-manager observation is attempted. Disconnects, non-ok replies, missing/invalid manifests, and observation errors cannot leave a cached pass or `accepted_delivery: true` on status/list/wait/result surfaces. A process-private observation receipt pins the current owner/task/attempt/runtime/epoch/contract; public rendering also rechecks the checked workspace so changes after an observation produce Stale. Parent reload/restart cannot resurrect persisted green caches; an unchanged still-live worker can restore acceptance only through a fresh authenticated observation. This is a point-in-time observation, not a promise of continuous worker/network liveness.

Prior verification is retained separately as `historical_verification`, never current acceptance. Its provenance distinguishes a process-local live-worker observation from retained-unverified JSON; restoring a manager from disk does not certify historical claims. Invalidated current command rows are Unavailable/Interrupted/Stale rather than old green passes; their real historical exit codes and immutable literal artifacts are not rewritten. Result text presents the worker report first, with labeled diagnostic summaries when requested. Structured result details retain current verification and `accepted_delivery`; original evidence snapshots remain in the private artifact, with retained command evidence labeled historical. Configured nonpass terminal notifications cannot report completed success; notification identities include check state and retain deduplication. Already-delivered receipts remain historical notifications, not authority for current acceptance.

## Typed JSON and business verdicts

An `output: "json"` gate must print exactly one complete JSON document on stdout. Empty, invalid, truncated, or schema-invalid output fails the check even if the real command exit code is zero. stderr is never parsed as a substitute. Literal streams are retained, not trimmed, normalized, summarized, or redacted; do not print secrets.

The local JSON Schema subset supports `type` (object/array/string/number/integer/boolean/null), `properties`, `required`, boolean `additionalProperties`, `items`, scalar `enum`/`const`, `minimum`/`maximum`, `minItems`/`maxItems`, `minLength`/`maxLength`, and annotation `title`/`description`. Schemas are bounded to 16 nesting levels. Unknown keywords, references, malformed schemas, or unsupported constructs reject rather than silently skip validation. No network schema resolution occurs.

A business verdict is separate from process execution. Without `verdict`, valid `{"verdict":"blocked"}` is data and an exit-zero JSON gate passes. Configure `verdict.path` (object-key segments, or `[]` for the root) and scalar `equals` to reject business outcomes. A rejected business verdict retains `exitCode: 0`, parsed output, and `businessVerdict: false`.

## Evidence and workspace binding

Private worker state and immutable-by-contract result snapshots retain the literal command, actual cwd, owner/task/child/attempt/runtime/epoch identity, job ID, start/end time, duration, real exit code, stdout/stderr, truncation, typed output, and before/after workspace fingerprints. Each stream is bounded to 50 KiB by the supervisor; any truncation fails verification, including ordinary text gates. `subagent operation=result diagnostics=true` presents the worker report followed by bounded, labeled diagnostic fields as paginated human-readable text, never raw session/assistant JSON. The private artifact retains the immutable full evidence; structured status contains bounded summaries, byte counts and the artifact path rather than dumping logs into chat. Offsets apply to the selected ordinary or diagnostic text view and pages end at UTF-8 boundaries.

Workspace identity is a SHA-256 byte-tree fingerprint of the actual cwd, or its enclosing Git worktree root when nested, including untracked and ignored files and file modes; only `.git` metadata is excluded. It is **not** a Git revision, environment fingerprint, filesystem sandbox, or proof of full reproducibility. It excludes external dependencies, environment variables, services, and Git metadata. Commands must leave that byte tree unchanged to pass. Put generated test artifacts outside the checked tree or accept a Stale result; there is no silent ignored-file exemption. Identity capture refuses symlinks/special files, changing files, more than 20000 entries, more than 64 MiB of file bytes, or nesting beyond 64 levels. Unsupported/oversized workspaces are unavailable, never partly fingerprinted as successful. Later relevant tree changes invalidate current passed status; prior immutable evidence remains historical, not current acceptance.

## Recovery and cleanup

State is persisted privately before dispatch, on job-ID acquisition, before log removal, and after settlement. Each dispatch retains a not-dispatched/intent/observed/cleanup-pending/cleaned state. A live controller can prove authorization failed before launch; absence from an incomplete inventory is not treated as that proof. A lost launch receipt can mean a job already exists: all unresolved dispatch intents, including unavailable records without a job ID, are resolved against actual supervisor metadata and never silently skipped or replayed. Metadata must match the authenticated native worker epoch/session, command and cwd and carry the supervisor-only verification marker; a saved arbitrary job ID or model-selected job name is not cleanup authority. Verification jobs remain visible but are excluded from ordinary five-minute output auto-expiry until evidence is durable and explicitly reaped. Valid literal terminal output must be retrieved, supervisor-attested and durably saved before reap. Unavailable/invalid output leaves the job logs and cleanup intent intact for repair/retry; unresolved verification dispatches also block the worker's ordinary recursive reap, so that path cannot silently delete withheld evidence. Incompatible task/attempt/owner/runtime/epoch/contract records are quarantined as inspection-only artifacts, not cleanup authority.

A persisted `passed` string, exit code, job ID, or workspace fingerprint is **not** a verification credential. Runtime success requires a live process-private receipt minted only after the supervised controller re-reads the matching actual job result and literal streams, and cleanup completes. The receipt binds the exact runtime record and is never serialized. A worker extension reload/restart, reaped worker, or disk-only observation therefore downgrades even a well-shaped historical pass to Interrupted, with accepted delivery false; it does not automatically rerun commands. A parent-only restart can obtain a fresh authenticated status from a still-live worker. Historical result JSON remains available as evidence but does not restore current acceptance. Missing ownership/backend authority or failed cleanup stays unavailable/interrupted with IDs available for repair; ordinary recursive reap refuses active jobs.

This separates trusted harness/supervisor observations from model `task_outcome` claims and fabricated worker JSON. It is **not an OS isolation boundary against arbitrary same-UID code**: native jobs, worker tools and extension code run as the same user, and an unrestricted shell or malicious trusted extension may modify files, supervisor metadata, loaded code or process memory where the OS permits it. File permissions and immutable-by-contract snapshots prevent accidental/world-accessible replacement, not hostile same-user tampering. Strong adversarial independence would require a separately isolated supervisor/OS principal, which this extension does not claim to provide.

On cancellation, timeout, new model activity, or shutdown, verification is cancelled through the supervisor. Evidence is persisted before terminal job logs are reaped. If evidence persistence fails, active work is cancelled but terminal logs remain for explicit recovery. The existing worker-crash lock recovery policy still applies: restarting an arbitrary crashed process is not automatic. Parent observer loss does not authorize command replay, infer worker death, or bypass job ownership.

## Provenance and offline controls

The explicit gate parser and typed-output validation are adapted from `nicobailon/pi-subagents` `src/runs/shared/acceptance.ts` at reviewed snapshot `3ce6185a`; focused controls adapt `test/unit/typed-gate-output.test.ts`. The upstream acceptance-gates/typed-gates contract informed this narrowed API. See [THIRD_PARTY.md](../THIRD_PARTY.md) and the retained [MIT notice](../subagent/agents/LICENSE). Upstream's direct shell spawn, automatic attestation/inference, review orchestration, and memoization are deliberately not used.

Offline native tests in `subagent/acceptance.test.ts` and `subagent/acceptance-adversarial.test.ts` exercise fabricated success versus supervisor results, typed data/schema/business verdicts, literal output, truncation, denial/unavailable, timeout/cancel, workspace changes, recovery/cleanup and premature terminal receipts. The Nix background-job check additionally executes real supervised tmux commands with exit 0 and exit 7 and checks permission/tool ceilings, actual cwd, literal streams and rejection of tampered evidence/attempt identity. The offline real-Pi root fixture exercises the actual native manager, Permission Gate, job supervisor and worker delivery path for exit 0, exit 7 and a read-only worker (or explicit Unavailable when no Permission Gate backend is loaded), without provider credentials. Paseo presentation/device validation is deferred.
