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

Hardened after an adversarial review (Codex) before release:

- At `init` the bridge also reads back the settings file agy rewrote from what it loaded and stops
  the run unless it holds exactly this run's rules; a run that never sends `init` fails closed.
- A start-up that takes over 90 seconds is killed before the settings lock is released; an abandoned
  lock is reclaimed only when its holder is dead and it is over 150 seconds old, by an atomic
  move-aside that puts a live lock back.
- Prompt files go into a fresh `mkdtemp` directory, are opened exclusively, and cleanup removes only
  what was created, never recursively.
- A batch-file path that `cmd` would rewrite (`%`, `!`, `^`, quotes) is refused.
- The automatic follow-up turn only runs when a refused permission is the sole problem, so a lost
  conversation stays a failure.
- An image saved from a failed run, and a critique whose structured output has the wrong shape, are
  reported as failures.
- `stop` also recognises the `agy.cmd` shim and a binary set through `AGY_BINARY`.
