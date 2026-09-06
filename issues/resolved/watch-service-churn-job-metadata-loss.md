# Watch service churn evicted a recently completed user job

## Status
Resolved in code; Rose activation is required. Deleted historical metadata cannot be restored by this fix.

## Evidence
Read-only Rose inspection on 2026-09-06 found job-dd471c4c2f7db878d6946130 absent from its original store after several successful waits. The store held 110 records, 101 infrastructure jobs named Persistent log watch service, starting every two seconds and exiting successfully in roughly 120 ms. Four watches remained running with sequence zero. The watch command used the Home Manager symlink path, whereas Node's import.meta.url resolved to the immutable source. The runner's entrypoint equality check silently skipped main. Recovery repeatedly spawned new infrastructure jobs; the shared newest-100 terminal retention policy removed recently finished user records.

The validation script's own EXIT-trap receipt survived with rc=0, and its log ended with R5 Micro repaired input gates passed. These are preserved script artifacts, not a recovered managed-job result. No Rose builds or project files were modified.

## Resolution
Commit `8716f6be3ab8adb7d6018d81f12a716023d8ce26` canonicalizes the watch launcher and its entrypoint check, adds 30-second backoff for immediate startup exits, and gives infrastructure its own 20-terminal-record quota. User records are eligible for cleanup only after seven days from completion and an explicit terminal observation; unread outcomes and recent jobs are protected regardless of infrastructure volume.

Live Pi checks passed: USER_HANDLE_SURVIVED_110_INFRASTRUCTURE_RECORDS, SYMLINKED_WATCH_RUNNER_LIVE_PASS, WATCH_RESTART_BACKOFF_PASS. A regression was added to the existing background-job test. Existing lost records/logs are not fabricated or silently relabelled as successful; their independent handoff/exit artifacts must be verified separately.
