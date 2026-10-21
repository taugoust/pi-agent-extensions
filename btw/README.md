# BTW side conversations

Terminal and Paseo side conversations adapted from `narumiruna/pi-extensions`' MIT-licensed `pi-btw` 0.61.2 at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c`. Original notices are retained in `LICENSE`; bundled terminal dependencies have notices in `terminal-licenses/`.

## Pi terminal

- `/btw` opens the candidate manager: choose context, start or resume a side thread, or adjust settings.
- `/btw <question>` opens a side conversation immediately.
- The candidate UI includes follow-ups, transcript search, queued steering, fullscreen/left/right pane layouts, a branch-context picker, and explicit bring-to-main controls.
- Bring-to-main fills the main editor without sending. Replacing an existing draft requires confirmation.
- Ctrl+C cancels generation and leaves the side workspace; completed exchanges remain resumable in memory. Session replacement, reload and exit discard terminal threads.

The terminal UI keeps the candidate's settings in `$PI_CODING_AGENT_DIR/pi-btw.json` (normally `~/.pi/agent/pi-btw.json`). By default it uses the main session's model and thinking level. Change these through `/btw` → Settings. This is independent of Paseo's configured cheap model and its `btw.json`. Context is sent to the selected side model's provider.

The terminal runtime is loaded only on first TUI use. It uses Pi's public UI and model-registry APIs; Pi's own SDK packages are not bundled. Only one terminal BTW command can own the UI at a time. Non-TUI clients retain the existing Paseo command path rather than trying to render terminal components.

## Paseo

The **btw** composer chat remains a separate, compact UI with its existing private service. It uses recent main context and the configured default side model, supports follow-ups and copying, and can stop an active answer. Dismissing the chat discards its local state and requests cancellation/removal of its owned server thread. Terminal and Paseo threads are not synchronized.

The Nix `programs.pi.extensions.btw.model` default derives from the subagent provider/model; standalone default is `openai/gpt-6-luna`. Paseo thinking is low, output is limited to 4096 tokens, and requests have a three-minute cancellation deadline. Unavailable models fail without fallback. The guarded main-model alias is excluded from this service. Pi's request-time model registry handles authentication, including the selected session's OpenAI account; credentials are not exposed in snapshots.

## Boundaries

Side questions do not add main conversation messages, change its model/thinking, compact it, or run tools. Terminal bring-to-main is an explicit draft action; Paseo uses explicit clipboard copying. Main context is bounded to the latest 40,000 formatted characters with a truncation notice. Threads are memory-only. Paseo mutations remain bound to session/runtime/service identity and unique request IDs, with no automatic replay after uncertain delivery.

## Rebuilding the terminal runtime

Authoritative adapted terminal sources are in `candidate/`, with `candidate-entry.ts` as the bundle entry. `nix/btw-terminal.nix` produces `candidate-runtime.ts` and dependency notices using Nix's esbuild and hash-pinned package archives. It performs no npm installation and runs no tests or typecheck suites.

From the repository root:

```sh
nix build --impure --expr 'let f = builtins.getFlake (toString ./.); pkgs = import f.inputs.nixpkgs { system = builtins.currentSystem; }; in import ./nix/btw-terminal.nix { inherit pkgs; }' --out-link plans/btw-runtime-result
cp -f plans/btw-runtime-result/candidate-runtime.ts btw/candidate-runtime.ts
chmod u+w btw/candidate-runtime.ts
mkdir -p btw/terminal-licenses
cp -f plans/btw-runtime-result/licenses/* btw/terminal-licenses/
```

The generated runtime is shipped so ordinary Pi and Nix extension loading does not require access to the candidates checkout or npm dependencies. The kit's opaque `createRequire` highlighter lookup is made static during bundling so the dependency is included, not resolved from Pi's private dependency tree.

## Review status

No tests, smoke scripts or check suites are being run for this review batch, per user instruction. Production bundling/deployment is distinct from user confirmation of terminal interaction and live provider behavior.
