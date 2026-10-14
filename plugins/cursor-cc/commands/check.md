---
description: Check whether the local Cursor CLI is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-bridge.mjs" check --json
```

If the result says Cursor is unavailable:
- Do not invent an install path. Tell the user to install the Cursor CLI and ensure `cursor-agent` is on PATH (or set `CURSOR_AGENT_BINARY`).
- Then rerun `/cursor-cc:check` after they install it.

If Cursor is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If Cursor is installed but not authenticated, preserve the guidance to authenticate (for example complete login via `cursor-agent login`, then verify with `cursor-agent status`).
