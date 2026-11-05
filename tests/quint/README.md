# Quint differential-testing pilot

This is a bounded model-based test of the **real `NativeTaskStore`** in
`subagent/resume.ts`. Quint generates commands and expected states; the Node
adapter executes those commands against temporary, private on-disk task/session
records and compares the persisted projection after every transition.
No production implementation or live Pi session is changed.

## Development environment

```sh
nix develop .#quint
```

The named shell provides Quint, Node.js, TypeScript and `quint-language-server
--stdio` from this repository's existing locked Nix environment. The shell and
server packaging follow the [Quint flake template](https://github.com/taugoust/flake-templates/tree/ab2a17e339df8107a9da92ef1fca6e087b3a2118/quint),
without adding another flake, lock file or toolchain input. The server is built
from the pinned Quint source release with upstream's locked npm dependencies.
When updating Quint, also review `nix/quint-language-server.nix` for the server
version, standalone-build patch and dependency hash.

Launch an editor from this shell so it can find the language server. The server
does not provide syntax highlighting; editor configuration remains separate.
For optional direnv integration, use `use flake .#quint` in a local `.envrc` and
run `direnv allow`. This repository does not automatically activate the shell.

## Run

```sh
nix build .#checks.x86_64-linux.subagent-quint --no-link -L
```

The check runs the existing resume regression test, typechecks the model,
replays 128 seeded traces of 40 transitions plus a history-boundary trace,
and checks that deliberately broken implementation copies are detected.
Its output contains `report.json` and the three mutation counterexample prefixes.

For a different seed/corpus, or inspectable local artifacts:

```sh
nix develop .#quint --command \
  node tests/quint/run.mjs --seed 0x5eed --traces 128 --steps 40 \
  --out-dir .dev/quint-pilot/my-run
```

Use a new/empty output directory. Reports include the seed, Quint version,
backend, source/trace-state hashes and exercised cases. The TypeScript simulator is selected
explicitly for reproducibility. ITF metadata timestamps are not deterministic;
the decoded command/state sequences are reproducible with the same inputs.

A failing comparison retains the trace prefix through the first mismatch:

```sh
nix develop .#quint --command \
  node tests/quint/run.mjs --replay /path/to/failure.itf.json
```

The separate language-server check exercises stdio initialization, invalid
in-memory edits, diagnostics clearing after loading the real model, document
symbols and clean shutdown, without requiring an editor:

```sh
nix build .#checks.x86_64-linux.quint-language-server --no-link -L
```

Mutation counterexamples intentionally fail only against their matching broken
copy; replay against the unchanged implementation should pass. Prefix retention
is not a general-purpose trace minimizer.

## Contract and limits

The model covers one parent/task, fresh child identities and up to three
attempts. Commands include current/stale completion, resume while running,
two competing resume requests in both arrival orders, exact stop checks,
foreign-owner operations and reconstruction of the store object. It also checks
checkpoint/summary retention and the 32-entry history boundary. Current-child
`finish` can update an already idle attempt; it is **not** modeled as an
idempotent, once-only terminal event.

The adapter compares attempt, child, running/idle state, history, checkpoint and
summary provenance. It additionally checks unchanged session contents/identity,
retained task/tool policy and the public list projection. Mutation qualification
removes the stale-child guard, disables attempt increments and introduces a
history-retention off-by-one error in temporary source copies. Import/I/O errors
do not count as successful mutation detection.

This does **not** model cancellation, worker execution, Goal state, OS-process
crashes, cross-process lock contention, live child-process recovery or cleanup
grace periods. Competing resumes are two requests issued in one JavaScript turn;
the first submitted request acquires the synchronous lock and must win. This
checks both child-identity arrival orders, not second-submitted-request wins or
an independently chosen scheduler outcome. Store reconstruction is not a
simulated process crash. No paid models, network
services, tmux sessions or deployments are exercised.

Simulation plus differential testing is not an exhaustive proof of either the
model or implementation. The corpus must hit the listed cases or the check fails.
