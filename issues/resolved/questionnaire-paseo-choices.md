# Make questionnaire choices actionable in Paseo

## Status

Resolved.

## Problem

For terminal-started Pi sessions attached through the Paseo bridge, the questionnaire custom TUI is visible in the terminal stream but Paseo does not expose its options as selectable controls.

## Requirements

- Present each question as a Paseo selection card with its available choices.
- Preserve option values, labels, descriptions, ordering, and multi-question results.
- Offer a handoff to the terminal UI for custom free-text answers.
- Fail closed on cancellation, bridge errors, or unknown response labels.

## Resolution

Commit `639ad66` presents questionnaire options as sequential Paseo selection cards, preserves numbered option identity and descriptions, supports terminal handoff for free-text answers, and fails closed on invalid or interrupted remote responses. Commit `520173a` installs the companion helper through the Home Manager module and adds packaging regression coverage.
