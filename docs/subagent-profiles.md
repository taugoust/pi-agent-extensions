# Named subagent profiles

Profiles select reusable instructions, a role model/thinking level, and an optional tool allowlist. They use the existing single, parallel and chain backends; they do not introduce another runner or orchestration system.

## Use a profile

```json
{"operation":"profiles"}
{"agent":"scout","task":"Locate the account-switching entry points without editing files","acceptance":["Report exact paths and the relevant control flow"]}
{"agent":"reviewer","task":"Review the current diff","acceptance":["Report concrete findings with file/line evidence, or explicitly report none"],"background":true}
{"tasks":[{"agent":"scout","task":"Inspect the parser","acceptance":["Identify parsing boundaries"]},{"agent":"oracle","task":"Assess the proposed trust policy","acceptance":["Identify material risks and a safe recommendation"]}]}
{"chain":[{"agent":"scout","task":"Locate the implementation seam","acceptance":["Return exact paths"]},{"agent":"reviewer","task":"Review this seam: {previous}","acceptance":["Report correctness and security risks"]}]}
```

`agent` selects a profile. `name` remains an independent tmux/display label; setting `name: "scout"` alone does not select the scout profile. Each task still needs concrete `acceptance`; profile instructions never substitute for it. For groups, select `agent` on each item, not on the root.

| Builtin | Purpose | Business tools | Thinking |
|---|---|---|---|
| `coordinator` | Coordinates a goal and reviews delegated work (model `gpt-6.1-sol`) | runtime defaults | high |
| `scout` | Focused codebase reconnaissance, no edits | read, bash | low |
| `worker` | Narrow implementation and validation | read, bash, edit, write | high |
| `reviewer` | Independent review, no edits | read, bash | high |
| `oracle` | Advisory challenge of decisions and assumptions, no edits | read, bash | high |

Implementers keep the existing subagent role default (`gpt-6-luna`, plain launches use low thinking and `worker` uses high). The named `coordinator` defaults to `gpt-6.1-sol:high`, including dedicated Work → Goals launches through the existing single-child executor. Dedicated Resume retains the recorded model, instructions and tool ceiling instead of rediscovering the profile. Custom coordinator definitions can override the role default; they grant no extra authority. The top-level startup model belongs to Pi settings, not this extension: Astra's physical ID is `gpt-6-astra`. The current idle-guard setup exposes it as `astra`; that is snapshot compatibility, not a requirement to retain that provider or alias during an authorized migration. Configure Astra on the intended owning provider rather than introducing role-specific provider/account routing. Explicit model selections and resumed sessions take precedence over startup defaults. Their instructions are adapted from `nicobailon/pi-subagents` at `3ce6185a`; see `THIRD_PARTY.md` and `subagent/agents/LICENSE`.

## Custom definitions and precedence

Create a Markdown file, for example `~/.pi/agent/agents/security-review.md`:

```markdown
---
name: security-review
description: Focused security review of an assigned change
model: gpt-6-luna
thinking: high
tools:
  - read
  - bash
---
Review the assigned diff for concrete security defects. Do not edit files.
Return findings with evidence and explain any uncertainty.
```

The supported frontmatter fields are exactly `name`, `description`, `model`, `thinking`, and `tools`; the body is the profile instruction text. Name, description and a nonempty body are required. Comma-separated tools and simple YAML block lists are supported. An empty `tools:` means no business tools on native workers; omission preserves the backend's existing defaults. AgentSH's current protocol cannot distinguish an empty list from inherited defaults, so zero-tool profile launches fail before AgentSH dispatch instead of widening access. Unsupported YAML or fields such as skills, extensions, runners, memory, output files and acceptance defaults fail clearly instead of silently acquiring partial semantics.

Lowest to highest priority:

1. Bundled `subagent/agents/*.md`.
2. User `$PI_CODING_AGENT_DIR/agents/**/*.md` (normally `~/.pi/agent/agents`).
3. Trusted project `<parent cwd>/.pi/agents/**/*.md`.

A higher layer replaces a same-named lower-layer definition. Duplicate parsed names within one layer are errors. Names are case-sensitive. `.chain.md` files are not profiles. Discovery is bounded; child symlink directories are not recursively followed, and project definitions may not escape their trusted project through symlinks. Trusted user profile files may be symlinks, including Nix-managed files.

`agentScope` may be `user`, `project`, or `both` (default). `user` includes builtins and user definitions. `project` includes only project definitions and requires Pi's project trust; `both` ignores project definitions when Pi does not trust the project. Trust comes from Pi, never a model-supplied flag. The parent cwd is the discovery anchor even if a task specifies another execution cwd. A group may set a common `agentScope`, with per-item scope overriding it. `operation: "profiles"` accepts only optional `agentScope`.

Definitions are read on new launches and catalogue requests. Plain launches without `agent` do not read profile files, so a broken custom profile does not disable ordinary delegation.

## Overrides, routing and retention

- Explicit launch `model` overrides the profile's model. Otherwise the profile model wins over the existing subagent role default. A `:thinking` suffix wins over profile `thinking`; profile thinking applies when the chosen selector lacks a suffix. Existing configured thinking applies when neither supplies one.
- Provider-qualified legacy selectors remain readable, but provider and selected account always follow the owning session. Profiles cannot switch auth providers, select a different account, route through an unavailable model or silently fall back.
- Explicit `systemPrompt` is appended after the profile's instructions, subject to the existing 64 KiB bound. Runtime authorization/worker policy remains in force.
- Explicit launch `tools` can narrow a profile allowlist, never widen it. This version explicitly selects only the portable native core names `read`, `bash`, `edit`, and `write`; unsupported tools fail before dispatch. It does not load extension or MCP providers. Mandatory internal reporting/control tools remain runtime-owned.
- Resolved model/thinking, instructions, tools, cwd and acceptance flow through the existing backend contract and retained-task storage. Editing a profile affects new launches, not running tasks or resume. Resume accepts only `task_id`, optional `message` and `compact`, not a new `agent` or other launch override.

**A profile is not an OS sandbox or an approval grant.** In particular, Bash remains a shell tool: non-editing roles rely on their instructions plus existing authorization/containment, not on a read-only shell implementation. AgentSH, guarded native limits, and project trust stay authoritative. Profiles do not add skill/extension inheritance, external CLI runners, persistent agent memory, profile management commands or scripted workflows.
