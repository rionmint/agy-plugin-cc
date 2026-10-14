---
description: Stop an active background Cursor run in this repository
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-bridge.mjs" stop '<run-id>'
```

Omit the run id entirely when the user did not give one.

