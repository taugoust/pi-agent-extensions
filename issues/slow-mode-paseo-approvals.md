# Show slow-mode write and edit reviews in Paseo

## Status

In progress.

## Problem

Terminal-attached Pi sessions can be controlled through Paseo, but slow-mode uses a TUI-only custom component for `write` and `edit` reviews. Paseo therefore shows the agent waiting without an actionable approval card.

## Requirements

- Send write content and edit diffs through the attached Paseo approval bridge.
- Preserve the full terminal review UI when Paseo is detached or the user requests terminal review.
- Fail closed if an attached Paseo request fails or is cancelled.
- Do not allow remote approval when the preview was truncated.
