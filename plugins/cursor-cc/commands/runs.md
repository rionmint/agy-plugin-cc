---
description: Show active and recent Cursor runs for this repository
argument-hint: '[run-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Argument handling (security):
- The only argument this command takes is a run id, plus the documented flags.
- A run id is `[A-Za-z0-9._-]` only. If the user text contains anything else — a
  space, a quote, `$`, a backtick, `;`, `|`, `&`, a newline, or `..` — do not run
  the command. Tell the user the run id is invalid and stop.
- Pass the run id as a single-quoted argument so the shell cannot expand it.

Run with the `Bash` tool, substituting the validated run id:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-bridge.mjs" runs '<run-id>' [--wait] [--timeout-ms <ms>] [--all]
```

Omit the run id entirely when the user did not give one.


If the user did not pass a run ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including run ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a run ID:
- Present the full command output to the user.
- Do not summarize or condense it.
