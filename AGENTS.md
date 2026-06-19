# Project Context for Claude

This is **pi-agent-extensions** — a collection of [pi](https://github.com/mariozechner/pi) coding agent extensions.

## Quick Reference

- **What**: TypeScript extensions for the pi coding agent
- **Where**: `~/.pi/agent/extensions/` (global auto-discovery)
- **How**: Each `.ts` file exports a default function receiving `ExtensionAPI`

## Current Extensions

| File | Description |
|------|-------------|
| `fetch/` | HTTP request tool — fetches URLs, downloads files, shows curl equivalent |
| `questionnaire/` | Multi-question tool for LLM-driven user input |
| `sandbox/` | AgentSH approval relay UI — prompts for AgentSH-owned pending approvals |
| `slow-mode/` | Review gate for write/edit tool calls — toggle with `/slowmode` |

## Before Implementation

1. Follow patterns established in existing extensions (see `direnv.ts`)
2. Update `README.md` when adding new extensions

## Key Patterns

- Always check `ctx.hasUI` before UI calls
- Use status bar for ongoing state, notifications for one-time events
- Serialise concurrent access to shared resources
- Implement timeouts for external processes
- Handle errors gracefully — never throw from event handlers
