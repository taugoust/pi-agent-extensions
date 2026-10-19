# Stamp, Progress, and Cache monitor

Phase-one adaptations of `narumiruna/pi-extensions`, reviewed at commit `012c08dc`. Source and license attribution are in `THIRD_PARTY.md` and each imported directory's `LICENSE`.

## Enable

Home Manager options:

```nix
programs.pi.extensions = {
  stamp.enable = true;
  progress.enable = true;
  cache-hit-monitor.enable = true;
};
```

All three publish read-only, session-owned data for the companion Paseo bridge. They make no additional provider requests or automatic continuation prompts. Progress adds the model tool `update_progress`; enabling it changes the tool prefix once.

## Stamp

`/stamp` opens native Pi settings dialogs. Metadata is recorded in **TUI, RPC, and headless sessions**, unlike the upstream TUI-only collector. New messages receive timestamps, physical provider/model, thinking level, reported usage/estimated cost, and local response duration. Tool duration/outcome is enabled by default. Recorded fields remain outside model context; older messages are not backfilled. Settings live in Pi's agent directory as `pi-stamp.json` and retain upstream validation and atomic persistence.

Defaults differ deliberately from upstream: response timing is `duration`, assistant metadata `compact`, and tool stamps enabled. Other settings—including throughput, exact timeline, and time/cost since user—remain configurable. Native dialogs replace `pi-tui-kit` menus, without adding the whole toolkit dependency.

Paseo's Activity → Response stamps view shows the latest 50 stamp records with timestamps and optional details. It does **not** decorate Paseo's original message bubbles. Response IDs, diagnostic text, message content, and tool arguments/output are not exported. Local guard errors are labeled as errors, not successful model responses. Usage is provider-reported and costs are estimates, not subscription billing.

## Progress

`update_progress` replaces the complete current snapshot with up to 50 `{text, status}` steps. Status is `pending`, `in_progress`, `completed`, or `blocked`; at most one step may be in progress. Model guidance recommends meaningful updates and avoids mandatory/redundant reporting.

`/progress` manages display; `/progress clear` hides the terminal widget without deleting saved state. `/progress settings` edits display preferences in TUI; RPC reports the settings file path. Native dialogs and a lightweight width-safe renderer replace the toolkit. The widget prioritizes active/blocked work and briefly shows completion before hiding. Paseo keeps completed progress available for review.

Upstream versioned state decoding, validation, active-branch restoration, and deduplicated post-compaction context reconciliation are retained. Ordinary turns do not rewrite prompt history. Settings live in `pi-progress.json`. Progress reports what the model says; it does not verify task completion.

## Cache monitor

`/cache-hit-monitor` toggles the terminal/RPC widget; it starts hidden. Paseo snapshots are available independently of widget visibility.

Retains upstream usage calculations: observed cache reuse, request gaps, re-billed-token/miss-premium estimates, weighted active-branch totals, trends, and summary/cache-warm usage. Missing or normalized-zero accounting is not treated as a proven miss. Responses with unknown cache accounting still contribute their reported tokens/costs to aggregate totals, but not to cache-hit comparisons. These diagnostics do not predict the next cache hit, report account quotas, or guarantee savings. The monitor reads local session data and makes no network calls.

## Paseo contract

The companion bridge uses the existing private read-only harness transport, authenticated against agent/session/runtime epoch. `__paeObservabilityV1` has protocol 1 and optional `stamp`, `progress`, and `cache` services. Each service exposes `snapshot({sessionId})`, returning protocol, feature, session ID, freshness fields, and feature-specific data. Stale references fail after shutdown/session replacement; absent features are unavailable rather than empty.

Snapshots are display-only: latest 50 stamp records, up to 50 progress steps with bounded display text (ellipsis marks truncation), and bounded cache metrics. Raw progress state remains intact. The daemon validates output schemas and identity before forwarding. Paseo polls only while the Activity panel is mounted, every five seconds, with manual refresh and reconnect refresh. Settings mutations remain owned by Pi commands/settings files; this first remote panel is read-only.

## Validation and remaining verification

- Pure helper and integration tests: `nix shell nixpkgs#bun --command bun test stamp progress cache-hit-monitor shared/observability.test.ts`.
- Real Pi runtime, deterministic provider, no network: `node --test shared/observability-runtime.mjs`.
- Strict TypeScript check and `checks.<system>.observability` validate runtime imports/module wiring.
- Companion Paseo compiled-plugin tests exercise rendering, schema validation, and session-bound transport.

Deployment and **native iOS visual/interaction verification are still required** before phase one is fully accepted. Automated UI tests are not device verification. No live model calls are needed merely to collect these features' metrics.
