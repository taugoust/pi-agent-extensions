# Idle-aware background-job wait modes require a fail-closed Pi boundary

## Status

Resolved through the user-approved guarded-model alternative. Short/long wait modes were superseded, not implemented; existing job and subagent wait APIs remain unchanged.

## Resolution

Published in `476dd55`. Guarded selection protects continuation requests across both job and subagent waits without core changes or parent restart. Runtime integration tests pass; deployment remains separate.

## Requested behavior

`background_job action=wait` should accept `mode: "short" | "long"` on both native and AgentSH routes. The user explicitly selected **short as the omitted-mode default**.

- Short waits cap the actual requested timeout to the remaining idle budget measured from the persisted last model response, minus a small safety margin. They never compact and never cancel the underlying job.
- Long waits permit the requested timeout. Only when the idle threshold is crossed should cheap compaction occur, after all tool results are saved and before another model request. Fast long waits must not compact.
- Compaction failure or cancellation must pause the run without sending full history to the conversation model. Concurrent sibling tools, queued work, reload, and session changes must remain safe.
- Reuse `idle-context-warning/policy.ts` and its cheap compaction helper/configuration; do not introduce another idle threshold.

## Core blocker

Inspected Pi 1.0.0 installed extension/compaction documentation and local SDK declarations/runtime:

- `dist/core/extensions/types.d.ts`: `BoundaryResult` contains only `entries` and `continue`. There is no stop/pause disposition. `ctx.compact()` is explicitly fire-and-forget.
- `dist/core/agent-session.js`, `_dispatchTurnEndBoundary()` and `_installAgentBoundaryHooks()`: tool results are persisted before the boundary and boundary compaction drafts are possible, but `continue: false` returns no finish-turn decision. It does **not** suppress the normal follow-up after tools.
- `dist/core/extensions/runner.js`, `emitBoundary()`: handler exceptions and invalid drafts are reported, then discarded; they do not stop the run. Throwing is not a fail-closed mechanism.
- `pi-agent-core/dist/agent-loop.js`, `runLoop()` / `streamAssistantResponse()`: after `finishTurn`, an aborted signal does not prevent the next preparation and provider-stream invocation. The stream receives the full transcript and the aborted signal. Relying on provider-specific cancellation behavior is not a core-level guarantee that the expensive continuation never occurs.
- `AgentSession.compact()` begins with `await this.abort()`, which in turn awaits `waitForIdle()`. Awaiting its callback from the active turn boundary can deadlock; starting it without awaiting races continuation. Calling `ctx.compact()` during a tool is not a supported substitute for an explicit atomic pause/compact/continue boundary.

A local zero-network probe exercised the actual agent loop with a tool response, aborted at `finishTurn`, and observed **two provider-stream invocations**. The second invocation had `signal.aborted === true` and still received roles `system,user,assistant,toolResult`. This confirms that abort is not a provider-dispatch barrier.

## Guarded virtual alias investigation (Pi 1.0.0)

A selectable virtual alias can throw locally from `route()` before provider dispatch, including tool continuations and queued inputs. Alone, it is not a complete safe replacement for the missing boundary:

- `AgentSession._installAgentRequestProjection()` resolves the virtual route, then may await `_runAutoCompaction("threshold", false)`. After that await it returns the already-resolved physical model without routing again (`agent-session.js:453–472`). A session can cross the idle threshold during that await; cancellation or failed compaction does not revoke the physical route.
- The precise threshold uses private settings and projected token estimation (`agent-session.js:406–410`), neither exposed as an enforceable extension routing policy.
- Returning a physical-model clone with a disabled/enlarged context window cannot prevent this: `ModelRuntime.resolveModel()` resolves the returned provider/ID back through the physical catalog (`model-runtime.js:744–750`).
- If the alias is absent after reload/resume, selection restoration can use the latest physical response. This behavior is documented in `docs/virtual-models.md` and implemented by `getBranchSelection()`. Simply failing to register a misconfigured alias is not fail-closed.
- A virtual route alone was therefore insufficient. The final implementation below adds a separately registered provider-boundary proxy without replacing existing provider configuration or authentication.

An actual-runtime zero-network probe (`node --test plans/idle-virtual-guard-runtime-probe.mjs`, local ignored evidence) instantiates `createAgentSession`, the real extension runner, registered in-process providers, and the existing native cheap-compaction hook. Both failure and abort cases pass assertions demonstrating the hazard: a warm route is resolved, an awaited hook crosses the idle deadline, native cheap compaction fails/aborts, and the physical provider still receives one cold request (`physical=1`, `cheap=1`, `network=0`). A subsequent fresh route correctly rejects cold input, isolating the gap to the already-resolved route. This is a blocker probe, not full queued-tool/reload/session-switch lifecycle validation.

The implementation now combines the selectable virtual alias with a separately registered `idle-guard-proxy` provider. Its final `streamSimple` gate rejects cold/closed requests locally before delegating to the real model registry, and its payload callback rechecks after authentication/payload awaits. It does not replace existing providers. `guardedModels = { alias = "provider/model"; }` configures selection `idle-guard/alias`; Home Manager installs the helper and mapping. Alias tombstones retain removed names as closed registrations. Error/aborted assistant responses do not reset idle activity.

Recovery runs the existing native cheap-compaction algorithm. Warm automatic/manual compaction preserves the underlying physical model and selected thinking; cold or explicit recovery uses the cheap selector. Both modes persist proof metadata. Warm summary authentication/payload awaits are guarded too: crossing idle cancels before sending rather than silently changing the warm policy. Persisted compaction metadata, session/branch identity and authorization are validated before reopening; failed/cancelled recovery remains closed. `/idle-guard-retry` requests an explicit retry without bypassing the gate. This is an alternative to relying on abort or a virtual route alone; it does not add the requested short/long background-job wait modes.

`node --test idle-context-warning/runtime-integration.mjs` runs 22 bounded tests against real Pi 1.0.0 sessions, extension registration/dispatch, native compaction, queues and file-backed restoration, with in-process physical/cheap providers and networking denied. Coverage includes sibling tools, queued steering/follow-up messages, actual shared quiet-state job/subagent/guidance delivery, failed/aborted summaries, new input, reload/session replacement/switch, removed aliases and first-time malformed targets, persisted-success-only resume, warm physical-model manual/automatic compaction, thinking/credential/header forwarding, and authentication/payload waits crossing idle. Failure latches keep cheap attempts bounded across new inputs until explicit retry. Authentication delay is injected into the real registry's credential-resolution method; this is not a live OAuth login/refresh test. The post-auth HTTP-send barrier depends on the documented provider `onPayload` contract.

## Required capability

For wait modes that work with any directly selected physical model, Pi still needs a supported, enforceable fail-closed disposition at the post-persistence, pre-request boundary (including queued continuations), or an equivalent supported atomic compaction API that pauses on failure. The guarded selectable model supplies a narrower extension-owned dispatch boundary. The guarantee must cover failed/cancelled summaries, boundary validation errors, and sibling tool calls before these modes can be advertised as satisfying the requested contract.

Existing job lifecycle and existing wait behavior are unchanged pending that capability. Short-only delivery would be a separate explicitly approved scope; silently treating long as short or claiming abort guarantees a pause is not acceptable.
