---
description: Check whether the local Antigravity CLI (agy) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-bridge.mjs" check --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

The bridge prints the result as a fixed table. Present it to the user as that table:
- Keep the title, every row, and the row order exactly as printed. Do not add rows, drop rows, merge them, or turn the table into a list.
- Write the title, the labels and the descriptive text in the language the user writes in. Keep versions, model ids, paths and commands exactly as printed.
- Keep the line saying bridge runs never use the user's global agy settings, and keep every next step.
- Add nothing else: no extra summary before or after the table.

If the table says agy is not found:
- Do not invent an install path. The next steps already say how to install the Antigravity CLI and put `agy` on PATH (or set `AGY_BINARY`); rerun `/agy-cc:check` after installing.

If agy is installed but not signed in:
- Keep the sign-in steps from the table (run `agy` once in a terminal and complete the Google sign-in, then verify with `agy models`).

If the Bash tool cannot start the command at all, run it once from PowerShell instead (`& node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-bridge.mjs" check --plugin-data "${CLAUDE_PLUGIN_DATA}"`) and present its table the same way.
