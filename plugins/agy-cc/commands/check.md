---
description: Check whether the local Antigravity CLI (agy) is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-bridge.mjs" check --json
```

If the result says agy is unavailable:
- Do not invent an install path. Tell the user to install the Antigravity CLI and make sure `agy` is on PATH (or set `AGY_BINARY`).
- Then rerun `/agy-cc:check` after they install it.

If agy is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If agy is installed but not signed in, preserve the guidance to sign in (run `agy` once in a terminal and complete the Google sign-in, then verify with `agy models`).
- Keep the line about the plugin's own agy home: bridge runs do not use the user's global agy settings.
