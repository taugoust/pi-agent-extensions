# Show approval prompts in attached Paseo sessions

## Status

Resolved.

## Problem

Terminal-attached Pi sessions rendered `permission-gate` and AgentSH approval prompts only in the TUI. Paseo showed the agent waiting but had no permission card, and the AgentSH UI could incorrectly choose the TUI-only custom component in RPC mode.

## Resolution

Commit `e4b2f5e` routes selectable approval prompts through the compatible Paseo bridge when attached, fails closed if that remote request fails, and retains terminal fallback when no bridge is connected. AgentSH still owns approval IDs and scopes: Paseo returns only a selected label, which the sandbox extension maps back to the original exact resolution before submitting it to AgentSH. Native RPC sessions now use Pi's standard selectable UI rather than the custom TUI overlay.
