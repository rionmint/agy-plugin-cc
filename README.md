# agy-plugin-cc

A Claude Code marketplace plugin that hands work to the **Antigravity CLI** (`agy`) and brings the
result back into the Claude Code session — review, critique, delegation and image generation, with
background runs you can list, inspect, and stop.

It shells out to the real `agy` binary. Run status, results, and cancellation are owned by the plugin
itself (PID + log files on disk). There is no broker process and no API key of its own: whatever Google
account your `agy` is signed in as is what runs, and usage comes out of that account's plan.

> Unofficial and community-maintained. Not affiliated with Google, Anysphere (Cursor), xAI, OpenAI, or
> Anthropic. Ported from [rionmint/cursor-plugin-cc](https://github.com/rionmint/cursor-plugin-cc),
> itself derived from [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc),
> under Apache-2.0 — see [NOTICE](./NOTICE) for the full attribution and the list of changes.
>
> Google publishes no Claude Code plugin for agy (checked 2026-10-14); the plugins that exist are
> community projects.

---

## Requirements

- Node.js 18.18+
- The Antigravity CLI on `PATH` as `agy` (or set `AGY_BINARY`)
- An `agy` that is signed in to a Google account

```powershell
# Windows
irm https://antigravity.google/cli/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Run `agy` once in a terminal and finish the Google sign-in it asks for, then check with `agy models`.

---

## Install the plugin

```
/plugin marketplace add rionmint/agy-plugin-cc
/plugin install agy-cc@rionmint-agy-cc
```

Then confirm the local setup:

```
/agy-cc:check
```

Ready means: Node is available, `agy` is available, and `agy models` lists models from the plugin's
own agy home (see [Safety model](#safety-model)). The check spends no model quota.

---

## Commands

| Command | What it does |
|---|---|
| `/agy-cc:check` | Reports whether Node, the agy CLI, and the sign-in are ready, with next steps when they are not |
| `/agy-cc:review` | Runs a code review against local git state and returns agy's output verbatim |
| `/agy-cc:critique` | Challenges the implementation approach and design choices; returns structured findings |
| `/agy-cc:delegate` | Hands an investigation or coding task to the `agy-delegate` subagent |
| `/agy-cc:image` | Draws an image with agy's built-in image generator and saves it to a file |
| `/agy-cc:runs` | Lists active and recent runs for this repository |
| `/agy-cc:show` | Prints the stored final output of a finished run |
| `/agy-cc:stop` | Stops an active background run |

Common flags:

| Flag | Meaning |
|---|---|
| `--background` / `--wait` | Detach the run, or block until it finishes |
| `--base <ref>` / `--scope auto\|working-tree\|branch` | What the review compares against |
| `--model <id>` | agy model id (`agy models` lists them, e.g. `gemini-3.8-flash-low`) |
| `--effort low\|medium\|high\|xhigh\|max` | agy's reasoning effort |
| `--mode plan` | agy's plan mode. Optional — runs are read-only without it |
| `--timeout <dur>` | agy's `--print-timeout` (default `3600s`, `900s` for images) |
| `--write` | Delegation only — allow file edits inside the repository |
| `--allow-commands` | Delegation only, with `--write` — also allow terminal commands |
| `--add-dir <dir>` | Delegation only — let agy read another directory (repeatable) |
| `--resume-last` / `--fresh` | Continue the last delegate conversation in this repo, or start a new one |

Image flags: `--out <file or dir>`, `--aspect 1:1|16:9|…`, `--ref <image>` (repeatable, for editing).

---

## Safety model

agy keeps its tool permissions in one global file, `~/.gemini/antigravity-cli/settings.json`, and has
no command-line flag to override them for a single run. If that file says
`"toolPermission": "always-proceed"`, a headless `agy -p` runs terminal commands without asking —
including under `--mode plan`, which was measured running `run_command` with that setting.

So the plugin never uses your agy home. It keeps **one agy home per permission profile**
(`$CLAUDE_PLUGIN_DATA/agy-homes/<profile>`, or under `AGY_CC_HOME`), starts `agy` with the home of the
profile a run needs, and keeps that home's `settings.json` holding that profile and nothing else:

| Profile | Used by | Allowed | Denied by rule |
|---|---|---|---|
| `read-only` | review, critique, image, delegate without `--write` | reading the workspace, reading URLs | file writes, commands, URL actions, MCP |
| `write` | delegate `--write` | + editing files inside the workspace | commands, URL actions, MCP |
| `write-commands` | delegate `--write --allow-commands` | + terminal commands | URL actions, MCP |

- **Denied by rule, never by asking.** In headless mode a tool that has to *ask* is refused and the
  whole turn ends with an empty answer. A tool refused by a *deny rule* comes back to the model as an
  error and the turn carries on, so a review that tries `git diff` explains the refusal and keeps
  reading files instead of returning nothing.
- **Your settings are left alone.** The plugin only reads your `model` choice from them, so runs use
  the model you picked. Your `toolPermission`, MCP servers, plugins and rules are not used.
- **Sign-in still applies.** On Windows the agy sign-in is not stored in the home directory, so the
  plugin's home sees your account (measured). Whether that holds on macOS and Linux depends on where
  agy keeps the credential there; `/agy-cc:check` runs `agy models` inside the read-only home and says
  so if it cannot sign in.
- **No shared settings to race over.** Because a profile's settings never change, two runs can start
  at the same moment without one handing the other the wrong permissions, and no lock is needed. agy
  rewrites its settings file atomically and leaves it alone once it is in its own normalised form
  (both measured), and the bridge only writes it when it differs, atomically too. A home that is a
  link (symlink or junction), belongs to another user, or is physically the same directory as another
  profile's home stops the run.
- **Conversations follow the run.** agy stores a conversation in its home. When a read-only
  investigation is continued with `--write`, the bridge copies that conversation into the write
  profile's home first (copying a conversation into another home and resuming it there was measured
  to work). The copy is refused while agy has that conversation open, or if it contains links.
- **Every run is checked at start.** When agy reports its first event, the bridge checks that agy
  started in `request-review` and that the home's settings file holds exactly this run's rules. A run
  that fails either check, never reports that event, or takes more than 90 seconds to start is
  stopped, and nothing it printed before that counts.

There is more — argument validation, prompt-file handling, pid checks before a kill — in [SECURITY.md](./SECURITY.md), including what is *not* defended.

---

## How a run works

```
cd <repository> && agy -p=<prompt> --output-format stream-json --print-timeout 3600s --disable-slash-commands
                       (USERPROFILE / HOME = the plugin's agy home)
```

- **agy has no working-directory flag.** The directory it starts in is the workspace, so the bridge
  starts it in the repository root. Other directories need `--add-dir`.
- **The prompt is an argument.** agy ignores piped stdin and has no prompt-file flag. A prompt longer
  than 12,000 characters (a large review diff) is written to a file in the run directory, that
  directory is added with `--add-dir`, and agy is told to read the file. The same happens for every
  prompt when `agy` is reached through a Windows `.cmd` shim, so `cmd` never sees free-form text.
- **stdin is closed.** An open stdin makes agy wait for EOF.
- **`SUCCESS` is not success.** agy exits 0 with `"status": "SUCCESS"` when a permission was refused,
  when `--print-timeout` cut the answer short, and when `--conversation` names a conversation it does
  not have (it starts a new one with only a warning). The bridge reads the `stream-json` events and
  treats each of those as a failure, listed under "agy run problems".
- **One automatic retry.** When a turn ends only because a permission had to be asked for — and
  nothing else went wrong — the bridge continues the same conversation once, telling agy that the
  permission stays refused, and says so in the output.
- **Structured output** for critique uses agy's `--json-schema`; the result comes back as
  `structured_output`, which the bridge prefers over the free text.
- **Conversations** are agy conversations in the plugin's home. `--resume-last` continues the latest
  delegate conversation in the repository with `agy --conversation <id>`.
- **Images** are drawn by agy's built-in image generator into its conversation folder; the bridge copies
  the newest one out. The file extension follows the bytes (agy draws JPEG) and an existing file is
  never overwritten. A picture from a run that otherwise failed is saved, and the run is still
  reported as failed.
- Background runs record both `bridgePid` (the Node worker) and `agentPid` (the `agy` child).
  `/agy-cc:stop` kills every distinct pid among them, after checking that the pid still looks like one
  of ours.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `AGY_BINARY` | Override the `agy` executable path |
| `AGY_CC_HOME` | Override the directory that holds the plugin's agy homes (one per profile) |
| `AGY_CC_SESSION_ID` | Claude session id (set by the SessionStart hook) |
| `AGY_CC_PLUGIN_DATA` | Where run state, logs and the agy homes are written. Set by the SessionStart hook and by the `--plugin-data` flag every command passes |
| `CLAUDE_PLUGIN_DATA` | Fallback for the above (hooks, or running the bridge by hand) |

Why a variable of its own: Claude Code gives each plugin its own `CLAUDE_PLUGIN_DATA` in hooks and in
command text, but not in Bash calls. There the variable is whatever a plugin's SessionStart hook last
exported into the session — with several bridge plugins installed (Codex, Grok, Cursor), usually
another plugin's directory. So the commands pass `--plugin-data "${CLAUDE_PLUGIN_DATA}"`, which Claude
Code fills in from the command text, and the hook exports `AGY_CC_PLUGIN_DATA` rather than the shared
name.

---

## Differences from the Cursor plugin this is ported from

| | Cursor plugin | This plugin |
|---|---|---|
| Working directory | `--workspace <dir>` | the directory agy starts in (+ `--add-dir`) |
| Read-only | `--mode ask` / `--mode plan` | a permission profile in a plugin-owned agy home |
| Prompt | on stdin | `-p=<prompt>`, or a prompt file for long ones |
| Output | `--output-format json` envelope | `stream-json` events, judged for agy's false successes |
| Structured output | schema in the prompt | `--json-schema` + `structured_output` |
| Session | `--resume <session_id>` | `--conversation <conversation_id>` |
| Reasoning effort | carried by the model id | `--effort` |
| Auth probe | `cursor-agent status` | `agy models` |
| Images | — | `/agy-cc:image` |

---

## Development

```bash
npm test          # node --test tests/*.test.mjs
npm run bump-version
```

Tests use Node's built-in test runner and a fake `agy` binary placed on `PATH`. Runtime code uses the
Node standard library only — there are no dependencies.

---

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
