---
description: Show the stored final output for a finished Cursor run in this repository
argument-hint: '[run-id]'
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-bridge.mjs" show '<run-id>'
```

Omit the run id entirely when the user did not give one.


Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Run ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/cursor-cc:runs <id>` and `/cursor-cc:review`
