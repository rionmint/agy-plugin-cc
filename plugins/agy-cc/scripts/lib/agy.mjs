import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, resolveExecutable, runCommand, spawnCli, terminateProcessTree } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

// Upper bound on how much a single run may print back to us. The bridge holds
// this in memory, so an unbounded child would be a denial of service.
const MAX_AGENT_OUTPUT_BYTES = 32 * 1024 * 1024;

const DEFAULT_BINARY = "agy";
const BINARY_ENV = "AGY_BINARY";
const HOME_ENV = "AGY_CC_HOME";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

/**
 * agy has no prompt-file flag and ignores piped stdin, so the prompt has to be
 * an argv entry. A Windows command line tops out at 32,767 characters; anything
 * longer than this goes into a file the agent is told to read instead.
 */
export const INLINE_PROMPT_MAX_CHARS = 12000;

/** `--print-timeout` default. agy's own default (0) waits forever. */
export const DEFAULT_PRINT_TIMEOUT = "3600s";

/**
 * The permission mode every bridge run must start in. It is what the plugin's
 * own settings file asks for; anything else means the settings were not the
 * ones agy loaded, and the run is stopped.
 */
export const EXPECTED_PERMISSION_MODE = "request-review";

/**
 * agy's tool permissions live in a global settings file
 * (`~/.gemini/antigravity-cli/settings.json`), and the CLI has no flag that
 * overrides them for one run. A user who picked `always-proceed` there would
 * turn every "read-only" review into a run that executes commands — `--mode
 * plan` included, which was measured running `run_command` under that setting.
 *
 * So the bridge never uses the user's agy home. It runs agy with its own home
 * directory and writes the permission profile below into that home before each
 * run. Credentials are not stored in the home directory on Windows, so the
 * signed-in account still applies.
 *
 * Rules matter as much as the base mode. In headless mode a tool that has to
 * *ask* is auto-denied and the whole turn ends with an empty answer, while a
 * tool refused by a *deny rule* comes back to the model as an error and the
 * turn carries on. Every state-changing tool is therefore denied by rule, not
 * left to `ask`.
 *
 * `unsandboxed(*)` covers every command on Windows (there is no terminal
 * sandbox there), so it is denied only where commands are denied.
 */
export const PERMISSION_PROFILES = Object.freeze({
  "read-only": Object.freeze({
    allow: ["read_url(*)"],
    deny: ["write_file(*)", "command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"]
  }),
  write: Object.freeze({
    allow: ["read_url(*)"],
    deny: ["command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"]
  }),
  "write-commands": Object.freeze({
    allow: ["read_url(*)", "command(*)"],
    deny: ["execute_url(*)", "mcp(*)"]
  })
});

export function resolvePermissionProfile({ write = false, allowCommands = false } = {}) {
  if (allowCommands && !write) {
    throw new Error("--allow-commands requires --write.");
  }
  if (!write) {
    return "read-only";
  }
  return allowCommands ? "write-commands" : "write";
}

export function resolveAgyBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

/** The home directory every bridge run hands to agy. */
export function resolveAgyHome(env = process.env) {
  const override = env?.[HOME_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  const pluginData = env?.[PLUGIN_DATA_ENV];
  if (pluginData && String(pluginData).trim()) {
    return path.join(String(pluginData).trim(), "agy-home");
  }
  return path.join(os.tmpdir(), "agy-cc-home");
}

export function resolveAgySettingsFile(home) {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function findEnvKey(env, name) {
  return Object.keys(env).find((key) => key.toUpperCase() === name) ?? name;
}

/**
 * The environment agy starts with. Only the home directory changes: on Windows
 * Go reads `USERPROFILE`, elsewhere `HOME`. `HOME` is left alone on Windows so
 * that git, when agy runs it, still finds the user's own configuration.
 */
export function agyChildEnv(env = process.env, home, platform = process.platform) {
  const next = { ...env };
  if (!home) {
    return next;
  }
  const key = findEnvKey(next, platform === "win32" ? "USERPROFILE" : "HOME");
  next[key] = home;
  return next;
}

/** The model the user picked in their own agy settings, if it looks sane. */
export function readUserAgyModel(realHome = os.homedir()) {
  try {
    const settings = readJsonFile(resolveAgySettingsFile(realHome));
    const model = settings?.model;
    if (typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,79}$/.test(model)) {
      return model;
    }
  } catch {
    // no user settings, or unreadable: agy picks its default
  }
  return null;
}

/** The user's global `toolPermission`, for the check report only. */
export function readUserToolPermission(realHome = os.homedir()) {
  try {
    const value = readJsonFile(resolveAgySettingsFile(realHome))?.toolPermission;
    return typeof value === "string" && /^[a-z-]{1,40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function buildAgySettings(profileName, options = {}) {
  const profile = PERMISSION_PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown permission profile: ${JSON.stringify(profileName)}`);
  }
  const settings = {
    toolPermission: EXPECTED_PERMISSION_MODE,
    allowNonWorkspaceAccess: false,
    useG1Credits: false,
    showFeedbackSurvey: false,
    showTips: false,
    permissions: {
      allow: [...profile.allow],
      deny: [...profile.deny],
      ask: []
    }
  };
  if (options.model) {
    settings.model = options.model;
  }
  return settings;
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

/**
 * Make sure the plugin's agy home exists and carries the requested profile.
 *
 * The home also gets a `.gitconfig` that includes the user's own, because agy
 * passes its home on to the commands it runs and git would otherwise lose the
 * user's name, email and safe directories.
 */
export function prepareAgyHome(home, profileName, options = {}) {
  const settingsFile = resolveAgySettingsFile(home);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  const realHome = options.realHome ?? os.homedir();
  const model = options.model === undefined ? readUserAgyModel(realHome) : options.model;
  writeFileAtomic(settingsFile, `${JSON.stringify(buildAgySettings(profileName, { model }), null, 2)}\n`);

  const gitconfig = path.join(home, ".gitconfig");
  const realGitconfig = path.join(realHome, ".gitconfig").replace(/\\/g, "/");
  if (path.resolve(realHome) !== path.resolve(home) && !fs.existsSync(gitconfig) && !/[\r\n"]/.test(realGitconfig)) {
    try {
      fs.writeFileSync(gitconfig, `[include]\n\tpath = ${realGitconfig}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // git still works without it, only without the user's identity
    }
  }
  return settingsFile;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long agy may take to report `init` before the run is killed. */
export const STARTUP_TIMEOUT_MS = 90000;

/**
 * A lock is only treated as abandoned when its holder is dead *and* it is
 * older than any start-up could take. The holder recorded in the lock is the
 * bridge, not agy: a bridge that died could leave an agy child that is still
 * starting, and that child must not be handed someone else's profile.
 */
const STALE_LOCK_MIN_AGE_MS = STARTUP_TIMEOUT_MS + 60000;

function readLockToken(lockPath) {
  try {
    return String(fs.readFileSync(lockPath, "utf8")).trim();
  } catch {
    return "";
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The token of an abandoned lock, or null while the lock may still be in use. */
function staleLockToken(lockPath, now = Date.now()) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return null;
  }
  const token = readLockToken(lockPath);
  if (!token) {
    return null;
  }
  const pid = Number.parseInt(token.split(":")[0], 10);
  if (pidIsAlive(pid) || now - stat.mtimeMs < STALE_LOCK_MIN_AGE_MS) {
    return null;
  }
  return token;
}

/**
 * Take an abandoned lock out of the way without ever deleting a live one.
 *
 * Two waiters can both decide the same lock is abandoned. Unlinking by name
 * would let the slower one delete the lock the faster one has just taken. The
 * lock is instead moved aside atomically, and only deleted if what was moved is
 * the abandoned token; anything else is put back.
 */
function reclaimStaleLock(lockPath, staleToken) {
  const aside = `${lockPath}.reclaim.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return;
  }
  if (readLockToken(aside) === staleToken) {
    try {
      fs.unlinkSync(aside);
    } catch {
      // disposable
    }
    return;
  }
  // We moved a live lock. Put it back; if a third run took the name in the
  // meantime, the post-start settings check is what still catches a mix-up.
  try {
    fs.linkSync(aside, lockPath);
  } catch {
    // name taken again
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // disposable
  }
}

/**
 * The settings file is shared by every bridge run, and agy only reads it at
 * start-up (measured: rewriting it after the `init` event did not change the
 * running process). A run therefore holds this lock from writing its profile
 * until agy reports `init`, so a concurrent run cannot swap the profile in
 * between. The lock is claimed with `link()` so it is never visible empty.
 */
export async function acquireAgyHomeLock(home, options = {}) {
  const lockPath = path.join(home, ".agy-cc-settings.lock");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + (options.waitMs ?? 240000);

  for (;;) {
    const staging = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    fs.writeFileSync(staging, token, { encoding: "utf8", mode: 0o600 });
    try {
      fs.linkSync(staging, lockPath);
      return {
        lockPath,
        token,
        release() {
          try {
            if (readLockToken(lockPath) === token) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // already gone
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    } finally {
      try {
        fs.unlinkSync(staging);
      } catch {
        // the staging copy is disposable
      }
    }

    const stale = staleLockToken(lockPath);
    if (stale) {
      reclaimStaleLock(lockPath, stale);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for another agy run to start (lock ${lockPath}).`);
    }
    await sleep(100);
  }
}

function sameRules(left = [], right = []) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * agy rewrites its settings file when it starts, from what it has just read.
 * Reading the file back right after `init` therefore shows the rules agy
 * loaded; if they are not this run's profile, something else wrote the file in
 * between and the run must not continue.
 */
export function settingsMatchProfile(settingsFile, profileName) {
  const profile = PERMISSION_PROFILES[profileName];
  let settings;
  try {
    settings = readJsonFile(settingsFile);
  } catch {
    return false;
  }
  const permissions = settings?.permissions ?? {};
  const toolPermission = settings?.toolPermission ?? EXPECTED_PERMISSION_MODE;
  return (
    toolPermission === EXPECTED_PERMISSION_MODE &&
    sameRules(permissions.allow, profile.allow) &&
    sameRules(permissions.deny, profile.deny) &&
    sameRules(permissions.ask ?? [], [])
  );
}

export function getAgyAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveAgyBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    return { available: false, detail: versionStatus.detail, binary };
  }
  return { available: true, detail: versionStatus.detail, binary };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

/**
 * `agy models` needs a signed-in account and spends no model quota: signed out
 * it exits 1 with "Please sign in to view available models" (measured on
 * macOS, agy 1.3.5). It runs inside the plugin's agy home, so a pass also
 * shows that the account is visible from there.
 *
 * agy rewrites its settings file when it starts, so the probe takes the same
 * lock as a run and leaves the read-only profile in place.
 */
export async function runModelsProbe(cwd, options = {}) {
  const env = options.env ?? process.env;
  const binary = options.binary ?? resolveAgyBinary(env);
  const home = options.home ?? resolveAgyHome(env);
  const platform = options.platform ?? process.platform;

  const lock = await acquireAgyHomeLock(home, { waitMs: options.lockWaitMs });
  let result;
  try {
    prepareAgyHome(home, "read-only", { realHome: options.realHome, model: options.userModel });
    result = runCommand(binary, ["models"], {
      cwd,
      env: agyChildEnv(env, home, platform),
      stdio: ["ignore", "pipe", "pipe"]
    });
  } finally {
    lock.release();
  }

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({ available: false, detail: `${binary} binary not found`, source: "availability" });
  }
  if (result.error) {
    return buildAuthStatus({ detail: result.error.message });
  }

  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/please sign in|authentication required|not signed in|not logged in/i.test(combined)) {
    return buildAuthStatus({
      detail: "not signed in; run `agy` once in a terminal and complete the Google sign-in"
    });
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({ detail: firstLine(detail) || "models probe failed" });
  }

  const models = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("\t")[0].trim())
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
  return buildAuthStatus({
    loggedIn: models.length > 0,
    detail: models.length > 0 ? `signed in; ${models.length} models available` : "models probe returned no models",
    authMethod: models.length > 0 ? "google-account" : null,
    verified: models.length > 0,
    models
  });
}

export async function getAgyAuthStatus(cwd, options = {}) {
  const availability = getAgyAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

// Flag values reach the child as separate argv entries, so a value that starts
// with `-` would be read by agy's own parser as another flag. Every value that
// goes next to a flag is checked before it is pushed.
const VALUE_PATTERNS = {
  model: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  mode: /^(plan)$/,
  effort: /^(low|medium|high|xhigh|max)$/,
  conversation: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  outputFormat: /^(text|json|stream-json)$/,
  timeout: /^(0|[1-9][0-9]{0,5}(s|m|h))$/
};

export function assertSafeCliValue(kind, value) {
  const text = String(value ?? "");
  const pattern = VALUE_PATTERNS[kind];
  if (!pattern || !pattern.test(text)) {
    throw new Error(`Refusing to pass an unsafe ${kind} value to agy: ${JSON.stringify(value)}`);
  }
  return text;
}

/** A path is free-form, but it must never look like a flag. */
export function assertSafePath(value, kind = "path") {
  const text = String(value ?? "");
  if (!text || text.startsWith("-") || /[\r\n\0]/.test(text)) {
    throw new Error(`Refusing to pass an unsafe ${kind} to agy: ${JSON.stringify(value)}`);
  }
  return text;
}

/**
 * The prompt travels as `-p=<prompt>`, one argv entry. The attached form
 * matters: with `-p <prompt>` agy refuses a prompt that starts with `-`
 * (exit 2, "-p took ... as its prompt").
 */
export function assertSafePrompt(value) {
  const text = String(value ?? "");
  if (!text.trim()) {
    throw new Error("A prompt is required for this agy run.");
  }
  if (text.includes("\0")) {
    throw new Error("Refusing to pass a prompt containing a NUL byte to agy.");
  }
  return text;
}

/**
 * Build the argv for a headless agy run.
 *
 * Differences from the other coding CLIs that matter here:
 * - there is no working-directory flag: the directory agy starts in is the workspace
 * - the prompt has to be on the command line (stdin is ignored)
 * - read-only is not a mode: it is the permission profile in the plugin's home
 * - structured output has a real flag, `--json-schema`, with the parsed object
 *   reported back as `structured_output`
 * - `--print-timeout` returns partial output with exit 0 when it fires
 */
export function buildHeadlessArgs(options = {}) {
  if (options.write && options.mode) {
    // `plan` never edits. Asking for edits and for plan at once is a
    // contradiction, and picking one silently is how intent gets lost.
    throw new Error(`Refusing to run with both --mode ${options.mode} and write access.`);
  }

  const args = [`-p=${assertSafePrompt(options.promptArg)}`];
  args.push("--output-format", assertSafeCliValue("outputFormat", options.outputFormat || "stream-json"));

  if (options.resumeConversationId) {
    args.push("--conversation", assertSafeCliValue("conversation", options.resumeConversationId));
  }
  if (options.mode) {
    args.push("--mode", assertSafeCliValue("mode", options.mode));
  }
  if (options.model) {
    args.push("--model", assertSafeCliValue("model", options.model));
  }
  if (options.effort) {
    args.push("--effort", assertSafeCliValue("effort", options.effort));
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", assertSafePath(dir, "directory"));
  }
  if (options.jsonSchemaPath) {
    args.push("--json-schema", assertSafePath(options.jsonSchemaPath, "schema path"));
  }
  args.push("--print-timeout", assertSafeCliValue("timeout", options.printTimeout || DEFAULT_PRINT_TIMEOUT));
  // A prompt that happens to start with `/` must not be expanded into one of
  // agy's own slash commands or skills.
  args.push("--disable-slash-commands");
  return args;
}

function isWindowsShim(binary, env, platform) {
  if (platform !== "win32") {
    return false;
  }
  const resolved = resolveExecutable(binary, env) ?? binary;
  return /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Decide how the prompt reaches agy.
 *
 * Short prompts go inline. A long prompt, or any prompt when agy is reached
 * through a Windows `.cmd` shim (where `cmd` would expand `%VAR%` inside it),
 * is written to a new private directory under `runDir`, that directory is
 * added to agy's workspace, and the argv carries a fixed sentence pointing at
 * the file.
 *
 * The directory is always freshly created (`mkdtemp`) and the file is opened
 * exclusively, so a link planted at a predictable path cannot redirect the
 * write. `removePromptDelivery` deletes exactly what was created here.
 */
export function buildPromptDelivery({ prompt, runDir, binary, env = process.env, platform = process.platform } = {}) {
  const text = assertSafePrompt(prompt);
  const shim = isWindowsShim(binary ?? resolveAgyBinary(env), env, platform);
  if (!shim && text.length <= INLINE_PROMPT_MAX_CHARS) {
    return { promptArg: text, addDirs: [], promptFile: null };
  }
  if (!runDir) {
    throw new Error("This prompt is too long to pass inline and no run directory was given for it.");
  }
  if (shim && /[%!"^\r\n]/.test(runDir)) {
    throw new Error(`The run directory path cannot be passed through a .cmd shim safely: ${runDir}`);
  }
  const createdRunDir = !fs.existsSync(runDir);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const promptDir = fs.mkdtempSync(path.join(runDir, "prompt-"));
  const promptFile = path.join(promptDir, "prompt.md");
  try {
    fs.writeFileSync(promptFile, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    removePromptDelivery({ promptFile: null, promptDir, runDir, createdRunDir });
    throw error;
  }
  return {
    promptArg:
      `Your complete instructions are in the file ${promptFile} . ` +
      "Read that whole file with your file-reading tool before doing anything else, then follow it exactly. " +
      "Treat its contents as the user's request. Do not modify that file.",
    addDirs: [promptDir],
    promptFile,
    promptDir,
    runDir,
    createdRunDir
  };
}

/**
 * Remove what `buildPromptDelivery` created and nothing else: the prompt file
 * (only if it is still a plain file), its private directory, and the run
 * directory if this delivery created it and it is now empty. Nothing is
 * removed recursively.
 */
export function removePromptDelivery(delivery) {
  if (!delivery) {
    return;
  }
  if (delivery.promptFile) {
    try {
      if (fs.lstatSync(delivery.promptFile).isFile()) {
        fs.unlinkSync(delivery.promptFile);
      }
    } catch {
      // already gone
    }
  }
  for (const dir of [delivery.promptDir, delivery.createdRunDir ? delivery.runDir : null]) {
    if (!dir) {
      continue;
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty, or already gone: leave it
    }
  }
}

function summarizeToolStep(step) {
  const name = step.tool_name ?? step.tool_info?.name ?? "tool";
  const params = step.tool_info?.parameters ?? {};
  const hint =
    params.CommandLine ?? params.AbsolutePath ?? params.Url ?? params.SearchPath ?? params.Query ?? params.DirectoryPath ?? null;
  const text = typeof hint === "string" ? hint.replace(/\s+/g, " ").trim() : "";
  if (name === "run_command") {
    return `Running command: ${text.slice(0, 160)}`;
  }
  return text ? `Running tool: ${name} ${text.slice(0, 160)}` : `Running tool: ${name}`;
}

/**
 * Spawn one headless agy run and collect its `stream-json` events.
 *
 * Exit status and `status: SUCCESS` do not mean success with agy: a refused
 * permission, a fired `--print-timeout` and an unknown `--conversation` id all
 * exit 0 with `SUCCESS`. `judgeAgyRun` turns the collected events into the
 * list of reasons a run actually failed.
 */
export async function runHeadlessAgent(cwd, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const binary = options.binary ?? resolveAgyBinary(env);
  const home = options.agyHome ?? resolveAgyHome(env);
  const profileName = options.permissionProfile ?? "read-only";
  if (!PERMISSION_PROFILES[profileName]) {
    throw new Error(`Unknown permission profile: ${JSON.stringify(profileName)}`);
  }

  // A caller that does not supply a run directory gets prompt files under the
  // system temp directory; either way only what this run created is removed.
  let delivery = null;
  const removeOwnRunDir = () => removePromptDelivery(delivery);
  let args;
  let lock;
  try {
    delivery = buildPromptDelivery({
      prompt: options.prompt,
      runDir: options.runDir ?? path.join(os.tmpdir(), "agy-cc-prompts"),
      binary,
      env,
      platform
    });
    args = buildHeadlessArgs({
      ...options,
      promptArg: delivery.promptArg,
      addDirs: [...(options.addDirs ?? []), ...delivery.addDirs],
      outputFormat: "stream-json"
    });
    lock = await acquireAgyHomeLock(home, { waitMs: options.lockWaitMs });
  } catch (error) {
    removeOwnRunDir();
    throw error;
  }

  let released = false;
  const releaseLock = () => {
    if (!released) {
      released = true;
      lock.release();
    }
  };

  try {
    prepareAgyHome(home, profileName, { realHome: options.realHome, model: options.userModel });
  } catch (error) {
    releaseLock();
    removeOwnRunDir();
    throw error;
  }

  const detached = options.detached ?? platform !== "win32";
  const maxOutputBytes = options.maxOutputBytes ?? MAX_AGENT_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCli(binary, args, {
        cwd,
        env: agyChildEnv(env, home, platform),
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        windowsHide: true
      });
    } catch (error) {
      releaseLock();
      removeOwnRunDir();
      reject(error);
      return;
    }

    // agy reads its settings once at start-up, so the lock only has to cover
    // the window until `init`. A run that never gets there is killed, and the
    // lock is released only once it has exited, so a late start-up can never
    // read a profile meant for another run.
    let startupTimedOut = false;
    const startupTimer = setTimeout(() => {
      if (!init) {
        startupTimedOut = true;
        stopChild();
      }
    }, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running agy (${binary}).`, "starting", {
      threadId: options.resumeConversationId ?? null,
      agentPid,
      pid: agentPid
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let lineBuffer = "";
    let init = null;
    let conversationId = null;
    let finalResult = null;
    let partialText = "";
    let permissionMismatch = null;
    let settingsMismatch = false;
    let authRequired = false;
    let killedByBridge = false;

    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk;
      if (next.length <= maxOutputBytes) {
        return next;
      }
      truncated = true;
      return next.slice(0, maxOutputBytes);
    };

    // The whole tree goes: through a Windows `.cmd` shim the real process is a
    // grandchild that would otherwise keep our pipes open.
    const stopChild = () => {
      if (killedByBridge) {
        return;
      }
      killedByBridge = true;
      try {
        terminateProcessTree(agentPid, { platform });
      } catch {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    };

    const handleEvent = (event) => {
      if (event?.event === "init") {
        if (init) {
          return;
        }
        clearTimeout(startupTimer);
        init = event.init ?? {};
        conversationId = event.conversation_id ?? init.conversation_id ?? conversationId;
        if (init.permission_mode !== EXPECTED_PERMISSION_MODE) {
          // The profile this run was promised is not the one agy loaded.
          permissionMismatch = String(init.permission_mode ?? "unknown");
          stopChild();
          return;
        }
        // Still under the lock: what agy wrote back is what it loaded.
        if (!settingsMatchProfile(resolveAgySettingsFile(home), profileName)) {
          settingsMismatch = true;
          stopChild();
          return;
        }
        releaseLock();
        emitProgress(options.onProgress, `agy conversation ${conversationId} (model ${init.model ?? "default"}).`, "running", {
          threadId: conversationId,
          agentPid
        });
        return;
      }
      if (!init) {
        // Nothing counts before agy has said how it started.
        return;
      }
      if (event?.event === "result") {
        finalResult = event.result ?? null;
        conversationId = finalResult?.conversation_id || conversationId;
        return;
      }
      const step = event?.step_update;
      if (!step) {
        return;
      }
      if (typeof step.text_delta === "string" && step.step_type === "agent_response") {
        partialText = append(partialText, step.text_delta);
      }
      if (step.state === "ACTIVE" && step.step_type === "tool") {
        emitProgress(options.onProgress, summarizeToolStep(step), "investigating", { threadId: conversationId });
      } else if (step.state === "ACTIVE" && step.step_type === "subagent") {
        emitProgress(options.onProgress, "Subagent started.", "investigating", { threadId: conversationId });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      lineBuffer += chunk;
      let newline = lineBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.startsWith("{")) {
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // not an event line
          }
        }
        newline = lineBuffer.indexOf("\n");
      }
      if (lineBuffer.length > maxOutputBytes) {
        lineBuffer = "";
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (!authRequired && /Authentication required/i.test(stderr)) {
        // agy waits about a minute for a browser sign-in that a headless run
        // can never complete.
        authRequired = true;
        stopChild();
      }
    });

    child.on("error", (error) => {
      clearTimeout(startupTimer);
      releaseLock();
      removeOwnRunDir();
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      releaseLock();
      removeOwnRunDir();
      const tail = lineBuffer.trim();
      if (tail.startsWith("{")) {
        try {
          handleEvent(JSON.parse(tail));
        } catch {
          // incomplete last line
        }
      }

      const status = code ?? (signal ? 1 : 0);
      const response = typeof finalResult?.response === "string" ? finalResult.response : partialText;
      const run = {
        status,
        signal,
        stdout,
        stderr,
        truncated,
        conversationId,
        threadId: conversationId,
        agentPid,
        init,
        result: finalResult,
        finalMessage: String(response ?? "").trimEnd(),
        structuredOutput: finalResult?.structured_output ?? null,
        deniedActions: Array.isArray(finalResult?.denied_actions) ? finalResult.denied_actions : [],
        timedOut: /print timeout after/i.test(stderr),
        authRequired,
        permissionMismatch,
        settingsMismatch,
        startupTimedOut,
        killedByBridge,
        resumeConversationId: options.resumeConversationId ?? null,
        printTimeout: options.printTimeout || DEFAULT_PRINT_TIMEOUT,
        args,
        binary,
        home,
        permissionProfile: profileName,
        promptFile: delivery.promptFile
      };
      run.failures = judgeAgyRun(run, { requireResponse: options.requireResponse !== false });

      emitProgress(
        options.onProgress,
        run.failures.length === 0 ? "agy finished." : `agy run failed: ${run.failures[0]}`,
        run.failures.length === 0 ? "finalizing" : "failed",
        { threadId: conversationId, agentPid }
      );
      resolve(run);
    });
  });
}

function formatDeniedActions(actions) {
  return actions
    .map((entry) => [entry?.action, entry?.display_name].filter(Boolean).join("/"))
    .filter(Boolean)
    .join(", ");
}

/** Every reason this run did not produce a usable answer. Empty means success. */
export function judgeAgyRun(run, options = {}) {
  const failures = [];
  if (run.authRequired) {
    failures.push("agy is not signed in. Run `agy` once in a terminal, finish the Google sign-in, then rerun /agy-cc:check.");
    return failures;
  }
  if (run.permissionMismatch) {
    failures.push(
      `agy started in permission mode "${run.permissionMismatch}" instead of "${EXPECTED_PERMISSION_MODE}", so the plugin's permission profile was not in effect. The run was stopped.`
    );
    return failures;
  }
  if (run.settingsMismatch) {
    failures.push(
      "The permission rules agy loaded were not this run's profile (another run changed the plugin's agy settings while this one started). The run was stopped; run it again."
    );
    return failures;
  }
  if (run.startupTimedOut) {
    failures.push("agy did not start within 90 seconds and was stopped.");
    return failures;
  }
  if (!run.init) {
    failures.push("agy never reported its start-up event, so the run's permissions could not be checked.");
  }
  if (run.resumeConversationId) {
    const missing = new RegExp(`conversation\\s+"?${escapeRegExp(run.resumeConversationId)}"?\\s+not found`, "i").test(
      run.stderr ?? ""
    );
    if (missing || (run.conversationId && run.conversationId !== run.resumeConversationId)) {
      failures.push(
        `agy could not find conversation ${run.resumeConversationId} in the plugin's agy home and started a new one instead. Start a fresh run.`
      );
    }
  }
  if (run.status !== 0) {
    const detail = firstLine(run.result?.error) || firstLine(run.stderr) || "";
    failures.push(`agy exited with status ${run.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!run.result) {
    failures.push("agy did not report a final result.");
  } else if (run.result.status !== "SUCCESS") {
    failures.push(`agy reported status ${run.result.status}${run.result.error ? `: ${firstLine(run.result.error)}` : ""}`);
  }
  if (run.timedOut) {
    failures.push(`agy hit its --print-timeout (${run.printTimeout}) and returned partial output.`);
  }
  if (run.deniedActions?.length) {
    failures.push(
      `agy needed a permission this run does not grant and stopped: ${formatDeniedActions(run.deniedActions)}.`
    );
  }
  if (options.requireResponse !== false && run.result && !String(run.finalMessage ?? "").trim() && !run.structuredOutput) {
    failures.push("agy returned an empty response.");
  }
  return failures;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Only a refused permission is worth one automatic follow-up turn, and only
 * when it is the run's sole problem: a lost conversation, a failed status or a
 * timeout must stay failures rather than be papered over by a second turn.
 */
function isRecoverable(run) {
  if (!run.init || !run.conversationId || run.status !== 0 || run.result?.status !== "SUCCESS") {
    return false;
  }
  if (run.authRequired || run.permissionMismatch || run.settingsMismatch || run.startupTimedOut || run.timedOut) {
    return false;
  }
  if (run.resumeConversationId && run.conversationId !== run.resumeConversationId) {
    return false;
  }
  if (/conversation\s+"?[^"\s]+"?\s+not found/i.test(run.stderr ?? "")) {
    return false;
  }
  return run.deniedActions.length > 0;
}

export function buildRecoveryPrompt(run) {
  return [
    `Your previous step needed a permission this session does not have (${formatDeniedActions(run.deniedActions)}), so it was refused automatically.`,
    "That permission will stay refused for the rest of this session. Do not try that action again.",
    "Continue the original task using only what you are still allowed to do: read files inside the workspace and use the context you already have.",
    "Then give your final answer in full."
  ].join(" ");
}

/**
 * Run agy, and when a turn ends only because a permission had to be asked for
 * (headless mode auto-denies those and ends the turn with nothing), continue
 * the same conversation once with an instruction to work without it. The
 * bridge fixes this itself instead of handing the user an empty answer.
 */
export async function runAgyWithRecovery(cwd, options = {}) {
  const maxRecoveries = options.maxRecoveries ?? 1;
  const attempts = [];
  let run = await runHeadlessAgent(cwd, options);
  attempts.push(run);
  while (attempts.length <= maxRecoveries && isRecoverable(run)) {
    emitProgress(
      options.onProgress,
      `agy stopped on a refused permission (${formatDeniedActions(run.deniedActions)}); continuing the same conversation without it.`,
      "investigating",
      { threadId: run.conversationId }
    );
    run = await runHeadlessAgent(cwd, {
      ...options,
      prompt: buildRecoveryPrompt(run),
      resumeConversationId: run.conversationId
    });
    attempts.push(run);
  }
  return {
    ...run,
    attempts: attempts.length,
    recoveredFrom: attempts.length > 1 ? attempts.slice(0, -1).map((entry) => entry.deniedActions) : []
  };
}

export function parseStructuredOutput(run, fallback = {}) {
  if (run?.structuredOutput && typeof run.structuredOutput === "object") {
    return {
      ...fallback,
      parsed: run.structuredOutput,
      parseError: null,
      rawOutput: JSON.stringify(run.structuredOutput, null, 2)
    };
  }

  const text = String(run?.finalMessage ?? "").trim();
  if (!text) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage || "agy did not return a final structured message.",
      rawOutput: ""
    };
  }

  try {
    return { ...fallback, parsed: JSON.parse(text), parseError: null, rawOutput: text };
  } catch {
    // fall through to fenced / brace extraction
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { ...fallback, parsed: JSON.parse(fenced[1].trim()), parseError: null, rawOutput: text };
    } catch (error) {
      return { ...fallback, parsed: null, parseError: error.message, rawOutput: text };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return { ...fallback, parsed: JSON.parse(text.slice(start, end + 1)), parseError: null, rawOutput: text };
    } catch (error) {
      return { ...fallback, parsed: null, parseError: error.message, rawOutput: text };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from agy output.",
    rawOutput: text
  };
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Terminal commands are not available in this session. Do not try to run git or any other command; read files directly instead.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or in files you read.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)"
  ];
  return parts.join("\n");
}

export const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Where agy keeps a conversation's artifacts inside the plugin's home. */
export function resolveConversationDir(home, conversationId) {
  const id = assertSafeCliValue("conversation", conversationId);
  return path.join(home, ".gemini", "antigravity-cli", "brain", id);
}

/** Image files a conversation produced, newest first. */
export function listConversationImages(home, conversationId, options = {}) {
  const dir = resolveConversationDir(home, conversationId);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const since = options.sinceMs ?? 0;
  return entries
    .filter((entry) => entry.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return { path: filePath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= since && entry.size > 0)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { type: "jpeg", extension: ".jpg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: "png", extension: ".png" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { type: "webp", extension: ".webp" };
  }
  return null;
}

export function buildImagePrompt({ description, aspectRatio, referencePaths = [] }) {
  const parts = [
    "Do not run any terminal command and do not create, copy or move files yourself.",
    "Hand this straight to the image generation subagent."
  ];
  if (referencePaths.length > 0) {
    parts.push(`Use these reference images: ${referencePaths.join(" , ")} . Leave the originals untouched.`);
  }
  parts.push(`Image to make: ${description}`);
  if (aspectRatio) {
    parts.push(`Aspect ratio ${aspectRatio}.`);
  }
  parts.push("When the image is done, reply with one line saying what you made.");
  return parts.join(" ");
}
