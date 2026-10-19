# Third-party source attribution

The following files were copied/adapted from https://github.com/narumiruna/pi-extensions at reviewed commit `012c08dc` under the MIT license. Original license notices are retained.

- `stamp/{stamp,format,metadata,settings}.ts`, `stamp/{format,metadata}.test.ts`: `packages/pi-stamp/src` and `test`; see `stamp/LICENSE`.
- `progress/{progress-widget,progress-state,settings}.ts`, `progress/settings.test.ts`: `packages/pi-progress/src` and `test`; see `progress/LICENSE`.
- `cache-hit-monitor/{cache-hit-monitor,metrics}.ts`, `cache-hit-monitor/metrics.test.ts`: `packages/pi-cache-hit-monitor/src` and `test`; see `cache-hit-monitor/LICENSE`.
- `shared/terminal-text.ts`: `packages/pi-tui-kit/src/terminal-text.ts`; see `shared/terminal-text.LICENSE`.

Local adaptations provide headless/RPC collection, bounded Paseo snapshots, native settings dialogs/lightweight progress rendering in place of pi-tui-kit, module integration, and tests. Test imports/cleanup were adapted to Bun. Upstream source is not imported at runtime; generated bundles and the toolkit's unrelated dependencies are not included.
