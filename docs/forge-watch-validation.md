# Forge watch qualification — in progress

This is an evidence ledger, **not full delivery or approval of the GitHub+GitLab Goal**. GitLab MR polling and revision-bound approval remain unimplemented/fail-closed until human OAuth login and live server qualification. No producer PR, consumer MR, host deployment, or final human approval is claimed here.

## Evidence boundaries

| Area | Observed evidence | Scope / remaining qualification |
| --- | --- | --- |
| Standalone public client | `@earendil-works/pi-mcp` 1.4.0 is declared/pinned in package manifests and the nested npm lock; Nix builds its own dependency tree. | No host-layout imports, finished tool contexts, model APIs, or Pi repository changes are needed. |
| Protocol, auth and storage fixtures | Parent ran 39 passing Node tests across `adapters.test.mjs`, `mcp.test.mjs`, `oauth.test.mjs`, `storage.test.ts`, and the strict-Node detached-rejection regression/negative control. | Real public MCP/OAuth client with in-memory/fixture networking. These are **not** live GitLab reads. |
| Idle inference and routing | Parent ran five passing real `AgentSession` tests in `tests/forge-watch-runtime.mjs`: unchanged polls, current-session wake, durable checker restoration, watcher-first initialization, same-activation receipt recovery with newer queued events, and two-session isolation. | Offline scripted provider counts actual model requests. Eleven unchanged polls caused no new inference; a relevant event admitted one batch. No provider HTTP. |
| Pre-completion guards | Parent's Nix gate passed seven bridge regressions and five real-session cases. Independent source re-review also verified branch/crash/cancellation/budget reproductions and 101 passing source tests after `98b81ec`. | Passing checklist state is never approval evidence; live GitLab approval remains a separate requirement. |
| Polling engine | Parent and Nix ran 26 passing controlled-clock tests / 97 assertions covering shared polling, retry/backoff, rate limits, overflow, acknowledgement interleavings, write faults, bounded stop, and recorded/absent/unknown foreign-claim recovery. | Claims and accepted receipts are distinct. Actual Goal custom-message tokens reconcile accepted delivery after a separate receipt write was lost; unknown claims stay fail-closed. |
| Native immutable loading | Parent built `/nix/store/66dqx9valbhnf682kpgg1d6nnfn0jszf-pi-forge-watch-extensions` and loaded it in the installed raw Pi without `PI_CODING_AGENT_ENTRY` or a developer dependency tree. | Registered `forge-watch`, `goal`, and `worktree`; idle/offline with no model turn. This is package-loading evidence, not approval of a final revision. |
| Nix settings | `checks.x86_64-linux.extension-settings` passed. | Consumer host-parity with a local producer override was separately worker-reported; the final published input pin is still pending. |
| Nix protocol/storage/SDK/native gate | Passed on code candidate `74fcbba4b5b2c0e94357e4031ac71b07a01989d9` with code paths clean and documentation-only edits: 26 engine, 21 protocol/adapter/storage/error-path, 7 bridge, 5 real-session tests and native immutable registration. Output: `/nix/store/g8gvjk8ymgxvq73iajpjrwp0vk2cvj6r-pi-forge-watch-check-1.4.0`. | OAuth real-filesystem security/refresh is a separate mandatory host gate, not a skip/xfail or part of green Nix coverage. Exact frozen publication-head gates are retained with the review artifacts; future GitLab implementation still requires requalification and review. |

Representative local commands (the SDK argument is the public installed package directory):

```sh
node --experimental-transform-types --test \
  forge-watch/storage.test.ts forge-watch/adapters.test.mjs \
  forge-watch/mcp.test.mjs forge-watch/oauth.test.mjs
nix shell nixpkgs#bun --command bun test forge-watch/engine.test.ts
node tests/forge-watch-runtime.mjs "$SDK"
node tests/forge-goal-runtime.mjs "$SDK"
nix build --no-link 'path:.#checks.x86_64-linux.forge-watch'
nix build --no-link 'path:.#packages.x86_64-linux.forge-watch'
```

The checks use disposable state/settings/credentials and do not deploy hosts or restart existing sessions. Native Pi installs only `bin`/`libexec`; the Nix test therefore uses the real SDK in its build tree and separately loads the immutable bundle into the installed native process. It does not pretend an SDK exists in the native output.

## Live GitHub MCP reads

Endpoint: `https://api.githubcopilot.com/mcp/readonly`, with the existing explicitly authorized `gh auth token` credential source. The watcher additionally enforces its own read-tool/method allowlist; endpoint naming alone is not write prevention. No approval, merge, comment, or review mutation was performed.

The live `pull_request_read` schema requires `method`, `owner`, `repo`, and `pullNumber`. Ordinary paginated methods use `page` / `perPage` (maximum 100). `get_review_comments` uses `after` cursors and returns `review_threads`, `totalCount`, and `pageInfo`.

| Public sample | Live result | Meaning |
| --- | --- | --- |
| `earendil-works/pi#11910` | Initial schema and response-shape probe of `get`, comments, review threads, reviews, status, and check runs. | Empty review threads are not evidence for the nonempty nested shape. |
| `earendil-works/pi#11885` | Production adapter read head `5bf9b431c14369ad04fe5503037c2db368a7697a`, closed state, 1 review and 11 CI items. Production checker observed reviewer `petrroll` approving that exact head, review ID `5804298857`, with stable re-reads. | A real positive read-only checker example. **Not** approval of this Goal, its code, or reviewer `taugoust`. |
| `github/github-mcp-server#3665` | Production adapter read head `801562ed83cdcebe00c308fa08001d965961c1c5`, 1 comment, 3 reviews, and 22 CI items. Checker returned `UNKNOWN` for an incomplete/invalid review record. | Fail-closed result, not approval. |
| `github/github-mcp-server#3629` | Live nonempty thread response: 9 threads, cursor pagination, per-thread `id`, flags, `comments`, and `total_count`. Comments omit an ID and expose a permalink. After correction `6c83300`, parent production-adapter recheck read head `573c8ab9bafdd84e907870cbf2f6a41badbf0949`, 20 normalized comment/thread-state items, 9 reviews and 21 CI items. | The initial missing-ID defect is corrected using validated permalink identities and complete nested counts, not body hashes. Checker still returns `UNKNOWN` for an invalid review record; no Goal approval is implied. |

The initial sanitized schema artifact is retained in the reconnaissance worktree under ignored `plans/github-mcp-pr-probe.txt`, SHA-256 `a813c16f06f111c3cd0e33cffb96b9d9978e1f6176cf2a0485c5b2bb6e9bfebe`. Later production-adapter probes are authored in the integration worktree's ignored `plans/github-adapter-live.mjs`; output logs are separately retained by supervised jobs. Credentials and private token responses are not committed.

## GitLab OAuth and live-read dependency

- `https://gitlab.com/api/v4/mcp/` rejected the existing `glab` bearer token with HTTP 401. REST access does not imply MCP authorization.
- Protected-resource metadata advertises the separate `mcp` scope, authorization-code flow, PKCE S256, and dynamic registration.
- Explicit bootstrap successfully performed discovery, registration, and authorization-URL generation. Human consent/code was **not received**: the questionnaire timed out. Token exchange, real refresh, authenticated MCP tool schemas, and MR reads remain unverified.
- No login is initiated by idle polling. An expired or absent grant is a visible auth-required failure, not a background browser flow or model wake.
- Revision binding cannot be inferred from an `approved_by` flag. The eventual GitLab checker must prove current-revision human evidence or return `UNKNOWN`; any explicit revision-attestation protocol requires review rather than being silently substituted.

When the human is ready, generate a fresh short-lived URL (the earlier one expires) and complete the flow through stdin:

```sh
node forge-watch/auth.mjs begin --agent-dir "$PI_CODING_AGENT_DIR"
node forge-watch/auth.mjs complete --agent-dir "$PI_CODING_AGENT_DIR"
```

`complete` reads the full loopback redirect URL/code from stdin, not command-line arguments. A browser running elsewhere may display a localhost connection error after consent; the complete redirect URL still contains the data required for manual completion. Never paste an access token or password. Normal installed bundles include the public OAuth dependency; the optional explicit SDK-entry override is only a bootstrap/test fallback.

## Independent review and corrections

Independent review reproduced six issues rather than treating fixture success as full verification:

1. Branch navigation could miss a selected branch's durable guard marker.
2. Parent completion could accept cached empty guard metadata after a child crash.
3. Watcher-first initialization could delete retained subscriptions before Goal restoration.
4. Stop between a delivery claim and send could preserve an unsent claim as a final receipt.
5. A legitimate authenticated budget-wrap-up completion was rejected.
6. Cancellation while a fresh check was pending could still commit completion.

Corrections are in `98b81ec`, `8796b82`, and the integration's readiness/lifecycle changes. Independent re-review verified that all six original reproductions are resolved. It then found acknowledgement interleaving and acceptance-receipt persistence failures; receipt corrections are in `c94718d`, `33c16b8`, and `8e0d688`, with passing regressions for bounded shutdown and same-activation restart reconciliation. Independent re-review confirmed those fixes. A subsequent detached rejection during a failed delivery plus failed rollback was corrected in `74fcbba`; a strict Node subprocess survives the production path, while a mutation removing the handler fails specifically with the original rollback error. Independent re-review of `74fcbba` reported no remaining consequential finding in that correction. This is partial generic/GitHub review acceptance, not full GitLab qualification. This ledger does not substitute worker reports for acceptance. A saved parent-side completion with a required child guard fails closed and requires resuming the exact child to restore a fresh checker.

Nix qualification also caught test/packaging defects: assuming an installed Node SDK in the native release, copying an ignored developer `node_modules` symlink into a bundle, and pointing the SDK fixture at a narrow bundle lacking its fixture-only Progress imports. These were corrected without private host discovery; the SDK fixture uses copied immutable producer fixture dependencies with the packaged watcher.

The exact OAuth file-security suite cannot run against this Nix UID namespace: a diagnostic observed process UID `1000`, `/build` owned by UID `1000` with mode `0700`, but filesystem `/` owned by unmapped UID `65534` with mode `0750`. Production ancestor ownership checks correctly reject that root. Making TMP private did not and cannot fix the unmapped root. Production ownership/mode checks are preserved unchanged. The authenticated parent approved a transparent split of this new validation gate: Nix runs protocol/storage/SDK/native checks; the identical real-filesystem OAuth security/refresh suite remains a separate mandatory host release check. There is no silent skip, xfail, metadata spoofing or production bypass.

## Mandatory release commands

Both gates must pass for the same code candidate, with source revision (and any dirty-state qualification) recorded:

```sh
# Nix sandbox: engine, MCP protocol/adapter, storage, real SDK and native package load.
nix build --no-link -L 'path:.#checks.x86_64-linux.forge-watch'

# Actual host filesystem with declared public dependency installed: all OAuth
# ownership/mode/symlink/endpoint/refresh/concurrency/loopback tests, unchanged.
node --test forge-watch/oauth.test.mjs
```

Parent ran the host command with `PI_CODING_AGENT_ENTRY` unset: **18/18 passed**, on clean code candidate `74fcbba4b5b2c0e94357e4031ac71b07a01989d9` with code paths clean before subsequent documentation-only updates. Exact `auth.mjs` SHA-256: `9e4b188cb19ab6881ab816d02ade40107a773fd886184e980329188d8b22ba38`. This is recorded source evidence, not final-release revision approval.

A green Nix result is **not** OAuth filesystem-security coverage. The host suite's success is **not** live GitLab token exchange, authenticated MR reads, or human approval evidence. The remaining live and release requirements below stay in force.

## Consumer preparation

Consumer topic commit `beea412` (`Configure Pi forge watcher defaults`) changes only `home/programs/pi/default.nix`. The worker reported current-local-producer host-parity/package build, configuration evaluation, formatting and whitespace checks passing. It contains credential references, not secrets. This records the preparation step only; it did not include a push, final producer input pin or consumer MR. Later Draft publication/pin/MR states belong to the remote review artifacts, not an inferred delivery claim from this preparation record.

## Remaining delivery requirements

GitLab live qualification and implementation, final full-feature independent acceptance and requalification, complete-feature producer publication/review, the authorized `nix-config` pin and consumer MR, and explicit human approval of the final current reviewable revision remain required. Preserve unfinished/unmerged topic worktrees. No force push or deployment is authorized by publication.
