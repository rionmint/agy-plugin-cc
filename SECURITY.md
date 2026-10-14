# Security

This plugin runs on your machine, spawns the Antigravity CLI (`agy`) as a child process, and writes
run state under your plugin data directory. It has no server component, no telemetry of its own, and
no credentials of its own — it uses whatever Google account your `agy` is already signed in as.

This document is written to be checkable. Every row below names the code that implements it, and
anything that sounds stronger than it is has been moved to
[Weaker than it sounds](#weaker-than-it-sounds) rather than dressed up.

## Threat model

The realistic attackers are:

1. **Repository content.** File names, diffs, branch names and commit messages from a repository you
   review end up in argv (git commands) and in the prompt sent to the agent. A hostile repository is
   a normal thing to review.
2. **Your own arguments.** Slash-command arguments (`--model`, a run id, a path) flow into a child
   process command line.
3. **On-disk run state.** Job records under the plugin data directory hold pids and file paths that
   the plugin later acts on.
4. **Your own agy configuration.** A global `toolPermission` of `always-proceed` would make every
   headless agy run execute commands without asking. The plugin must not inherit it.

The plugin is *not* designed to defend you against an agent you deliberately gave write access to.
`/agy-cc:delegate --write` can edit your files, and `--allow-commands` can run commands. That is the
point of them.

## Enforced in code

These are properties of the code, not instructions to a model.

| Boundary | How |
|---|---|
| Your agy permission settings are never used | Every run starts agy with a plugin-owned home (`USERPROFILE` on Windows, `HOME` elsewhere): one home per permission profile, whose settings file holds that profile only. `agyChildEnv`, `prepareAgyHome` and `PERMISSION_PROFILES` in `scripts/lib/agy.mjs`; `tests/agy-bridge-permissions.test.mjs` checks that a user file saying `always-proceed` is left untouched and not applied |
| Read-only runs cannot write files or run commands | The `read-only` profile denies `write_file(*)`, `command(*)`, `unsandboxed(*)`, `execute_url(*)` and `mcp(*)` by rule, on top of `toolPermission: request-review`. Measured against agy 1.3.5 on Windows: writes and commands were refused, reads and URL reads worked |
| Concurrent runs cannot hand each other the wrong profile | There is no shared settings file to swap: each profile has its own home, and every writer of a home writes the same profile. The bridge writes the file only when it differs in substance, with an atomic rename; agy rewrites it atomically and not at all once it is normalised (both measured on agy 1.3.5). A reader therefore only ever sees a complete file holding that home's profile, and no lock is involved — an orphaned or slow agy reads the same profile whenever it starts. The separation is checked physically, not just by name: the home root, each home and its settings folder must be real directories (not symlinks or junctions) owned by the current user, and no two profile homes may be the same directory, or the run stops. `prepareAgyHome` / `assertPrivateHomes`; `tests/agy-cli.test.mjs` runs three profiles concurrently and checks each run's home and rules, and refuses a junctioned home |
| A run that did not get its profile is stopped | Two checks at agy's first `stream-json` event (`init`): the reported permission mode must be `request-review`, and the home's settings file must hold exactly this run's allow / deny rules, the expected base mode and artifact policy, and no key outside agy's documented settings. A malformed file (an explicit null, a wrong type, an unknown key, a link in place of the file) never matches, and an error while handling an event stops the run. Either mismatch kills the run and fails it; events that arrive before the checks pass, and a run that never passes them within 90 seconds, fail closed. `runHeadlessAgent` / `settingsMatchProfile`, tested with fake agy runs that start in `always-proceed`, that rewrite their settings during start-up, that send a result without `init`, and against malformed settings |
| A conversation moved between homes is copied whole or not at all | Continuing a conversation under another profile copies only `conversations/<id>.db`, `brain/<id>/` and `annotations/<id>.pbtxt`, for an id that passed the conversation-id pattern. The copy is refused while a SQLite journal sits next to the database on either side (agy has it open, or was killed mid-write) and when anything in it is a link or not a plain file. Artifacts are staged and swapped in, and the database — whose time decides which copy is newest — is replaced last, atomically, keeping the source's timestamp, so a copy that fails half-way leaves the source still newest and is redone next time. `syncConversationInto`, with tests for open journals, links and replacement |
| No shell is used to find or run a binary | `runCommand` and `spawnCli` pass `shell: false`; libuv searches `PATH`/`PATHEXT` itself, so repository-derived argv (git refs in particular) is never re-parsed by a shell. `lib/git.mjs` forces `shell: false` on every git call |
| Windows `.cmd` / `.bat` shims cannot be used to inject commands | Every argument is quoted for the child's CRT parser and then caret-escaped for `cmd`, **twice** for a batch target, because a batch file re-parses its own `%*`. This is the CVE-2024-24576 class of bug. The batch file's own path is not escaped, so a path containing `%`, `!`, `^`, `"` or a line break is refused. `quoteWindowsArg` / `buildCmdLine` in `scripts/lib/process.mjs`, with round-trip tests in `tests/windows-escaping.test.mjs` |
| Free-form text never reaches a `cmd` command line | agy needs the prompt in argv. When agy is a real executable that is safe (no shell parses it). When it is reached through a `.cmd` shim, the prompt is written to a file and argv carries only a fixed sentence naming that file. `buildPromptDelivery` in `scripts/lib/agy.mjs` |
| A prompt cannot become a flag | The prompt is passed attached, as `-p=<prompt>`, so a prompt starting with `-` is still a prompt. `--disable-slash-commands` keeps a prompt starting with `/` from being expanded into an agy command |
| Flag values cannot become flags | `--model`, `--mode`, `--effort`, `--print-timeout`, the conversation id, `--add-dir` paths and the schema path are pattern-checked before being pushed into argv. `assertSafeCliValue` / `assertSafePath` in `scripts/lib/agy.mjs`; `tests/cli-value-safety.test.mjs` |
| Contradictory requests are errors | `--write --mode plan` and `--allow-commands` without `--write` throw instead of one of them quietly winning |
| agy's false successes are failures | Exit 0 with `SUCCESS` is not trusted: a refused permission, a fired `--print-timeout`, an empty answer and an unknown `--conversation` id each fail the run. `judgeAgyRun` |
| Run ids cannot escape the run directory | Run ids arrive from slash-command arguments and become a path component; `assertSafeJobId` in `scripts/lib/state.mjs` rejects anything outside `[A-Za-z0-9._-]` or containing `..` |
| Repository symlinks cannot exfiltrate files | Untracked file bodies are inlined into the prompt. `formatUntrackedFile` uses `lstat`, skips symlinks and non-regular files, and refuses anything whose real path is outside the repository. `tests/untracked-file-safety.test.mjs` |
| Prompt files cannot be redirected, and cleanup removes only what it made | A long prompt goes into a directory created fresh with `mkdtemp`, and the file is opened exclusively (`wx`), so a link planted at a predictable path is never written through. The directory and the file are remembered by device and inode; afterwards each is removed only while it is still that same object (the directory checked before the file in it), and nothing is removed recursively. `buildPromptDelivery` / `removePromptDelivery` |
| Pruning cannot delete arbitrary files | A job record's `logFile` path comes from json on disk. It is only unlinked when it really resolves inside that workspace's run directory, and only when it is a regular file. `removeJobLogIfOwned` |
| An image never overwrites a file, and a saved image does not hide a failed run | The copy is opened with `wx`; a taken name gets a `-2`, `-3`… suffix. When agy drew a picture but the run itself failed (a timeout, an error status), the picture is saved and the run is still reported as failed. `executeImageRun` |
| Run state is not readable by other local users | The run directory and the agy home are created `0o700` on POSIX; job records, logs, prompt files and settings are written `0o600`. On Windows the default ACL applies |
| Terminal status cannot be lost to a race | `claimJobTerminal` takes the state lock and lets `cancelled` win, so a finishing worker cannot overwrite it with `completed` |
| A child cannot exhaust the bridge's memory | Agent stdout/stderr is capped at 32 MiB, and a piped prompt read by the bridge at 8 MiB |
| The session hook cannot inject a second `export` | A value containing a line break is dropped rather than escaped |

## Weaker than it sounds

Each of these is a real improvement over having nothing. None of them is a hard boundary, and
calling them one would be a lie.

- **The permission profile is enforced by agy, not by this plugin.** The bridge writes deny rules and
  checks the start-up permission mode; it does not watch what tools agy calls. The rules were checked
  by hand against agy 1.3.5 on Windows 11 — file writes and commands refused, file and URL reads
  allowed — and not against every build. The `mcp(*)` and `execute_url(*)` denials were not exercised
  (the plugin homes have no MCP servers). There is no version floor. If a future agy ignores a rule, the
  plugin will not notice.
- **The start-up check reads the file, not agy's memory.** agy does not report the rules it loaded,
  only the base mode. The file check shows what the home holds when agy starts; with one profile per
  home that is the same thing, but someone editing a plugin home by hand between agy's read and the
  check would not be noticed.
- **Prompt cleanup is a check-then-act on paths.** Identity is checked right before each removal, but
  Node has no directory-handle-relative unlink, so a process racing to replace a directory in the
  instant between the check and the unlink could still win. The worst case is losing one file named
  `prompt.md` in a directory someone else controls.
- **Which copy of a conversation is newest is decided by file time.** The source home keeps its
  version, and a resume takes the copy whose database file was written last. The bridge never creates
  diverging copies itself, but two Claude sessions continuing the same conversation under different
  profiles at the same moment are only caught if agy still has the database open (the journal check).
- **Reads are not confined to the repository.** The read-only profile allows `read_url(*)`, and agy
  decides itself which local paths count as its workspace. It refused a path outside the workspace
  in measurements but read one under the same temp directory; treat anything readable by your user as
  readable by a review.
- **Delegation defaulting to read-only is an instruction, not a gate.** The subagent markdown says to
  add `--write` and `--allow-commands` only when the user asked for them. A model that ignores it can
  still pass them, and the bridge will honour them.
- **The single-quoting rule for `review`, `critique` and `image` is also an instruction.** Those
  commands still hand an argument string to a `Bash` call that a model composes.
- **The kill check is a pattern match.** Before signalling, the plugin reads the process command line
  and requires it to *start* with one of its own programs: node running `agy-bridge.mjs`, an `agy` /
  `agy.exe` binary, cmd.exe running an `agy.cmd` shim, or the exact path the job recorded when it
  launched agy. A process that only mentions these among its arguments does not match. That stops
  the ordinary pid-reuse accident, but it is not identity verification (no process start time is
  compared). Unreadable command lines fail closed: the run is
  marked cancelled and the process is left alone, so a runaway can survive a `stop`.
- **The credential filter is a name filter.** `.env`, `id_rsa`, `*.pem` and similar untracked files are
  held back from the prompt; a secret in a file named something else is not.
- **Only untracked files get that treatment.** Staged content and branch diffs reach the prompt as a
  diff, which is what a review is for.

## Not defended

- **Prompt injection.** Repository content goes into the prompt. A hostile repository can try to steer
  the agent. The mitigation is the read-only profile on review and critique, not prompt filtering.
- **What the read-only profile still allows.** A steered agent can read files and fetch URLs, so it
  could in principle put something it read into a URL it fetches.
- **Model quota.** Every run, including the automatic follow-up after a refused permission, spends the
  signed-in account's agy quota. The plugin sets `useG1Credits: false` in its own settings so that a
  run does not move on to paid credits when the plan's quota is used up.
- **Conversation history.** agy keeps every bridge conversation (prompts, answers, generated images)
  in the plugin's agy home. Nothing prunes it.
- **A worker killed outright leaves its run marked `running`.** There is no watchdog; `/agy-cc:stop`
  clears it.
- **`--resume` continues the latest delegate conversation**, not a particular older run. The hint
  printed under a run says so.
- **Job records hold the prompt.** A background run stores its request, prompt included, under your
  plugin data directory.

## Reporting

Open an issue at https://github.com/rionmint/agy-plugin-cc/issues. If the report includes a working
exploit, say so in the title so it can be handled before the details spread.
