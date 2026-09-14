# Background jobs fail after extension discovery symlinks are removed

## Status

Fix implemented and locally tested; awaiting commit and deployment verification.

## Report and confirmed diagnosis

Rose's retained panes `%263` / `%264` for jobs `job-d5518a3f1291d9d0d62ca461` and `job-38220cf371032e0c954e2741` displayed Node `MODULE_NOT_FOUND` for `/home/theo/.pi/agent/extensions/background-job/runner.mjs`, exiting 1 on 2026-09-14 at 17:16:07 / 17:17:48. This evidence was collected read-only by the supervising agent. The background-job metadata had already been reaped.

A running Pi extension retained its old discovery URL after a Home Manager migration removed that symlink. Manager construction was lazy and derived the runner from that mutable URL. Node therefore failed before the runner could open its log or wait on `launch-ready`. `TmuxBackend.finishLaunch()` could subsequently fail reading the already-exited pane PID's `/proc/<pid>/stat`, obscuring the missing module error. A separate retained infrastructure watch job had this `launch failed: ENOENT ... /proc/.../stat` signature; it is not one of the two reported builds.

The watch service likewise resolved `watch-runner.mjs` lazily, too late to survive discovery-path removal.

## Implemented changes

- Pin both runner realpaths at module load, retaining a resolution failure for an actionable tool error rather than throwing during extension loading.
- Validate the pinned file when used; never silently switch an old extension to a replacement runner version.
- Preflight Node executable and runner readability before either visible or infrastructure tmux launch. Missing runtime paths report the exact file and advise reloading Pi before any pane is created.

This does not resurrect an already-loaded extension whose old discovery path has disappeared. Reload/restart Pi to load the corrected extension. Pinning a Nix store path does not establish a garbage-collection root; use-time validation reports removal explicitly.

## Validation

- `startup.test.mjs`: discovery symlink removal and retargeting, load-time failure retained, pinned target removal, missing Node/runner preflight without creating a pane/server, and native/infrastructure fast commands preserving both streams and exit codes 0/9/127.
- Existing `background-job/test.mjs` integration coverage includes durable reload, output, cancellation descendants, orphan recovery, explicit reap, and cancel-during-launch.
- Full `nix build --no-link "path:$PWD#checks.x86_64-linux.background-job"` passed, including startup regressions, native jobs, persistent watches, pane adoption, and extension contracts. Standalone host `pane.test.mjs` failed its unrelated late protected-pane cwd check; the isolated Nix check passed without modifying pane-adoption code.

No commit or remote mutation was performed for this investigation. Move this issue to `issues/resolved/`, set status to `Resolved.`, and record the fixing commit hash when committed.
