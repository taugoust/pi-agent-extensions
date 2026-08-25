# Network approval choices

Resolved.

Scoped network approval prompts in supervised Pi now present exactly these choices, in order:

1. `Deny`
2. `Allow once`
3. `Allow for session`
4. `Allow all accesses for command`

`Deny` remains a safe one-shot denial. `Allow for session` grants only the requested network destination for the current AgentSH session. `Allow all accesses for command` uses AgentSH's command-run scope, covering subsequent approval requests from the same command invocation without creating a durable session-wide network bypass.

The approval parser now retains the request's default destination scope when AgentSH also advertises command-run scope options. Behavioral sandbox coverage verifies the labels, order, selected scope, and one-shot denial semantics.
