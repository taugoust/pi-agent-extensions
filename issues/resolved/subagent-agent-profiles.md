# Reusable subagent profiles

## Status

Resolved. Related tasks: [verified acceptance](subagent-runtime-verified-acceptance.md) and [scripted orchestration](../subagent-scripted-orchestration.md).

## Resolution

Implemented in `6c00d4f`: named `agent` selection and scoped catalogue discovery, four adapted builtins, strict Markdown validation, trusted-project precedence, narrowing-only portable tool selections, and expanded retained launch contracts. Existing single/parallel/chain launches and AgentSH adapters share profile resolution; no new scripted runner or Paseo interface was imported. See [profile documentation](../../docs/subagent-profiles.md).

Evidence: 19 deterministic parser/resolution tests, the full 90-test native subagent suite, sandbox/gateway tests, and the dedicated offline native profile check passed. Actual Pi parent/child requests verify model/thinking/tools/instructions, provider rebinding, retained resume after file edits, launch forms and exact rejection boundaries; an isolated mock verifies AgentSH adapter field stripping. Required acceptance remains mandatory. Unsupported skills/extensions/runners fail closed rather than acquiring partial semantics.

## Outcome

Adapt reusable named agent profiles directly from `candidates/pi-subagents`, allowing callers and scripted workflows to select a role with reusable instructions, model/thinking configuration and tool restrictions while retaining our existing workers and authorization boundaries. No Paseo changes in this scope.

## Upstream reference

- Repository: https://github.com/nicobailon/pi-subagents, reviewed snapshot `3ce6185a`.
- Reuse/adapt applicable code from `src/agents/agents.ts`, `frontmatter.ts`, `agent-selection.ts`, `agent-scope.ts` and relevant parsing/discovery/selection tests.
- Reference `docs/agents.md` and the bundled `agents/*.md` profiles. Adapt useful native roles such as scout, worker, reviewer and oracle rather than inventing unrelated definitions.
- Preserve upstream license notices and attribution; record copied/adapted provenance in `THIRD_PARTY.md`.

## Requirements

- Support Markdown/frontmatter profiles with a name/description, role instructions, model/thinking selection and explicit tool allowlists. Define and document deterministic built-in/user/project precedence and explicit per-launch override behavior; errors and name collisions must not silently choose a different agent.
- Adapt profile discovery, parsing and selection directly from upstream, without importing its execution backend or broader agent-management framework.
- Resolve profile configuration into our existing single/parallel/chain launch and scripted-workflow contracts. Persist the effective configuration with retained tasks; resume must not silently adopt an edited profile's new model, instructions or authority.
- Keep independent provider/account selection intact; do not copy implicit cross-provider model fallback. Preserve our exact provider/model selectors and fail clearly for unavailable models.
- Tool selection and any loaded resources must honor existing AgentSH/guarded-native restrictions and project trust. A profile is configuration, not permission to expand authority. Do not blindly adopt upstream ambient extension inheritance or treat tool allowlists as filesystem/process isolation.
- Skills/extension configuration, if retained from upstream, must have explicitly supported semantics and fail closed when unavailable; do not advertise unsupported fields.
- Preserve mandatory per-task acceptance criteria. A reusable role does not replace the concrete assignment or its verification contract.
- No external CLI runner adapters, persistent agent memory, automatic profile refinement, delegation budgets, missions, schedules, watchdogs, or Paseo work in this task.

## Acceptance evidence required

- Offline deterministic tests cover discovery/precedence, malformed frontmatter, duplicate names, model/thinking/tool resolution, instruction assembly, trust/permission failures, effective-contract retention on resume and workflow profile selection.
- Native execution tests verify the resolved profile actually controls the child model/tools/instructions without changing worker lifecycle or bypassing authorization. Do not use live providers or real credentials.
