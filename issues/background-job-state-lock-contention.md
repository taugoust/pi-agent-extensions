# Background-job state lock contention and stale-owner safety

## Status

Open. Retained-record scan contention is mitigated locally; lock ownership/recovery and slow launch contention remain open.

## Evidence

- Rose reported `Timed out acquiring the background-job state lock` on start at 2026-09-14T12:41:40Z and 13:17:18Z. Later retries succeeded; no lock remained when inspected. No evidence identifies the exact historical lock holder or proves retained scans caused those incidents.
- Rose `/home/theo` is NFS, while `/scratch/theo` is ZFS. A later read-only scan of 451 metadata files took 0.296 seconds. That measurement does not reproduce the historical stall; it also omits result/launch reads, reconciliation and launch work in the actual critical section.
- The old running Pi uses `~/.pi/agent/state/background-jobs-v1`, with 447 retained terminal results (312 completed, 121 failed, 8 cancelled, 6 lost). Fresh launches use a different, mostly empty `.config-rose/pi` store. Inspecting the new root alone misses the load affecting the old session.
- `JobStore.withLock` waits five seconds. `BackgroundJobManager.start` holds this global lock through `list(1000, false)`, infrastructure pruning and the full tmux launch. `list` previously walked every job serially; even terminal jobs read metadata/result/launch JSON (each with lstat/read). Network-home latency therefore scales with retained history.
- A regression fixture injects an 80ms delay per retained-record probe (`get`) for 80 terminal records, using the real filesystem lock and two concurrent `start` calls. The original serial scan requires at least 6.4 seconds and the second start fails with the exact lock-timeout message. Bounded eight-worker scanning completed both starts in 1,631ms locally with unchanged lock deadline; measured maximum concurrency was eight even with corrupt-entry exceptions. It scans all records, preserves ordering/limits and continues past errors. The latency is synthetic, not a reproduction of Rose's historical I/O. This reduces contention; it does not guarantee sub-five-second lock holds for arbitrary stores or slow tmux launches.

## Separate stale-lock defect

Recovery uses only directory mtime older than 30 seconds; the owner token embeds PID but is never consulted during reclaim. A local isolated reproduction keeps one `withLock` callback active, backdates `.lock` by 31 seconds, and successfully enters a second `withLock` callback simultaneously. This models a suspended owner/failed heartbeat, not proof that it happened on Rose.

There is also a check/rename race: after a contender stats an old lock, another contender can reclaim it and acquire a replacement; the first contender can then rename that replacement using its outdated observation. Heartbeats update the pathname, not a pinned lock generation. Failed owner publication after mkdir can leave an ownerless directory until the stale interval.

The stale algorithm is unchanged by the scan mitigation. A correct recovery contract must preserve mutual exclusion across stale contenders and resumed owners, including a shared/network home. Local PID liveness alone is insufficient across hosts and PID reuse. Do not manually remove locks or shorten the stale interval as a workaround.

## Validation

- `background-job/test.mjs`: new contention regression plus existing lifecycle checks pass; restoring the original serial scan reproduces the timeout.
- `background-job/watch.test.mjs` and `background-job/startup.test.mjs`: pass.
- Standalone `background-job/pane.test.mjs` initially failed the adopted-pane cwd guard at line 60 in this environment, including with `manager.ts` restored from HEAD. Not caused by the concurrent scan change.
- Combined isolated Nix checks subsequently passed: `nix build --no-link "path:$PWD#checks.x86_64-linux.subagent" "path:$PWD#checks.x86_64-linux.background-job"` (exit 0), including pane adoption and real Pi lifecycle tests.
