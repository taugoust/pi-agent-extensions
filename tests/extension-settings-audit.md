# Defaults/snapshot/native seeding test audit

Scope: `shared/extension-defaults.ts`,
`shared/snapshot-extension-settings.mjs`, `nix/merge-native-defaults.py`.

## Existing coverage (before this change)

- No dedicated tests invoked any of these three modules. Existing consumer tests
  could indirectly load shared defaults, but did not configure an isolated
  defaults root or establish defaults/snapshot/security contracts.
- `progress/settings.test.ts` is genuine behavioral coverage: production
  normalization, flat-vs-nested field precedence, read-only loading, invalid
  inputs, missing files, and filesystem non-effects. It is not a snapshot or
  native activation test. `stamp/format.test.ts` and `stamp/metadata.test.ts`
  similarly exercise formatting/metadata, not defaults transport.
- `nix/idle-context-warning-check.nix` checks evaluated generated JSON and file
  wiring, not production JSON reads. Its harness is stale: running
  `nix build .#checks.x86_64-linux.idle-context-warning --no-link -L` fails during
  evaluation because its minimal `lib.evalModules` harness does not declare the
  `assertions` option now used by `module.nix`. Its expected config filename also
  still uses `extensions/idle-context-warning.json`, not the defaults path.
- `nix/observability-check.nix` evaluates module wiring and tests source file
  existence; that cannot prove defaults precedence, validation or safe copying.
- `nix/subagent-check.nix` mixes real runtime tests with source-shape assertions
  (e.g. `grep -A12 'const currentResult: SingleResult'` and exact-string greps
  near its end). Those can detect source changes but cannot establish snapshot
  filesystem effects. Some older harnesses, including `nix/checks.nix`, construct
  SDK stubs under `@mariozechner/pi-coding-agent`; the shared defaults production
  module imports `@earendil-works/pi-coding-agent`. Such stubs alone are not
  evidence that this new production dependency executes successfully.

The initial focused change did not rewrite wider checks. The follow-up below
repairs the three stale module checks rather than hiding their failures.

## New behavioral coverage

Run:

```sh
nix build .#checks.x86_64-linux.extension-settings --no-link -L
```

The check is also exposed for every flake-supported system. It requires only
Nix-pinned Node, TypeScript, Python and coreutils, uses a temporary HOME and
fixtures, and performs no account/provider/network/service/deployment activity.

- `extension-settings.mjs` imports the production snapshot implementation and
  compiled, otherwise unchanged defaults TypeScript. The only SDK seam supplies
  `getAgentDir()` from a test-controlled variable; no settings logic is stubbed.
- Tests prove recursive precedence and input non-mutation; array/null/scalar
  replacement; reserved merge-key rejection; section defaults/validator handoff;
  missing documents and invalid canonical names; all manifest-approved paths;
  empty-object preservation; allowed Nix-style source links; exclusion of
  credential/account/control/session/global-settings/unapproved paths; private
  files/new directories; missing/empty source cleanup without cwd fallback;
  same-directory/alias no-op; malformed/scalar/array/null/non-UTF-8/oversize/
  directory/FIFO rejection with destination non-effects; exact size boundaries;
  destination writable-directory and symlink-parent rejection; file-symlink
  replacement/unlink without following; and nonrecursive cleanup refusal.
- The older defaults-only copier is separately exercised for supported-file
  copying, stale cleanup, private files and preference/credential exclusion.
- `nix/extension-settings-module-tests.nix` evaluates the actual Nix module
  against a small Home Manager option scaffold. It asserts null native config
  emits neither native nor defaults artifacts, `{}` opts in, package declarations
  deduplicate, raw extension settings recursively override named settings,
  sandbox installs subagent/finalizer/shared dependencies and Node/tmux, and
  invalid subagent/Fast Mode settings yield false assertions. Every assertion
  boolean is forced with `deepSeq`; this is module-unit coverage, not host parity.
- `native-defaults.py` launches the actual production activation script. It proves
  seed-once behavior, complete/private JSON publication, existing malformed files,
  directories and live/dangling symlinks winning unchanged, empty/missing/invalid
  sources, unrelated auth-file preservation, concurrent competing seeders, and
  temporary-file cleanup. A deterministic scheduling seam inserts a native writer
  at the actual `os.link` publication syscall, proving that the race after the
  existence check does not overwrite its winner.

## Follow-up: executable wiring and real dependency behavior

- `module-test-harness.nix` is shared by extension settings, idle-warning,
  observability and accounts module contracts. It forces actual module
  assertions and exercises a non-default canonical agent directory, disabled
  nonownership, named/raw precedence, immutable helper closure, and absence of
  credential declarations. This is still an option scaffold; real-host parity
  remains a separate consumer check.
- Observability invokes `progress-settings-check.nix`. The Progress tests execute
  production settings readers/writers with the release's actual SDK
  `withFileMutationQueue`, not a replacement scheduler. Only the agent-root
  locator is controlled. Concurrent saves preserve independent explicit edits;
  saving cannot copy inherited defaults into mutable preferences. The latter
  regression is deliberately mutated and must fail its named assertion.
- Account and workflows immutable-load checks now query the actual standalone
  Pi RPC process and require their extension commands to be registered. A normal
  CLI exit or source-file presence is no longer sufficient. A missing-command
  negative control must fail specifically at registration. These are offline
  package-load tests, not account login/quota or full Goal UI tests.

## Mutation-sensitivity evidence

`extension-settings-mutations.py` runs inside the same hermetic check. It copies
source/tests into disposable temporary directories, mutates only those copies,
and requires failure of the specifically named behavioral test (not merely a
nonzero process exit). Both mutants were killed:

1. Replace native `if path.exists(): continue` with `if path.exists(): path.unlink()`:
   `test_seed_once_private_complete_files_without_unrelated_changes` fails when
   existing user settings are replaced.
2. Add deletion of destination `auth.json` to snapshot missing-source cleanup:
   `empty source cleans only approved stale files, never cwd or unrelated files`
   fails because unrelated data disappeared.

The unmutated focused check passed 18 Node tests, five Python tests, module-output
assertions, and both expected mutation failures using
`nix build .#checks.x86_64-linux.extension-settings --no-link -L`.

## Limits and result

This is not full consumer schema/UI/backend integration, a typecheck, or a claim
of protection against a malicious same-UID process changing directories between
path checks. Native defaults are the trusted JSON map generated by the Nix module,
not a second manifest-based snapshot reader. Path allowlisting prevents copying
unapproved files; it is not credential redaction of arbitrary approved JSON
contents. Owner-mismatch rejection is not tested by privileged user switching.

The new behavioral cases found no production defect requiring a runtime change.
No real credentials, providers, services, deployments or reloads were used.
