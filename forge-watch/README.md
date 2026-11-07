# Forge watch

> **Work in progress, not full delivery:** the GitHub backend and standalone approval checker have live MCP evidence. GitLab OAuth bootstrap is implemented, but human login and live MR schema/revision qualification are pending; GitLab polling and approval currently fail closed. See [validation status](../docs/forge-watch-validation.md). Do not deploy this as a completed GitHub+GitLab integration yet.

An opt-in Pi extension for **subscribed GitHub PRs and GitLab MRs**, not a universal forge API. Timers call a standalone MCP client; no Agent, model, prompt, cache-refresh request or periodic Goal continuation is needed to discover changes. A relevant event can start model work only in the explicitly subscribed current session/Goal activation while it is waiting.

Keep using direct MCP tools for reading detailed discussions and for agent actions. The watcher does not replace, hide, approve, merge, or change the exposure of those tools. It does not use GitLab to-dos as an event feed, install n8n, expose an HTTP ingress, or duplicate nixbot: use `nbo` for nixbot CI.

## Installation and trust

```nix
programs.pi.extensions.forge-watch = {
  enable = true; # includes workflows
  settings = {
    intervalMs = 60000;
    timeoutMs = 30000;
    maxConcurrency = 2;
    reviewer = "your-human-account";
    servers = [
      {
        provider = "github";
        host = "github.com";
        url = "https://api.githubcopilot.com/mcp/readonly";
        auth = { command = "gh"; args = [ "auth" "token" ]; };
        maxPages = 100;
      }
      {
        provider = "gitlab";
        host = "gitlab.com";
        url = "https://gitlab.com/api/v4/mcp/";
        auth.oauthFile = "${config.home.homeDirectory}/.config/pi/forge-watch-oauth/gitlab.json";
        maxPages = 100;
      }
    ];
  };
};
```

Without Nix, select `forge-watch` and `workflows` from this package and use user-level `defaults/forge-watch.json` or `forge-watch.json` under Pi's agent directory. Mutable user settings override defaults. The standalone public `@earendil-works/pi-mcp` dependency is declared and pinned at 1.4.0, and included in the selective Nix bundle. Normal package installation resolves it without discovering Pi's private layout. Build the isolated bundle with `nix build .#forge-watch`; publication is not host deployment. The extension does not import Pi's private connection manager or reuse a finished tool context.

**These are explicit background-call authorizations.** The independent MCP connection cannot inherit a model tool-call permission context. Server host, transport URL and credential source must therefore be deliberately configured by the operator; project/workspace files cannot supply credential commands. Credential commands run as an executable plus arguments, not a shell. Use exactly one credential source: `auth.command` plus `args`, `auth.env` naming a token environment variable, or `auth.oauthFile`. Never put tokens in Nix or committed JSON.

Only the adapters' fixed read operations are callable through the watcher. A server advertising write tools, or an operator widening an allowed-tools list, does not make writes reachable. Ordinary direct MCP tools remain governed by their existing exposure/permission pipeline. Configure action servers separately in Pi's native `mcp.json` (for example GitHub's `/mcp/` rather than the watcher's `/mcp/readonly` endpoint); this extension never withdraws or changes those tools. GitLab's direct Pi MCP login and the standalone watcher grant use separate credential stores—neither is silently adopted as the other.

## Authentication

GitHub can use an already authorized `gh auth token`. GitLab's official MCP server has a separate OAuth `mcp` scope: an authenticated `glab` PAT is **not proof** of MCP authorization. Idle polling never opens a browser or starts interactive login. Perform the explicit OAuth bootstrap before subscribing and keep its credential file private (owned, regular, mode 0600). Login instructions and live endpoint qualification are recorded in the validation report accompanying the change.

A missing/expired credential, unsupported server facet, truncated result, or pagination limit is an error—not an empty successful snapshot or an approval. Inspect `/forge-watch` or `forge_watch status` for errors. Reauthenticate explicitly, then retry; never paste credentials into a Goal task, notification or approval result.

## Subscribe, wait, inspect and acknowledge

The `forge_watch` tool accepts `watch`, `unwatch`, `status`, `events`, `ack` and `check`. Identity-bearing operations require the exact `goal_id` and `activation_id` from the latest Goal contract. Targets are clean, fully qualified HTTPS PR/MR URLs, for example:

- `https://github.com/owner/repository/pull/42`
- `https://gitlab.com/group/subgroup/project/-/merge_requests/42`

Self-hosted hosts must have an explicitly configured server. Git repository names, branch names, paths or parent-session membership do not establish a subscription.

```json
{
  "action": "watch",
  "goal_id": "<current goal_id>",
  "activation_id": "<current activation_id>",
  "url": "https://github.com/owner/repository/pull/42",
  "categories": ["head", "state", "comments", "reviews", "ci"],
  "ignore_actors": ["automation-account"],
  "require_approval": true,
  "expected_head": "<full current revision SHA>"
}
```

Subscribe **before** calling `goal_wait` alone. Do not add a periodic wake deadline merely to poll the forge. Existing content is baselined without a notification flood; subsequent meaningful changes are deduplicated. A notification contains only bounded status/identity data, not trusted instructions or proof of approval. Retrieve details with direct MCP reads, consume the event IDs with `events`, and acknowledge handled IDs with `ack`. Repeated unchanged polling and an already-notified unacknowledged batch remain quiet.

Use `ignore_actors` only for expected self/automation discussion activity. It does not suppress head changes, state changes, CI changes or the fresh completion check. Fingerprint persistence and acknowledgement—not a timer-driven agent reaction—prevent loops caused by re-reading the agent's own activity.

`unwatch` with a URL removes that target's subscription; without a URL it removes the current activation's subscriptions. It does **not** remove a required human-approval obligation. `/forge-watch` is a non-inference status command. No operation silently resumes a paused Goal.

## Deterministic approval and completion

`check` uses the configured human reviewer and a caller-supplied full expected head SHA. It fetches fresh forge state and fails closed for stale/dismissed/revoked approval, reviewer mismatch, unknown/incomplete results, authentication errors, or a changed head during the check. A notification, CI result, checklist status or model-written summary is not authoritative approval.

`watch` with `require_approval:true` additionally installs a durable per-Goal completion obligation. The Goal completion path awaits the fresh check **before** changing lifecycle state, even if every checklist task is marked completed. The obligation survives unwatch, extension reload and a new activation; an unavailable checker must deny completion rather than silently disappear. Updating `expected_head` requires a fresh approval for that exact revision; the obligation's human reviewer cannot be replaced through a watch call.

The standalone verification command is `forge-watch/check-approval.mjs` with `--url`, `--reviewer`, `--head` and `--config`. It emits deterministic JSON and exits nonzero unless the fresh current-revision check succeeds. This is suitable for existing verification gates; it never approves or merges on a person's behalf. The Goal guard and external command use the same checker, but verification of a delivery claim is not a substitute for the pre-completion guard.

GitHub review records expose `user`, `state` and `commit_id`; an approval must belong to the required reviewer and exact current head, not merely an old approved review. GitLab approval semantics must be qualified against the actual server: a current `approved_by` flag without revision-bound evidence is insufficient. Unknown or unsupported revision evidence is deliberately a failing result, not a relaxed approval policy. See the live qualification report for the supported server capabilities and any required explicit human revision-attestation protocol.

## Persistence, costs and recovery

Per-session private state under `state/forge-watch-v1/` stores target baselines, explicit subscription identities, pending event IDs, delivery receipts, acknowledgements and approval obligations. State is not added to model context. Snapshots are bounded and atomically replaced; malformed, foreign-session or unsafe state fails closed. Overflow/errors are visible rather than silently presenting incomplete event history as complete.

Polling has latency of approximately the interval plus request duration/backoff; each target may require multiple paginated MCP reads. Equivalent subscriptions share a target poll within the owning runtime, not across unrelated processes or sessions. Choose intervals with API quota and page counts in mind. Timeouts, bounded concurrency, retry-after and jittered backoff prevent tight loops. Rate-limit/auth failures do not create periodic model turns.

Shutdown cancels timers and closes owned transports. Reload/restart cannot deliver an old activation's event to a new or foreign Goal. Inspect retained status/events and explicitly resubscribe in the current activation; do not infer subscription authority from a wait reason. Paused/stopped/completed Goals are never automatically reactivated. While a Goal is explicitly waiting, its existing cache warming and automatic continuation are suppressed without changing unrelated sessions.

No host deployment or active-session restart is implied by installing or publishing the extension.

## Validation

Unit tests cover the deterministic engine/storage/adapters/checker with controlled clocks and MCP fixtures. `tests/forge-watch-runtime.mjs` exercises separate extension factories in a real offline `AgentSession` and counts actual model requests. Live GitHub and GitLab MCP evidence is reported separately from fixtures; neither mocks nor REST-only access can establish live MCP support. Use the accompanying review/validation report for exact commands, revisions, endpoint capabilities and remaining human dependencies.
