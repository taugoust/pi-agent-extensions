# Background-job schema stays stale after Nix activation and Pi reload

## Resolution

Use explicit `.ts` imports throughout the background-job TypeScript dependency graph, including shared/watch-menu.ts. The compiled Node test build uses TypeScript's `--rewriteRelativeImportExtensions` so emitted imports still target `.js` files.

Pi 0.85.0's extension loader reproduced stale resolution of relative `.js` specifiers to TypeScript source after installed symlinks changed. Both terminal `/reload` and bridge `/remote-reload` could report success while `background_job` still registered a 30000ms maximum. The same reproduction with explicit `.ts` specifiers refreshed the schema correctly, without restarting Pi. This is not evidence that all extension reload caches are broken.

## Regression

`background-job/reload.test.py` launches real Pi in RPC mode without model calls, loads the actual background-job extension and an old shared schema, swaps installation symlinks, reloads, and asserts that the registered maximum changes from 30000 to 43200000 in the same process. It runs in the Pi-enabled subagent Nix check. Existing background-job tests cover long-wait cancellation and early completion.

## Live temporary recovery

With explicit user authorization, Rose's three idle children and Eliza's idle session were reloaded from host-local copies with corrected imports. Registered maxima were verified as 43200000 with unchanged process IDs; no jobs were cancelled or reaped by the recovery.

Temporary directories (each contains rollback.json):
- Rose: `/scratch/theo/pi-reload-recovery-86l_udfd`
- Eliza: `/scratch/theo/pi-reload-recovery-kkj8qde0`

Only each host's background-job extension link was redirected. These overrides remain in place pending deployment of the permanent fix. Do not delete their source directories while installed links or active processes may depend on them. Deployment and cleanup require separate authorization; publishing the fix does not remove the overrides.
