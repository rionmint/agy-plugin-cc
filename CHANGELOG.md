# Changelog

## 0.2.4

### Fixed — on Windows every shell call was refused when a command hook was configured

- **Cursor wrote the hook as a PowerShell line and ran it with bash.** On
  Windows Cursor builds every command hook, including the Claude Code
  `PreToolUse` hooks it imports from `~/.claude/settings.json`, as a PowerShell
  command line, but hands that line to `$SHELL` when it is set. The bridge is
  usually started from Claude Code's Bash tool or Git Bash, where `SHELL` is
  bash, so the line was a bash syntax error. Bash exits 2 on a syntax error and
  Cursor reads exit 2 as "blocked", so every shell call in a run came back as
  `Rejected: Hook blocked with message: --: eval: line 1: syntax error near
  unexpected token '&'`. The bridge now drops `SHELL` from the environment it
  starts `cursor-agent` with on Windows; Cursor then runs the hooks with
  PowerShell as written. Other platforms are unchanged. Reproduced with Cursor
  CLI 2026.10.01 before the fix and checked through the bridge after it: a plain
  `echo` runs, and a command the hook is meant to refuse is still refused.
- Note for hook authors: when Cursor runs a hook through PowerShell, the JSON on
  the hook's stdin starts with a UTF-8 byte order mark. A hook that parses stdin
  with a strict JSON reader fails on it; read the bytes, decode as UTF-8 and
  strip the mark before parsing.

## 0.2.3

### Fixed — the session env file grew on every resume and compaction

- **The SessionStart hook appended the same two exports every time it ran.**
  SessionStart fires again on each resume and each context compaction, and the
  host inlines the env file into every Bash call. In a session that lived for
  days the file reached twelve copies; together with the other plugins' files
  the inlined text passed 8192 bytes, where Git Bash cuts the `bash -c`
  argument, and long Bash commands started failing with a syntax error at the
  cut. The hook now skips a write when the variable's last export already
  carries the same value. It compares against the last export rather than any
  earlier one, so a value that changes and changes back still ends on the
  latest value. A missing file is treated as empty; any other read error is
  reported instead of being taken for an empty file, and an existing file
  without a trailing newline no longer gets the new export glued onto its last
  line. The upstream plugins this one derives from still append unconditionally
  (openai/codex-plugin-cc#528, xai-org/grok-build-plugin-cc#18).

## 0.2.2

Codex reviewed 0.2.1 from an isolated checkout and found what the other two
reviewers missed: the 0.2.0 security work had introduced a regression, and two
long-standing argument bugs were quietly eating user input. All four were
reproduced before being fixed.

### Fixed — a regression introduced by the 0.2.0 escaping

- **A `.cmd` target whose path contains a space would not launch.** Caret-escaping
  the quotes around the target hid them from cmd's own tokenizer, which then
  split the path at the space and reported "is not recognized as an internal or
  external command". The target now keeps real quotes and the whole line is
  wrapped in one more pair that `/s` strips; arguments still get the caret
  treatment, because they are the ones carrying untrusted text. Both the spaced
  path and the original injection payload are covered by tests.

### Fixed — the state lock could be taken from a live holder

- `openSync(lockPath, "wx")` followed by writing the pid left a window in which
  the lock existed but was empty. A waiter looking in during that window saw no
  pid, concluded the lock was stale, and unlinked it out from under a holder
  that was still inside its critical section — and the holder's own release then
  deleted the next holder's lock. The lock file is now written completely under
  a private name and linked into place in one atomic operation, an empty lock is
  treated as held rather than stale, and a release only removes a lock that
  still carries this process's token.

### Fixed — arguments were being eaten

Both of these are inherited from the upstream plugin.

- **Flags packed into one argument alongside another were dropped.** Slash
  commands forward the user's arguments as a single string; when the command
  also adds its own flag, that string was no longer the sole argv entry and was
  swallowed as one unknown option. `/cursor-cc:review --background` silently
  lost `--base`, `--scope`, `--model`, `--mode` and any focus text.
- **Backslashes were eaten by the tokenizer.** `C:\src\app.ts` arrived as
  `C:srcapp.ts`, and `/foo\d+/` as `/food+/`. A backslash now escapes only a
  quote, whitespace, or another backslash; anywhere else it is literal.

## 0.2.1

A second adversarial pass — this time by Grok Build, Codex and Cursor itself
through this very plugin — went after the 0.2.0 write-up rather than the code.
It found that the documentation was a release behind and, worse, that
SECURITY.md claimed protections the implementation did not deliver. A false
security claim is more damaging than an absent one, so this release is mostly
about making every claim checkable.

### Fixed — documentation that did not match the code

- **README described the pre-0.2.0 architecture.** The "How a run works" example
  still showed `-p <prompt> … --output-format text`, while 0.2.0 had moved the
  prompt to stdin and switched every run to `--output-format json`. The
  changelog and the landing page contradicted each other.
- **SECURITY.md said tests proved review cannot edit files.** They assert the
  argv, not the CLI's behaviour, which the same file admitted further down.
- **SECURITY.md said files are written `0o600`.** Job records were; run logs
  were not. They are now — see below — and the claim is scoped to what is true.
- **SECURITY.md counted the 8 MiB stdin cap as protection against the child.**
  That cap is on what the bridge reads from a pipe, not on what it sends.
- **The plugin's controls are now split into what the code enforces, what is
  only an instruction to a model, and what is not defended at all.** The kill
  check is a substring match, the state lock is a pid file, and the read-only
  mode is a request to the Cursor CLI. All three now say so.
- `review.md` claimed the command takes no focus text; the bridge forwards it.

### Fixed — code

- Run logs are created `0o600`. They hold the prompt and any inlined repository
  content, so they get the same treatment as the job records beside them.
- `--sandbox` and `--plugin-dir` values are validated like every other flag
  value; they were the two that slipped through in 0.2.0.
- A background run whose worker fails to spawn is marked `failed` instead of
  sitting at `queued` forever.
- `.env.example`, `.env.sample`, `.env.template` and `.env.dist` are no longer
  swept up by the credential-name filter. They exist to be shared and are
  usually what a reviewer wants to look at.
- `/cursor-cc:delegate` carries `disable-model-invocation: true`, matching the
  0.2.0 claim that the subagent is no longer for spontaneous use.

### Added

- `license`, `homepage` and `repository` in the plugin manifest.

## 0.2.0

Security release. Everything below was found by an adversarial review of 0.1.0
by Grok Build and Codex, plus follow-up work here. Several of the findings were
reproduced with working payloads before being fixed, and each one now has a
regression test.

If you installed 0.1.0, update.

### Fixed — command execution

- **Command injection through a Windows `.cmd` shim (critical).** The Cursor CLI
  ships as `cursor-agent.cmd` on Windows, so the bridge goes through `cmd.exe`.
  Wrapping an argument in double quotes is not enough: a `"` inside the value
  closes cmd's quoted region and the rest is parsed as cmd syntax again. Worse,
  a batch file re-expands `%*` into its own line, so a single round of escaping
  is consumed by the outer parse (the CVE-2024-24576 class). Reproduced with
  `--model 'x" & echo pwned>PWNED.txt & rem "'`, which created the file. Every
  token is now quoted for the child's parser and caret-escaped for cmd, twice
  for a batch target.
- **The prompt no longer travels on the command line.** It is written to the
  child's stdin, which Cursor accepts, so free-form text cannot be touched by
  cmd's `%VAR%` expansion at all.
- **Argument injection.** `--model`, `--mode`, `--output-format`, the resume
  session id and the workspace path are pattern-checked before they are pushed
  into argv. Previously `--model --force` would have been read by Cursor as a
  flag and turned a read-only review into a write-capable run.
- **`!` shell interpolation removed from the `runs`, `show` and `stop`
  commands.** They pre-executed a shell line with `$ARGUMENTS` substituted into
  it, so a run id of `$(...)` was a command. `review` and `critique` now
  single-quote the forwarded argument string.

### Fixed — file system

- **Path traversal through a run id.** Run ids arrive from slash-command
  arguments and become a path component; `/cursor-cc:show ../../outside` read
  and wrote outside the run directory. Ids are now validated.
- **Untracked symlinks are no longer followed into the prompt.** A repository
  could ship `notes.md -> ~/.ssh/id_rsa` and have the key inlined into the
  review prompt. `lstat` is used, symlinks and non-regular files are skipped,
  anything resolving outside the repository is refused, and names that usually
  hold credentials (`.env`, `id_rsa`, `*.pem`, …) are held back.
- **Arbitrary file deletion during pruning.** A job record's `logFile` path is
  json on disk; pruning unlinked it without question. It is now only removed
  when it really resolves inside that workspace's run directory.
- **Run state permissions.** The run directory is created `0o700` and files are
  written `0o600`, which matters because the fallback root is under the system
  temp directory.

### Fixed — process and state handling

- **Stopping a run verifies what it is about to kill.** Pids come from json and
  the operating system reuses them, so a stale record could name the user's
  editor or shell. A process is only signalled when its command line still looks
  like `cursor-agent` or `cursor-bridge.mjs`; a mismatch is reported and skipped.
- **A crashed run no longer wedges the plugin.** The state lock records its
  holder's pid and a lock whose owner is gone is broken once by the next waiter.
  Before this, a lock left behind by a crash made every later save — including
  `stop` — fail until someone deleted the file by hand.
- **Bounded buffers.** Agent stdout/stderr is capped at 32 MiB and piped stdin
  at 8 MiB. A stuck child could previously grow a string until the bridge died.
- **The session hook refuses to export a value containing a line break**, which
  would otherwise append a second `export` line to a file the host sources.

### Changed — the write boundary

- **Delegation is read-only by default.** 0.1.0 inherited an instruction to add
  `--write` unless the user asked otherwise, while the README claimed the
  opposite. The subagent now adds `--write` only when the user's own words asked
  for edits, and repository content never authorises it.
- **`--write` together with `--mode ask` is an error.** It used to silently drop
  the read-only mode.
- **The delegate subagent is no longer advertised for proactive use.**

### Added

- [SECURITY.md](./SECURITY.md) — threat model, what is enforced, and what is
  deliberately not defended.
- Regression tests: Windows escaping round-trips over hostile arguments, the
  injection payload, run-id traversal, flag-lookalike values, symlink and
  credential-name handling in untracked files, and kill identity checks.

## 0.1.0

First release. A Claude Code bridge to the Cursor CLI, derived from
[xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc)
under Apache-2.0. See [NOTICE](./NOTICE) for the full attribution and the list
of changes made to the upstream project.
