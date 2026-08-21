# Resolve subagent working directories from the parent Pi context

## Status

Resolved.

## Problem

The sandbox extension forwarded model-supplied relative subagent `cwd` values unchanged. AgentSH therefore resolved them from its mutable session directory, which can differ from Pi's effective local, remote, or retargeted working directory. For parallel requests, the request-level parent directory was also not reflected in relative child paths.

This produced intermittent `subagent cwd must be inside the session workspace` failures or launched children in an unintended directory.

## Resolution

The extension now resolves relative single, parallel, and chained subagent directories from Pi's effective execution target before supervisor-path translation. The tool schema explicitly states that subagent directories must be inside the AgentSH workspace. Behavioral checks cover single and parallel relative paths.
