# Changelog

## 0.1.2 — 2026-10-14

- **`/agy-cc:check` prints one fixed table.** The command used to run the bridge with `--json` and let
  the model present it, so every session showed it differently (a table in one, an English list in
  another). The bridge now prints the table itself (the same rows in the same order, model ids grouped
  by family) and the command only translates its words. Missing values print as `unknown`, and pipes
  and line breaks cannot break the table.
- **The hook's data directory wins over the flag.** `--plugin-data` is only read right after the
  subcommand, so prompt text is never taken for it, a missing value is an error, and an
  `AGY_CC_PLUGIN_DATA` already exported by the hook is kept: on a host that did not fill
  `${CLAUDE_PLUGIN_DATA}` into the command text, bash would expand it to another plugin's directory.
  The SessionEnd hook cleans up the directory the host gave it.
- **The hook keeps its export file small.** Each write keeps one line per variable and drops the
  shared `CLAUDE_PLUGIN_DATA` line older versions wrote, so a file grown by repeated resumes shrinks
  on the next one. Claude Code puts these files into every Bash call's command line; on Windows a
  long-lived session had passed the 32 KB limit and every Bash call failed with `ENAMETOOLONG`.

## 0.1.1 — 2026-10-14

- **Uses its own data directory next to other bridge plugins.** In a Bash call `CLAUDE_PLUGIN_DATA` is
  whatever a plugin's SessionStart hook last exported into the session; with the Codex, Grok or
  Cursor plugin installed that was their directory, so agy homes and run state landed there (seen on
  the first install: `/agy-cc:check` reported its agy home under the Cursor plugin's data folder).
  Every command now passes `--plugin-data "${CLAUDE_PLUGIN_DATA}"`, which Claude Code fills in per
  plugin, the bridge prefers that (as `AGY_CC_PLUGIN_DATA`), and the hook exports
  `AGY_CC_PLUGIN_DATA` instead of the shared `CLAUDE_PLUGIN_DATA`, so it no longer hands its
  directory to other plugins either.
- Tests start every test file with a plugin data directory of their own and remove the temp
  directories they create, instead of inheriting the shell's `CLAUDE_PLUGIN_DATA`.
- The bridge's own text uses `<->` instead of an arrow character.

## 0.1.0 — 2026-10-14

First release. Ported from [cursor-plugin-cc](https://github.com/rionmint/cursor-plugin-cc) 0.2.4,
whose own history covers the bridge runtime this inherits (job tracking, background workers, the
state lock, Windows argument escaping, kill safety).

What is new for agy:

- **Plugin-owned agy home with permission profiles.** agy has no per-run permission flag and reads a
  global `toolPermission`; with `always-proceed` there a headless run executes commands even under
  `--mode plan` (measured). Every bridge run therefore starts agy with a plugin-owned home — one per
  `read-only`, `write` and `write-commands` profile, each holding only its own settings — and is stopped
  if agy does not start in `request-review` with that home's rules.
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

Hardened after four rounds of adversarial review (Codex) before release:

- The first version shared one agy home and swapped profiles in its settings file under a lock. The
  review showed lock recovery could still let two runs overlap, and an orphaned agy could read the
  wrong profile. Profiles now each have their own home, so nothing is ever swapped and there is no
  lock; a conversation continued under another profile is copied into that home.
- At `init` the bridge checks the home's settings hold exactly this run's rules (an unknown key, an
  explicit null, a wrong type or a link never match), a run that never passes the start-up checks
  within 90 seconds is killed, and nothing agy printed before the checks counts.
- A third round found the homes were separate by name only. A home that is a link, belongs to another
  user, or is the same directory as another profile's home now stops the run.
- Moving a conversation between homes is refused while agy has it open or if it contains links, is
  staged, and replaces the database last, keeping the source's timestamp.
- Prompt files go into a fresh `mkdtemp` directory, are opened exclusively, and cleanup removes only
  what was created, checked by device and inode, never recursively.
- A batch-file path that `cmd` would rewrite (`%`, `!`, `^`, quotes) is refused.
- The automatic follow-up turn only runs when a refused permission is the sole problem, so a lost
  conversation stays a failure.
- An image saved from a failed run, and a critique whose structured output does not match the full
  review schema, are reported as failures.
- `stop` only signals a process whose command line starts with one of the plugin's programs or the
  exact agy path recorded in the job, including the `agy.cmd` shim run by cmd.exe.
- A progress reporter that throws can no longer abort a run after agy has been started.
- A fourth round tightened the edges: a rollback `-journal` also blocks a conversation copy, artifacts
  the newer copy lacks are removed rather than kept, copy timestamps compare in whole milliseconds
  (a copy no longer looks older than its source), a prompt without a run directory gets its own
  `mkdtemp` directory instead of a shared temp folder, the bridge marker requires the script and a
  run subcommand in place (quoted or spaced paths included) and agy matches only the recorded
  program, and the stop target is recorded before, and independently of, the run log.
- The plugin data directory is documented as inside the trust boundary: races by other processes
  running as the same user there are not defended (SECURITY.md, Not defended).
