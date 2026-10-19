# Adopt selected candidate extensions with Paseo integration

## Status

Phase 1 is implemented and automated checks pass: Stamp, Progress, and Cache monitor, with Paseo Activity views. Deployment and native iOS acceptance remain pending. Later phases remain planned, not authorized by phase-one implementation.

## Phase-one implementation evidence

- Adapted upstream collectors, validators, persistence, progress context restoration, and cache calculations with MIT notices retained. Native dialogs/lightweight rendering avoid the full toolkit dependency.
- Stamp collects in TUI/RPC/headless modes. Progress exports structured saved state. Cache snapshots work independently of widget visibility and retain unknown-cache usage in aggregate totals without inventing cache misses.
- Paseo Activity has three read-only views, using agent/session/runtime-bound private transport and schema validation. Stamps are a separate metadata view rather than original-bubble decorations.
- 55 focused unit tests, strict TypeScript, a real-Pi deterministic-provider smoke, and 22 guarded-compaction runtime tests with all three extensions loaded passed. No paid model calls were used.
- Nix module checks passed. Companion bridge: 133 regression tests passed (9 optional skipped), typecheck passed; compiled-plugin suite passed 23 tests (1 optional skipped).
- Native iOS acceptance remains open; implementation is not yet deployed. See `OBSERVABILITY.md` for commands, limitations, and the read-only contract.

## Source and scope

Reviewed `candidates/pi-extensions` at `012c08dc`, particularly package READMEs, relevant implementation paths, and the existing `paseo-bridge-pi` plugin.

The primary shortlist is **pi-btw, pi-accounts, pi-stamp, and pi-usage**. Also evaluate **pi-progress, pi-worktree, and pi-goal**. Additional recommendations are **pi-cache-hit-monitor, pi-file-context, and pi-analytics**.

Code may be copied and adapted rather than installed wholesale; preserve applicable MIT copyright/license notices. Packaging and reuse mechanics are intentionally undecided. Several packages depend on `pi-tui-kit`; assess that dependency rather than assuming each is a standalone file.

**Paseo integration is part of completion for every adopted feature**, including native iOS verification. RPC command support or forwarded terminal text alone does not establish feature parity.

## Proposed implementation order

1. **Stamp + Progress + Cache monitor:** visibility with limited behavioral risk.
2. **Accounts + Usage:** account identity and quota reporting designed together.
3. **BTW:** separate side conversations with an explicit model policy.
4. **Worktree**, then **Goal** with conservative limits.
5. **File Context / Analytics:** optional follow-ups.

This order is a recommendation, not a requirement to deliver the entire list in one change.

## Primary shortlist

### pi-btw — adopt

Provide side questions and follow-ups without inserting their conversation into the main model context. Bringing material back must be explicit and populate a draft, not submit automatically or overwrite an existing draft without confirmation.

**Paseo:** a BTW side-chat panel with streaming, follow-ups, model selection, cancellation, and “Add to main draft.” The existing Foreground panel is a useful UI starting point, but side-thread behavior and context selection are distinct.

**Adaptation requirements:**

- Upstream is TUI-only; extract a remotely callable side-thread service rather than forwarding its custom terminal UI.
- Define side-thread ownership, context selection, retention, and reload/reconnect behavior. Upstream retains threads only in memory and limits imported main context to its latest 40,000 characters.
- Upstream defaults to the main model and makes direct registry calls. Our guarded alias rejects direct calls, so it cannot be inherited blindly.
- Prefer a separate configurable side-thread model, initially derived from the subagent default.
- Do not silently fall back to the potentially expensive main model when the configured side model is unavailable.

### pi-accounts — adopt with authentication validation

Support named accounts and session-specific selection per provider, independent of defaults for new sessions.

**Paseo:** provider/account selection, verified active state, activation progress, and errors. Start with switching already configured accounts; add mobile login or key-entry flows separately after security and UX review.

**Adaptation requirements:**

- Keep stored credentials and credential-bearing protocols on the host. Frontend responses must never expose saved tokens.
- Upstream key entry is explicitly unmasked; do not copy that behavior into mobile UI without a deliberate decision.
- Test authentication refresh, failed activation, removal, reload/resume, concurrent sessions, and account-specific provider configuration.
- Preserve fail-closed behavior: authentication failure must not silently select another account or fall back to an environment/default credential.
- Verify account changes affect both guarded Astra dispatch and cheap Luna compaction correctly.
- Do not add automatic account rotation or quota-evasion behavior.

### pi-stamp — adopt

Show response timestamps and optionally duration, model/provider, thinking level, token counts, estimated costs, and tool timing without adding model-visible context.

**Paseo:** compact per-response metadata with expandable details, preferably associated with the original response rather than duplicating transcript text.

**Adaptation requirements:**

- Upstream records stamps only in TUI mode. RPC settings dialogs do not provide stamp recording/rendering.
- Separate metadata collection/persistence from terminal and Paseo presentation.
- Distinguish local timing observations and estimated costs from provider-server timing and actual billing.
- Preserve correlation across tools, reload, compaction, and session replacement. Never send raw credentials, payloads, or sensitive diagnostics to the frontend.

### pi-usage — adopt with explicit source limitations

Report provider/account-level allowances, balances, resets, and freshness. Keep account quota distinct from per-response costs and session cache metrics.

**Paseo:** an account-aware Usage panel with source labels, refresh state, timestamps, and unavailable/error states. Reconcile with Paseo's existing usage sources rather than displaying competing unexplained values.

**Adaptation requirements:**

- Native `openai` reporting defaults to authentication status and a usage-settings link, not numerical quota.
- Upstream's numerical ChatGPT companion reporting is experimental and opt-in, requiring a separate Codex login for the same account/workspace. The extension cannot independently prove those identities match. Validate before presenting it as the user's current allowance.
- Bind cached reports to the effective account and provider; invalidate them on account changes and reject stale responses.
- Keep secrets host-side and retain endpoint/origin validation before credential-bearing requests.
- Upstream registers `/fast`, conflicting with our existing `pi-openai-fast-mode`. Initially adopt reporting without upstream Fast-mode controls; retain a single owner for Fast mode.
- Mutating operations such as reset redemption need separate explicit confirmation; do not bundle them into read-only refresh.

## Secondary shortlist

### pi-progress — recommended for early adoption

Promote from “maybe”: a visible progress snapshot is useful without adding autonomous model turns.

**Paseo:** a persistent structured progress card showing pending, in-progress, blocked, and completed steps. Retain upstream's single-in-progress invariant and distinguish blocked from complete.

Use structured state rather than parsing the upstream fixed-width RPC widget. Restore the correct active-branch state across reload, navigation, and compaction. Treat progress as model-reported status, not independently verified completion. Avoid redundant progress calls and don't make them prerequisites for ordinary work.

### pi-worktree — adopt in a later phase

Reuse guarded Git inspection, creation, removal, and conversation-preserving workspace switching.

**Paseo:** a worktree manager with status, exact mutation previews, explicit confirmations, and switch controls.

Switching must rebind Pi session identity, cwd, Paseo workspace, private bridge capabilities, and job/subagent controls. Old UI selections must become stale rather than target the replacement session. Preserve running-work ownership and retained data; a workspace switch must not accidentally cancel or reassign jobs.

Retain destructive-operation safety checks and revalidation after confirmation, including ignored files and Git recovery pointers. This extension does not itself implement commit/push/merge workflows.

### pi-goal — later, opt-in

Autonomous continuation can help finish work but increases model usage. Do not enable it automatically for ordinary sessions.

**Paseo:** an objective/state panel with response and token limits plus Start, Pause, Resume, Edit, and Clear. Distinguish paused, waiting, blocked, usage-limited, budget-limited, and complete states.

Start with conservative response limits and optional explicit token budgets. Token budgets are not dollar caps and can overshoot by a model call. Completion evidence is model-reported, not proof that external work succeeded.

Test settled-boundary coordination with guarded compaction, queued job/subagent notifications, and manual input. Goal continuation and guard recovery must not schedule duplicate work or retry a failed guard automatically. Scope ownership and cancellation to the current goal/session generation.

## Additional recommendations

### pi-cache-hit-monitor — strongest addition

Observe reported cache reads/writes, uncached tokens, request gaps, and estimated cache-miss costs. Include compaction usage in aggregates while distinguishing conversational request comparisons.

**Paseo:** a session/cache diagnostics section in the Usage panel, separate from account quotas. Preserve unavailable-data states; normalized zero cache fields are not necessarily proof of a miss. This is retrospective observation, not a prediction of cache warmth or guaranteed savings.

### pi-file-context — optional

Select exact file lines or diff hunks, review them, and attach immutable snapshots to the next prompt.

**Paseo:** a file/diff picker with preview and “Attach to draft,” particularly useful on mobile. Upstream is TUI-only, so substantial UI adaptation is required. Preserve path/symlink boundaries, size limits, provenance, cancellation, and explicit attachment. External terminal-editor behavior need not be copied into the mobile UI.

### pi-analytics — optional

Local, content-free summaries of tool failures/duration, model-call counts, and observed provider reliability across response cycles.

**Paseo:** a read-only analytics view with ranges and clearly labeled metric definitions. Upstream does not provide token/cost reporting, so it complements rather than replaces Usage and Cache monitor. Do not turn local analytics into remote telemetry implicitly.

## Shared integration requirements

- Expose structured state/actions from owning Pi extensions through session-bound bridge services. Keep domain behavior independent of TUI and Paseo rendering.
- Resolve guarded aliases to their actual physical provider/model for accounts, usage, metadata, and model selection. Do not treat `idle-guard` as a billing/authentication provider.
- Verify supported Pi 1.0.0 APIs and actual lifecycle behavior; upstream version ranges and RPC claims are not evidence of compatibility with our combined setup.
- Bind remote operations to the current agent, session, and runtime generation. Cancel or reject stale UI actions and late responses after reload, switch, or reconnect.
- Keep credentials and privileged capabilities out of frontend payloads. Give mutations explicit confirmation and idempotent/uncertain-outcome handling where applicable.
- Preserve ordinary prompt prefixes and avoid injecting display metadata into model context.
- Validate extension coexistence: guard recovery, account changes, foreground helpers, jobs/subagents, permission UI, and existing Fast mode.
- Do not equate a compiled Paseo plugin or RPC test with native iOS usability. Verify controls, streaming, drafts, cancellation, and reconnect behavior on-device.

## Defer or avoid for now

- Other compaction/context-management extensions: overlap with guarded native compaction and introduce additional ownership/lifecycle conflicts.
- Additional subagent/fleet orchestration: overlaps with the existing harness and Paseo task views.
- Configuration-sync extensions: overlap with Nix-managed configuration and introduce another owner for mutable files and potentially credentials.

## Completion criteria per adopted feature

1. Core behavior and relevant settings are tested independently of presentation.
2. Terminal behavior remains usable, including cancellation and reload.
3. Paseo has a functional agent-bound native UI, not just a TUI command placeholder.
4. Tests cover session replacement, reconnect, stale results/actions, and failure paths.
5. Authentication/model-call features have bounded live validation where authorized; simulated and live evidence are clearly distinguished.
6. Native iOS behavior is verified, or the feature is explicitly recorded as incomplete pending device verification.
7. Documentation, licenses, Nix wiring, and shared host-parity checks are updated before publication; deployment remains separately authorized.
