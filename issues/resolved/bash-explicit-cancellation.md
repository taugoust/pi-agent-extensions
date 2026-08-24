# Bash explicit cancellation

Resolved.

The supervised Bash tool previously cancelled only its buffered HTTP request. Although AgentSH binds command execution to the request context, relying exclusively on socket teardown made cancellation vulnerable to delayed or lost disconnect propagation and gave no exact retryable cancellation identity.

Every Bash dispatch now carries a random canonical request UUID. When Pi aborts the tool, or the buffered transport reaches its terminal deadline, the extension sends a separate bounded request to AgentSH's exact-command cancellation endpoint before reporting the abort. AgentSH cancellation remains idempotent, and the original HTTP abort still provides an immediate independent cancellation path.

The sandbox integration check proves that the UUID sent with `exec_bash` is the one targeted by the cancellation request.
