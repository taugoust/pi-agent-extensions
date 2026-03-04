# Project Context for Claude

This is **pi-agent-extensions** — a collection of [pi](https://github.com/mariozechner/pi) coding agent extensions.

## Quick Reference

- **What**: TypeScript extensions for the pi coding agent
- **Where**: `~/.pi/agent/extensions/` (global auto-discovery)
- **How**: Each `.ts` file exports a default function receiving `ExtensionAPI`

## Current Extensions

| File | Description |
|------|-------------|
| `direnv.ts` | Loads direnv environment variables on session start and after bash commands |
| `fetch.ts` | HTTP request tool — fetches URLs, downloads files, shows curl equivalent |
| `questionnaire.ts` | Multi-question tool for LLM-driven user input |
| `slow-mode.ts` | Review gate for write/edit tool calls — toggle with `/slowmode` |

## Before Implementation

1. Follow patterns established in existing extensions (see `direnv.ts`)
2. Update `README.org` when adding new extensions

## Key Patterns

- Always check `ctx.hasUI` before UI calls
- Use status bar for ongoing state, notifications for one-time events
- Serialise concurrent access to shared resources
- Implement timeouts for external processes
- Handle errors gracefully — never throw from event handlers
