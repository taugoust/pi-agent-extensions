---
name: remindctl
description: Manage Apple Reminders via the remindctl CLI. Use when the user asks to add, list, edit, complete, or delete reminders, or manage reminder lists.
---

# remindctl

Interact with Apple Reminders via the `remindctl` CLI tool.

## Requirements

- macOS 14+ (Sonoma or later) with Reminders permission granted.
- Run `remindctl authorize` once if permission has not been granted yet.
- Check status with `remindctl status`.

## Commands

```bash
# List reminders (default: today)
remindctl                          # today
remindctl today
remindctl tomorrow
remindctl week
remindctl overdue
remindctl upcoming
remindctl completed
remindctl all
remindctl 2026-01-03               # specific date

# Reminder lists
remindctl list                     # show all lists
remindctl list Work                # show reminders in a list
remindctl list Projects --create
remindctl list Work --rename Office
remindctl list Work --delete

# Add a reminder
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting" --list Work --due "2026-01-04 14:00"

# Edit a reminder
remindctl edit <id> --title "New title"
remindctl edit <id> --due 2026-01-04
remindctl edit <id> --list Work

# Complete / delete
remindctl complete <id> [id...]
remindctl delete <id> --force
```

## Output flags

Append to any command:

- `--json` — JSON arrays/objects
- `--plain` — tab-separated lines
- `--quiet` — counts only

## Date formats (for `--due` and date filters)

`today`, `tomorrow`, `yesterday`, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, ISO 8601

## Notes

- IDs shown in listing output (short hex strings like `4A83`) are stable references for edit/complete/delete.
- Use `--json` when you need to parse results programmatically.
