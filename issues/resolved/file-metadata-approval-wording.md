# Render file metadata approvals accurately

## Status

Resolved.

## Problem

Pi renders `stat`, `access`, and `readlink` approval requests as content reads. It also prefers AgentSH's normalized `scope_operation=read` over the raw requested operation, producing misleading prompts such as `Read this path outside the opened workspace?` for a nonexistent ancestor `.git` existence probe.

## Desired behavior

- Prefer the raw requested file operation for presentation.
- Render `stat` and `access` as metadata inspection, `readlink` as link-target inspection, and `list` as directory listing.
- Preserve canonical scope operations in resolution payloads.
- Add sandbox UI regression coverage.

## Resolution

Implemented in `00e564a`. Pi now prefers the raw requested file operation for display while preserving canonical scope operations for decisions. Metadata, link-target, and directory-list requests render distinctly from content reads.
