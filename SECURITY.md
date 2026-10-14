# Security

This plugin runs on your machine, spawns the Cursor CLI as a child process, and
writes run state under your plugin data directory. It has no server component,
no telemetry, and no credentials of its own — it uses whatever account your
`cursor-agent` is already signed in as.

This document is written to be checkable. Every row below names the code that
implements it, and anything that sounds stronger than it is has been moved to
[Weaker than it sounds](#weaker-than-it-sounds) rather than dressed up.

## Threat model

The realistic attackers are:

1. **Repository content.** File names, diffs, branch names and commit messages
   from a repository you review end up in argv (git commands) and in the prompt
   sent to the agent. A hostile repository is a normal thing to review.
2. **Your own arguments.** Slash-command arguments (`--model`, a run id, a path)
   flow into a child process command line.
3. **On-disk run state.** Job records under the plugin data directory hold pids
   and file paths that the plugin later acts on.

The plugin is *not* designed to defend you against an agent you deliberately
gave write access to. `/cursor-cc:delegate --write` can edit your files. That is
the point of it.

## Enforced in code

These are properties of the code, not instructions to a model.

| Boundary | How |
|---|---|
| No shell is used to find or run a binary | `runCommand` and `spawnCli` pass `shell: false`; libuv searches `PATH`/`PATHEXT` itself, so repository-derived argv (git refs in particular) is never re-parsed by a shell. `lib/git.mjs` forces `shell: false` on every git call |
| Windows `.cmd` / `.bat` shims cannot be used to inject commands | Every token is quoted for the child's CRT parser and then caret-escaped for `cmd`, **twice** for a batch target, because a batch file re-parses its own `%*`. This is the CVE-2024-24576 class of bug. `quoteWindowsArg` / `buildCmdLine` in `scripts/lib/process.mjs`, with byte-for-byte round-trip tests over hostile arguments and a live injection payload in `tests/windows-escaping.test.mjs` |
| Free-form text never reaches a command line | The prompt is written to the child's **stdin**, not argv, so `cmd` cannot expand `%VAR%` inside it. `runHeadlessAgent` in `scripts/lib/cursor.mjs` |
| Flag values cannot become flags | `--model`, `--mode`, `--output-format`, `--sandbox`, the resume session id, the workspace path and any plugin directory are pattern-checked before being pushed into argv. `--model --force` is refused rather than silently turning a read-only review into a write run. `assertSafeCliValue` / `assertSafeWorkspace` in `scripts/lib/cursor.mjs` |
| Asking for write access and a read-only mode at once is an error | `--write --mode ask` throws instead of one of them quietly winning. `buildHeadlessArgs`, and again in the bridge's argument parsing |
| Run ids cannot escape the run directory | Run ids arrive from slash-command arguments and become a path component; `assertSafeJobId` in `scripts/lib/state.mjs` rejects anything outside `[A-Za-z0-9._-]` or containing `..` |
| Repository symlinks cannot exfiltrate files | Untracked file bodies are inlined into the prompt. `formatUntrackedFile` uses `lstat`, skips symlinks and non-regular files, and refuses anything whose real path is outside the repository. `tests/untracked-file-safety.test.mjs` reproduces the `notes.md -> id_rsa` case |
| Pruning cannot delete arbitrary files | A job record's `logFile` path comes from json on disk. It is only unlinked when it really resolves inside that workspace's run directory, and only when it is a regular file |
| Run state is not readable by other local users | The run directory is created `0o700` and chmodded on POSIX; job records and run logs are written `0o600`. On Windows the default ACL applies |
| Terminal status cannot be lost to a race | `claimJobTerminal` takes the state lock and lets `cancelled` win, so a finishing worker cannot overwrite it with `completed` |
| A child cannot exhaust the bridge's memory | Agent stdout/stderr is capped at 32 MiB, and a piped prompt read by the bridge at 8 MiB |
| The session hook cannot inject a second `export` | A value containing a line break is dropped rather than escaped |

## Weaker than it sounds

Each of these is a real improvement over having nothing. None of them is a hard
boundary, and calling them one would be a lie.

- **Read-only runs are a request to the Cursor CLI.** The bridge passes
  `--mode ask` and never `--force`; `tests/cursor-bridge-permissions.test.mjs`
  asserts that argv. It does **not** prove the CLI honours it. Cursor documents
  `--print` as having access to all tools, and `--mode ask` as read-only; the
  refusal was checked by hand against `2026.08.25` and not against every build.
  There is no version floor.
- **Delegation defaulting to read-only is an instruction, not a gate.** The
  subagent markdown says to add `--write` only when the user asked for edits.
  A model that ignores it can still pass `--write`, and the bridge will honour
  it. What the bridge does enforce is that `--write` and `--mode` cannot both
  be set.
- **The single-quoting rule for `review` and `critique` is also an
  instruction.** The real fix was removing the `!` host-side shell
  interpolation from `runs` / `show` / `stop`; those no longer put user text on
  a shell line at all. `review` and `critique` still hand an argument string to
  a `Bash` call that a model composes.
- **The kill check is a substring match.** Before signalling, the plugin reads
  the process command line and looks for `cursor-agent` or `cursor-bridge.mjs`.
  That stops the ordinary pid-reuse accident — your editor or shell will not
  match — but it is not identity verification, and a process that happens to
  have those strings on its command line would pass. The test in
  `tests/runtime.test.mjs` spawns stubs named to match, which is exactly as
  strong as the check itself. Unreadable command lines fail closed: the run is
  marked cancelled and the process is left alone, so a runaway can survive a
  `stop`.
- **The state lock is a pid file, not `flock`.** `openSync(..., "wx")` is
  atomic, and a lock whose recorded holder is no longer alive is broken once by
  the next waiter. Pid reuse could in principle protect a stale lock, and a
  holder that is alive but wedged still blocks.
- **The credential filter is a name filter.** `.env`, `id_rsa`, `*.pem` and
  similar untracked files are held back from the prompt; a secret in a file
  named something else is not. `.env.example` and friends are deliberately kept
  visible.
- **Only untracked files get that treatment.** Staged content and branch diffs
  reach the prompt as a diff, which is what a review is for.

## Not defended

- **Prompt injection.** Repository content goes into the prompt. A hostile
  repository can try to steer the agent. The mitigation is the read-only mode
  on review and critique, not prompt filtering.
- **`%VAR%` in a workspace path on Windows.** A path containing `%NAME%` where
  `NAME` is a defined environment variable can be rewritten by `cmd` when the
  Cursor CLI is a `.cmd` shim. Values are escaped, so this is a correctness
  wart, not an injection.
- **Prompt size.** The bridge caps what it reads from a pipe and what it reads
  back from the child, but the prompt it *sends* is bounded only by the review
  context heuristics (a diff budget plus per-file untracked limits). A
  repository with very many small untracked files can make it large.
- **`CURSOR_API_KEY` is trusted without a probe.** When that variable (or
  `CURSOR_AUTH_TOKEN`) is set, `/cursor-cc:check` reports ready without asking
  Cursor whether the key is valid, so an expired key still reads as ready. The
  report marks it `verified: false`; a browser login is verified.
- **A worker killed outright leaves its run marked `running`.** There is no
  watchdog; `/cursor-cc:stop` clears it.
- **The check report shows the signed-in account.** `/cursor-cc:check` prints
  what `cursor-agent status` prints. Redact it before pasting into a public
  issue.
- **Job records hold the prompt.** A background run stores its request, prompt
  included, under your plugin data directory.

## Reporting

Open an issue at https://github.com/rionmint/cursor-plugin-cc/issues. If the
report includes a working exploit, say so in the title so it can be handled
before the details spread.
