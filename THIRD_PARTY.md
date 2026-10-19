# Third-party source attribution

The following files were copied/adapted from https://github.com/narumiruna/pi-extensions at reviewed commit `012c08dc` under the MIT license. Original license notices are retained.

- `stamp/{stamp,format,metadata,settings}.ts`, `stamp/{format,metadata}.test.ts`: `packages/pi-stamp/src` and `test`; see `stamp/LICENSE`.
- `progress/{progress-widget,progress-state,settings}.ts`, `progress/settings.test.ts`: `packages/pi-progress/src` and `test`; see `progress/LICENSE`.
- `cache-hit-monitor/{cache-hit-monitor,metrics}.ts`, `cache-hit-monitor/metrics.test.ts`: `packages/pi-cache-hit-monitor/src` and `test`; see `cache-hit-monitor/LICENSE`.
- `shared/terminal-text.ts`: `packages/pi-tui-kit/src/terminal-text.ts`; see `shared/terminal-text.LICENSE`.
- `openai-accounts/*.ts` (excluding the replaced account menu): adapted from `narumiruna/pi-extensions` `packages/pi-accounts/src` at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c` for OpenAI-only phase 2; see `openai-accounts/LICENSE`. `PI_ACCOUNT` selection and Codex legacy import are disabled; unused account menu and full upstream README are omitted.
- `openai-accounts/node_modules/proper-lockfile`, `graceful-fs`, nested `retry`, and `signal-exit`: runtime source vendored to make Nix-installed extension loading independent of Pi's private dependency tree. Versions: proper-lockfile 4.1.2, graceful-fs 4.2.11, retry 0.12.0 (nested), signal-exit 3.0.7. Each package's original license file is retained.

Local adaptations provide headless/RPC collection, bounded Paseo snapshots, native settings dialogs/lightweight progress rendering in place of pi-tui-kit, module integration, and tests. Test imports/cleanup were adapted to Bun. Upstream source is not imported at runtime; generated bundles and the toolkit's unrelated dependencies are not included.
