# Bun leaves supervised HTTP promises pending after abort

Resolved.

Pi's compiled Bun runtime can close an aborted `node:http` Unix-socket request without emitting a terminal request or response event. The sandbox REST client previously settled only from those transport events. AgentSH therefore cancelled and reaped the command correctly while Pi remained busy forever waiting for the unresolved tool promise; the client's signal-based timeout had the same defect.

The REST JSON and NDJSON request paths now listen to their combined caller/deadline signal directly, settle the guarded Promise with the correctly classified error, and explicitly destroy the request. Terminal cleanup removes both the direct listener and the combined-signal forwarding listener. The sandbox integration check runs under Bun as well as Node so the production runtime behavior is covered.

## Resolution

Fixed in `4c11e45` (`Settle supervised requests directly on abort`).
