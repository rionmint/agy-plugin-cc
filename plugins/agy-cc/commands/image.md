---
description: Generate an image with agy's built-in image generator and save it to a file
argument-hint: '[--wait|--background] [--out <path>] [--aspect <w:h>] [--ref <image>] [--model <model>] [--timeout <dur>] <what to draw>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Generate an image through the plugin bridge. agy draws it with its built-in image generator (no API key), and the bridge copies the result out of agy's conversation folder into a file.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Your only job is to run the bridge and return its output verbatim.
- Do not draw, describe, or substitute an image yourself if the run fails.

Execution mode rules:
- One image took between one and five minutes in measurements. If the raw arguments include `--wait`, run in the foreground. Otherwise run in the background without asking.

Argument handling:
- Preserve the user's arguments exactly.
- `--out <path>` is where the image goes (a file or an existing directory). Without it the image is saved in the current directory as `agy-image-<timestamp>.jpg`. The extension follows the actual image type (agy draws JPEG), and an existing file is never overwritten.
- `--aspect` takes a ratio such as `1:1` or `16:9`.
- `--ref <image>` passes a reference image for editing; it may repeat.
- Leave `--model` and `--timeout` unset unless the user asks for them.

Argument handling (security):
- The forwarded argument string goes onto a shell command line. Before running,
  reject the request if the user text contains a single quote, a backtick, `$(`,
  a newline, or a NUL. Say why and stop; do not try to escape it yourself.
- Always wrap the argument string in single quotes so the shell cannot expand it.

Foreground flow (`--wait`):
- Run with a Bash timeout of at least 10 minutes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-bridge.mjs" image '$ARGUMENTS'
```
- Return the command stdout verbatim.

Background flow (default):
- Ensure the forwarded arguments include `--background`, then launch:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-bridge.mjs" image --background '$ARGUMENTS'`,
  description: "agy image",
  run_in_background: true
})
```
- Do not wait for completion in this turn.
- Tell the user: "agy image started in the background. Check `/agy-cc:runs` for progress and `/agy-cc:show` for the saved file."
