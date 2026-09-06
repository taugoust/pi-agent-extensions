# Background validation blocked behind physical builds

## Status
Resolved.

## Resolution
Commit `42d59fb4973f1c6270eb8b9b20c7bbed73ba4c03` raises native job limits to the user-selected 64 overall and 32 per canonical working directory. Previously four long physical builds filled the directory's four slots and prevented validation launches. This changes admission limits only: no existing jobs are cancelled, restarted, or launched automatically. Adopted panes and infrastructure remain excluded from these slot counts. Worker-count limits are unchanged.
