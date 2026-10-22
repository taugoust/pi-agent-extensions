# Native display defaults and retained agent lifecycle

## Status
Implemented locally; deployment verification pending.

## Changes

Keep stamp/cache collection and Paseo observations enabled, but hide native
analytics decorations by default through independently managed
`programs.pi.extensions.{stamp,cache-hit-monitor}.visibleByDefault = false`.
`/stamp show`, `/stamp hide` and `/cache-hit-monitor` control runtime display;
Nix-managed defaults are read at session start without changing collected data.

The packaged Pi adds a native `showToolTiming` setting to shell renderers and
`/settings` (Tool timing). The host settings default it to false without changing
timing measurements. This is a small core setting patch because upstream lacks
an equivalent setting, not a replacement renderer. Test/install-check phases are
disabled for this review deployment, as requested.

Background-job wait cancellation reports only `Wait cancelled`, retaining its
AbortError identity and leaving the running job untouched.

Read-only native agent rows expose reaped state independently of execution.
Successful cleanup also persists reap state for terminal children never started;
missing manifests for started workers still fail closed. Native retention rows
are paginated before foreground helper rows, with unreaped inventory prioritized.

Goals create/edit validation accepts omitted token budgets. Paused creation
passes undefined to createGoal, preserving unlimited semantics instead of the
legacy 250,000 fallback. Existing edit commands preserve a goal's current budget
when no new budget is supplied.

## Verification

Source/diff and patch-application review, normal package build, and deployed
settings/artifacts and live read-only metadata inspection. No tests, typechecks
or smoke scripts; no credential changes or automatic reload of active Pi sessions.
