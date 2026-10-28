# Offline idle-admission contracts

Node integration suites require **stock Pi 1.4.0 and Node 24.21.0**. They register only synthetic providers, isolate all settings/session/auth roots, disable catalog networking/cache warming, and forbid fetch. They make no paid requests and do not open/mutate live sessions. Synthetic summaries exercise the public native compaction algorithm, not a real provider.

Resolve the stock SDK and matching `pi-ai` dependency through Nix-managed packages, never global package installation. The checkout fixture maps local `.js` imports to `.ts` and supplies JSON import attributes; production remains loaded by Pi's extension loader.

```sh
agent_dir=$(mktemp -d)
trap 'rm -rf "$agent_dir"' EXIT

env -u PI_SESSION_ROUTING_FILE -u PI_SESSION_ROUTING_OWNER_SESSION -u PI_PROVIDER \
  PI_CODING_AGENT_DIR="$agent_dir" bun test idle-context-warning shared/quiet-state.test.ts

env -u PI_SESSION_ROUTING_FILE -u PI_SESSION_ROUTING_OWNER_SESSION -u PI_PROVIDER \
  PI_CODING_AGENT_DIR="$agent_dir" node --test \
  idle-context-warning/runtime-integration.mjs idle-context-warning/stock-contract.mjs
```

Coverage includes consumed user submissions, explicit root decisions, parent decisions, no-channel pending state, cancelled/stale IDs, native summary receipts/selection preservation, durable reload recovery, busy notification queues, deduplication and direct-result consumption, separate parent idle-decision control delivery, legacy model/account selection migration and pure settings planning. Existing quiet-state regressions cover completion freshness, disable/quota, parallel producer ownership, persistence failure and reload receipts.

`stock-contract.mjs` deliberately verifies **negative** public-API contracts: throwing `before_provider_request` does not veto dispatch; a cancel-shaped hook result replaces payload rather than cancelling it. Fake-send counters are not billing evidence. No suite claims prevention of every internal follow-up, retry, nested/direct call, queue delay or cache-warming request.
