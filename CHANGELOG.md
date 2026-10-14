# Changelog

## 0.1.0 — 2026-10-14

First release. Ported from [cursor-plugin-cc](https://github.com/rionmint/cursor-plugin-cc) 0.2.4,
whose own history covers the bridge runtime this inherits (job tracking, background workers, the
state lock, Windows argument escaping, kill safety).

What is new for agy:

- **Plugin-owned agy home with permission profiles.** agy has no per-run permission flag and reads a
  global `toolPermission`; with `always-proceed` there a headless run executes commands even under
  `--mode plan` (measured). Every bridge run therefore starts agy with its own home and a
  `read-only`, `write` or `write-commands` profile written under a lock, and is stopped if agy does not
  start in `request-review`.
- **Deny rules instead of asks.** A tool that has to ask ends a headless turn with an empty answer; a
  tool refused by rule lets the turn continue. All state-changing tools are denied by rule.
- **agy's false successes are failures.** Refused permissions, `--print-timeout`, empty answers and an
  unknown `--conversation` id all exit 0 with `SUCCESS`; the bridge reads `stream-json` events and
  fails those runs, and continues a turn that ended on a refused permission once.
- **Prompt delivery.** `-p=<prompt>`, or a prompt file in an added directory when the prompt is long or
  agy is a Windows `.cmd` shim.
- **Structured critique** through `--json-schema` / `structured_output`.
- **`/agy-cc:image`** draws with agy's built-in image generator and copies the picture out of agy's
  conversation folder, naming the file by its real type and never overwriting.
- New flags: `--effort`, `--timeout`, `--allow-commands`, repeatable `--add-dir`.
- A sign-in that headless agy cannot complete is detected and the run stopped at once instead of
  waiting for agy's own one-minute login timeout.
