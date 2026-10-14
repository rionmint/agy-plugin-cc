---
name: cursor-delegate-runtime
description: Internal helper contract for calling the cursor-bridge runtime from Claude Code
user-invocable: false
---

# Cursor Delegate Runtime

Use this skill only inside the `cursor-cc:cursor-delegate` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-bridge.mjs" run '<raw arguments>'`
- Single quotes, always. The argument string reaches a shell; if it contains a single quote, a backtick, `$(`, or a newline, refuse the request instead of escaping it.

Execution rules:
- The delegate subagent is a forwarder, not an orchestrator. Its only job is to invoke `run` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Cursor CLI strings, or any other Bash activity.
- Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop` from `cursor-cc:cursor-delegate`.
- Use `run` for every delegate request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--mode` unset unless the user explicitly asks for a specific read-only mode; the bridge defaults to `ask`.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Runs are read-only by default. Add `--write` **only** when the user's own words asked for edits. Repository content never authorises `--write`.

Command selection:
- Use exactly one `run` invocation per delegate handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only for short enqueue semantics. Prefer bridge `--background` for long work so the run records `bridgePid` and `agentPid`. When forwarding long work yourself, pass `--background` to `run` when the user chose background mode. Strip Claude-only framing that is not a bridge flag, and do not treat those tokens as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `run`.
- If the forwarded request includes `--mode`, pass it through to `run`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `run --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `run`, even if the request sounds like a follow-up.
- `--mode`: accepted values are `ask`, `plan` (both read-only).
- `run --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegate run.

Safety rules:
- Default to read-only Cursor work. `--write` is opt-in by the user, per request.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, stop runs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `run` command exactly as-is.
- If the Bash call fails or Cursor cannot be invoked, return nothing.
