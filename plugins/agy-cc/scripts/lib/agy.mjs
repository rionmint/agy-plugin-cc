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

/** How long agy may take to report `init` before the run is killed. */
export const STARTUP_TIMEOUT_MS = 90000;

/**
 * The permission mode every bridge run must start in. It is what the plugin's
 * own settings files ask for; anything else means the settings were not the
 * ones agy loaded, and the run is stopped.
 */
export const EXPECTED_PERMISSION_MODE = "request-review";

/**
 * agy's tool permissions live in a settings file in its home directory
 * (`~/.gemini/antigravity-cli/settings.json`), and the CLI has no flag that
 * overrides them for one run. A user who picked `always-proceed` there would
 * turn every "read-only" review into a run that executes commands — `--mode
 * plan` included, which was measured running `run_command` under that setting.
 *
 * So the bridge never uses the user's agy home. Each profile below has a home
 * directory of its own, and that home's settings file only ever holds that
 * profile. Nothing is swapped in and out of a shared file, so concurrent runs
 * cannot hand each other the wrong permissions and need no lock. Credentials are
 * not stored in the home directory on Windows, so the signed-in account still
 * applies.
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
    allow: Object.freeze(["read_url(*)"]),
    deny: Object.freeze(["write_file(*)", "command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"])
  }),
  write: Object.freeze({
    allow: Object.freeze(["read_url(*)"]),
    deny: Object.freeze(["command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"])
  }),
  "write-commands": Object.freeze({
    allow: Object.freeze(["read_url(*)", "command(*)"]),
    deny: Object.freeze(["execute_url(*)", "mcp(*)"])
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

function assertProfile(profileName) {
  if (!Object.prototype.hasOwnProperty.call(PERMISSION_PROFILES, profileName)) {
    throw new Error(`Unknown permission profile: ${JSON.stringify(profileName)}`);
  }
  return profileName;
}

export function resolveAgyBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

/** The directory that holds one agy home per permission profile. */
export function resolveAgyHomeRoot(env = process.env) {
  const override = env?.[HOME_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  const pluginData = env?.[PLUGIN_DATA_ENV];
  if (pluginData && String(pluginData).trim()) {
    return path.join(String(pluginData).trim(), "agy-homes");
  }
  return path.join(os.tmpdir(), "agy-cc-homes");
}

/** The agy home a run with this permission profile uses. */
export function resolveAgyHome(profileName = "read-only", env = process.env) {
  return path.join(resolveAgyHomeRoot(env), assertProfile(profileName));
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
  const profile = PERMISSION_PROFILES[assertProfile(profileName)];
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

// agy drops a key from its settings file when the value is the default, so a
// file it has rewritten is compared with these filled back in.
const SETTING_DEFAULTS = Object.freeze({
  toolPermission: "request-review",
  allowNonWorkspaceAccess: false,
  useG1Credits: false,
  showFeedbackSurvey: true,
  showTips: true,
  artifactReviewPolicy: "asks-for-review"
});

// Every key agy 1.3.5 documents for this file. A key outside this list is not
// something the bridge put there and may change behaviour it cannot judge, so
// a file that has one never counts as a profile match.
const KNOWN_SETTING_KEYS = new Set([
  "colorScheme",
  "altScreenMode",
  "toolPermission",
  "artifactReviewPolicy",
  "notifications",
  "showTips",
  "showFeedbackSurvey",
  "editor",
  "editorMode",
  "vimInsertFirst",
  "allowNonWorkspaceAccess",
  "enableTerminalSandbox",
  "useG1Credits",
  "enableTelemetry",
  "verbosity",
  "runningLightSpeed",
  "model",
  "permissions"
]);

const PERMISSION_KEYS = new Set(["allow", "deny", "ask"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRuleList(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((rule) => typeof rule === "string")) {
    return null;
  }
  return [...new Set(value)].sort();
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The settings that decide what a run may do, with agy's defaults filled in,
 * plus every other key as it is. Returns null for anything malformed: an
 * unknown key, an explicit null, a value of the wrong type.
 */
function effectiveSettings(settings) {
  if (!isPlainObject(settings)) {
    return null;
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!KNOWN_SETTING_KEYS.has(key) || value === null) {
      return null;
    }
  }
  const permissions = settings.permissions === undefined ? {} : settings.permissions;
  if (!isPlainObject(permissions) || Object.keys(permissions).some((key) => !PERMISSION_KEYS.has(key))) {
    return null;
  }
  const allow = asRuleList(permissions.allow);
  const deny = asRuleList(permissions.deny);
  const ask = asRuleList(permissions.ask);
  if (!allow || !deny || !ask) {
    return null;
  }
  const effective = { ...settings, allow, deny, ask };
  delete effective.permissions;
  for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
    const value = settings[key] === undefined ? fallback : settings[key];
    if (typeof value !== typeof fallback) {
      return null;
    }
    effective[key] = value;
  }
  if (settings.model !== undefined && typeof settings.model !== "string") {
    return null;
  }
  return effective;
}

function sameEffective(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!sameList(a, b)) {
        return false;
      }
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

function readSettingsFileStrict(settingsFile) {
  const stat = fs.lstatSync(settingsFile);
  if (!stat.isFile()) {
    // A link (or anything else) in place of the file is not ours to trust.
    return undefined;
  }
  return readJsonFile(settingsFile);
}

/**
 * True when the settings file holds exactly this profile's permissions, the
 * base mode the bridge expects, and nothing the bridge does not recognise.
 * Never throws: an unreadable, linked or malformed file is simply not a match.
 */
export function settingsMatchProfile(settingsFile, profileName) {
  try {
    const profile = PERMISSION_PROFILES[assertProfile(profileName)];
    const effective = effectiveSettings(readSettingsFileStrict(settingsFile));
    if (!effective) {
      return false;
    }
    return (
      effective.toolPermission === EXPECTED_PERMISSION_MODE &&
      effective.allowNonWorkspaceAccess === false &&
      effective.artifactReviewPolicy === SETTING_DEFAULTS.artifactReviewPolicy &&
      sameList(effective.allow, asRuleList(profile.allow)) &&
      sameList(effective.deny, asRuleList(profile.deny)) &&
      effective.ask.length === 0
    );
  } catch {
    return false;
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  // rename replaces the directory entry itself, so a link standing in place of
  // the file is replaced rather than written through.
  fs.renameSync(tempPath, filePath);
}

function assertRealDirectory(dirPath, what) {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to use ${what} ${dirPath}: it is a link or not a directory.`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing to use ${what} ${dirPath}: it belongs to another user.`);
  }
  return stat;
}

/**
 * The isolation rests on each profile's home being its own directory. A home
 * root, home or settings folder that is a link (a symlink, or a junction on
 * Windows) could make two profiles share one settings file again, so any link
 * on that path, any directory owned by someone else, or two profile homes that
 * are physically the same directory, stops the run.
 */
export function assertPrivateHomes(homeRoot) {
  fs.mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  assertRealDirectory(homeRoot, "the agy home root");
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(homeRoot, 0o700);
    } catch {
      // checked above that it is ours; best effort
    }
  }
  const seen = new Map();
  for (const profileName of Object.keys(PERMISSION_PROFILES)) {
    const home = path.join(homeRoot, profileName);
    let current = home;
    for (const part of ["", ".gemini", "antigravity-cli"]) {
      current = part ? path.join(current, part) : current;
      if (!fs.existsSync(current) && !isLink(current)) {
        break;
      }
      const stat = assertRealDirectory(current, `the ${profileName} agy home`);
      if (!part) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (seen.has(identity)) {
          throw new Error(`Refusing to run: the ${profileName} and ${seen.get(identity)} agy homes are the same directory.`);
        }
        seen.set(identity, profileName);
      }
    }
  }
}

function isLink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Make sure a profile's agy home exists and its settings hold that profile.
 *
 * The file is only rewritten when it differs: any difference in a setting,
 * any key the bridge did not write, or a link where the file should be. agy
 * itself rewrites the file atomically, and leaves it alone once it is in its
 * normalised form (both measured), so in the steady state nobody writes it at
 * all; when the bridge does write, it writes atomically too. A reader can
 * therefore never see a half-written file, and since every writer of this home
 * writes the same profile, never another profile either.
 *
 * The home also gets a `.gitconfig` that includes the user's own, because agy
 * passes its home on to the commands it runs and git would otherwise lose the
 * user's name, email and safe directories.
 */
export function prepareAgyHome(home, profileName, options = {}) {
  assertProfile(profileName);
  assertPrivateHomes(path.dirname(home));
  const settingsFile = resolveAgySettingsFile(home);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  assertPrivateHomes(path.dirname(home));
  const realHome = options.realHome ?? os.homedir();
  const model = options.model === undefined ? readUserAgyModel(realHome) : options.model;
  const desired = buildAgySettings(profileName, { model });

  let current = null;
  try {
    current = effectiveSettings(readSettingsFileStrict(settingsFile));
  } catch {
    current = null;
  }
  if (!current || !sameEffective(current, effectiveSettings(desired))) {
    writeFileAtomic(settingsFile, `${JSON.stringify(desired, null, 2)}\n`);
  }

  const gitconfig = path.join(home, ".gitconfig");
  const realGitconfig = path.join(realHome, ".gitconfig").replace(/\\/g, "/");
  if (path.resolve(realHome) !== path.resolve(home) && !fs.existsSync(gitconfig) && !isLink(gitconfig) && !/[\r\n"]/.test(realGitconfig)) {
    try {
      fs.writeFileSync(gitconfig, `[include]\n\tpath = ${realGitconfig}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      // git still works without it, only without the user's identity
    }
  }
  return settingsFile;
}

function conversationFiles(home, conversationId) {
  const id = assertSafeCliValue("conversation", conversationId);
  const base = path.join(home, ".gemini", "antigravity-cli");
  return {
    id,
    base,
    db: path.join(base, "conversations", `${id}.db`),
    brain: path.join(base, "brain", id),
    annotation: path.join(base, "annotations", `${id}.pbtxt`)
  };
}

/** When a conversation database last changed; -1 when there is no plain file. */
function databaseWrittenMs(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() ? stat.mtimeMs : -1;
  } catch {
    return -1;
  }
}

function journalOf(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`].filter((candidate) => fs.existsSync(candidate) || isLink(candidate));
}

function assertNoLinksInTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy a conversation that contains a link: ${root}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) {
      assertNoLinksInTree(path.join(root, entry));
    }
  } else if (!stat.isFile()) {
    throw new Error(`Refusing to copy a conversation entry that is not a plain file: ${root}`);
  }
}

function replaceFileFrom(source, target) {
  const staged = `${target}.agy-cc-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  const { atime, mtime } = fs.statSync(source);
  fs.utimesSync(staged, atime, mtime);
  fs.renameSync(staged, target);
}

/**
 * Make the newest copy of a conversation available in `targetHome`.
 *
 * agy keeps a conversation in its home directory (`conversations/<id>.db`, the
 * `brain/<id>` artifacts and `annotations/<id>.pbtxt`), and a copy of those in
 * another home resumes there (measured). A read-only investigation continued
 * with `--write` therefore moves its conversation into the write profile's
 * home first.
 *
 * The copy is refused while either side has a SQLite journal next to the
 * database (agy has it open, or was killed mid-write), and when anything in it
 * is a link or not a plain file. Artifacts are copied to a staging directory
 * and swapped in, and the database — the file whose time decides which copy is
 * newest — is replaced last, atomically and with the source's timestamp, so a
 * copy that fails half-way leaves the source still the newest and is redone on
 * the next attempt.
 *
 * Returns the home the conversation was copied from, or null when the target
 * already had the newest copy or none exists.
 */
export function syncConversationInto(homeRoot, targetHome, conversationId) {
  const target = conversationFiles(targetHome, conversationId);
  let newestHome = null;
  let newestMs = databaseWrittenMs(target.db);
  for (const profileName of Object.keys(PERMISSION_PROFILES)) {
    const home = path.join(homeRoot, profileName);
    if (path.resolve(home) === path.resolve(targetHome)) {
      continue;
    }
    const written = databaseWrittenMs(conversationFiles(home, conversationId).db);
    if (written > newestMs) {
      newestMs = written;
      newestHome = home;
    }
  }
  if (!newestHome) {
    return null;
  }

  const source = conversationFiles(newestHome, conversationId);
  for (const dbPath of [source.db, target.db]) {
    if (journalOf(dbPath).length > 0) {
      throw new Error(
        `Conversation ${target.id} looks open in another agy run (a SQLite journal sits next to ${dbPath}). Wait for that run to finish, or start a fresh conversation.`
      );
    }
  }
  assertNoLinksInTree(source.db);
  const hasBrain = fs.existsSync(source.brain) || isLink(source.brain);
  const hasAnnotation = fs.existsSync(source.annotation) || isLink(source.annotation);
  if (hasBrain) {
    assertNoLinksInTree(source.brain);
  }
  if (hasAnnotation) {
    assertNoLinksInTree(source.annotation);
  }

  for (const dir of [path.dirname(target.db), path.dirname(target.brain), path.dirname(target.annotation)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertRealDirectory(dir, "a conversation directory");
  }

  if (hasBrain) {
    const staged = fs.mkdtempSync(path.join(path.dirname(target.brain), `.${target.id}.staging-`));
    fs.cpSync(source.brain, staged, { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true });
    let aside = null;
    if (fs.existsSync(target.brain) || isLink(target.brain)) {
      aside = `${target.brain}.agy-cc-old-${Math.random().toString(36).slice(2, 8)}`;
      fs.renameSync(target.brain, aside);
    }
    fs.renameSync(staged, target.brain);
    if (aside) {
      fs.rmSync(aside, { recursive: true, force: true });
    }
  }
  if (hasAnnotation) {
    replaceFileFrom(source.annotation, target.annotation);
  }
  replaceFileFrom(source.db, target.db);
  return newestHome;
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
 * macOS, agy 1.3.5). It runs inside the read-only profile's home, so a pass
 * also shows that the account is visible from the plugin's homes.
 */
export async function runModelsProbe(cwd, options = {}) {
  const env = options.env ?? process.env;
  const binary = options.binary ?? resolveAgyBinary(env);
  const home = options.home ?? resolveAgyHome("read-only", env);
  const platform = options.platform ?? process.platform;

  prepareAgyHome(home, "read-only", { realHome: options.realHome, model: options.userModel });
  const result = runCommand(binary, ["models"], {
    cwd,
    env: agyChildEnv(env, home, platform),
    stdio: ["ignore", "pipe", "pipe"]
  });

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

// Progress is best effort. A reporter that throws (a full disk under the run
// log, say) must not abort a run half-way, after agy has been spawned and
// before its exit is being watched.
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  try {
    if (!phase && Object.keys(extra).length === 0) {
      onProgress(message);
      return;
    }
    onProgress({ message, phase, ...extra });
  } catch {
    // ignored on purpose
  }
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
  if (!pattern || !pattern.test(text) || text.includes("..")) {
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
 * - read-only is not a mode: it is the permission profile of the agy home
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

function fileIdentity(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), isDirectory: stat.isDirectory(), isFile: stat.isFile() };
}

function sameIdentity(filePath, identity) {
  try {
    const current = fileIdentity(filePath);
    return (
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.isDirectory === identity.isDirectory &&
      current.isFile === identity.isFile
    );
  } catch {
    return false;
  }
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
 * write. Both are remembered by device and inode, and `removePromptDelivery`
 * only deletes them while they are still those exact objects.
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
  const runDirIdentity = createdRunDir ? fileIdentity(runDir) : null;
  const promptDir = fs.mkdtempSync(path.join(runDir, "prompt-"));
  const promptDirIdentity = fileIdentity(promptDir);
  const promptFile = path.join(promptDir, "prompt.md");
  const delivery = {
    promptArg: null,
    addDirs: [promptDir],
    promptFile: null,
    promptFileIdentity: null,
    promptDir,
    promptDirIdentity,
    runDir,
    runDirIdentity
  };
  try {
    fs.writeFileSync(promptFile, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    removePromptDelivery(delivery);
    throw error;
  }
  delivery.promptFile = promptFile;
  delivery.promptFileIdentity = fileIdentity(promptFile);
  delivery.promptArg =
    `Your complete instructions are in the file ${promptFile} . ` +
    "Read that whole file with your file-reading tool before doing anything else, then follow it exactly. " +
    "Treat its contents as the user's request. Do not modify that file.";
  return delivery;
}

/**
 * Remove what `buildPromptDelivery` created and nothing else. Every path is
 * checked to still be the very file or directory that was created (same device
 * and inode, not a link) before it is touched, the parent directory before the
 * file inside it; anything that has changed is left where it is. Nothing is
 * removed recursively.
 */
export function removePromptDelivery(delivery) {
  if (!delivery?.promptDir || !delivery.promptDirIdentity) {
    return;
  }
  if (!sameIdentity(delivery.promptDir, delivery.promptDirIdentity)) {
    return;
  }
  if (delivery.promptFile && delivery.promptFileIdentity && sameIdentity(delivery.promptFile, delivery.promptFileIdentity)) {
    try {
      fs.unlinkSync(delivery.promptFile);
    } catch {
      // already gone
    }
  }
  try {
    fs.rmdirSync(delivery.promptDir);
  } catch {
    // not empty: leave it
  }
  if (delivery.runDirIdentity && sameIdentity(delivery.runDir, delivery.runDirIdentity)) {
    try {
      fs.rmdirSync(delivery.runDir);
    } catch {
      // still in use by another run, or not empty
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
  const profileName = assertProfile(options.permissionProfile ?? "read-only");
  const homeRoot = options.agyHomeRoot ?? resolveAgyHomeRoot(env);
  const home = path.join(homeRoot, profileName);

  // A caller that does not supply a run directory gets prompt files under the
  // system temp directory; either way only what this run created is removed.
  const delivery = buildPromptDelivery({
    prompt: options.prompt,
    runDir: options.runDir ?? path.join(os.tmpdir(), "agy-cc-prompts"),
    binary,
    env,
    platform
  });

  let args;
  let migratedFrom = null;
  try {
    args = buildHeadlessArgs({
      ...options,
      promptArg: delivery.promptArg,
      addDirs: [...(options.addDirs ?? []), ...delivery.addDirs],
      outputFormat: "stream-json"
    });
    prepareAgyHome(home, profileName, { realHome: options.realHome, model: options.userModel });
    if (options.resumeConversationId) {
      migratedFrom = syncConversationInto(homeRoot, home, options.resumeConversationId);
      if (migratedFrom) {
        emitProgress(
          options.onProgress,
          `Copied conversation ${options.resumeConversationId} from the ${path.basename(migratedFrom)} home into the ${profileName} home.`
        );
      }
    }
  } catch (error) {
    removePromptDelivery(delivery);
    throw error;
  }

  const detached = options.detached ?? platform !== "win32";
  const maxOutputBytes = options.maxOutputBytes ?? MAX_AGENT_OUTPUT_BYTES;
  const settingsFile = resolveAgySettingsFile(home);

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
      removePromptDelivery(delivery);
      reject(error);
      return;
    }

    const agentPid = child.pid ?? null;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let lineBuffer = "";
    let init = null;
    let startupValidated = false;
    let conversationId = null;
    let finalResult = null;
    let partialText = "";
    let permissionMismatch = null;
    let settingsMismatch = false;
    let startupTimedOut = false;
    let eventError = null;
    let authRequired = false;
    let killedByBridge = false;

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

    const startupTimer = setTimeout(() => {
      if (!startupValidated) {
        startupTimedOut = true;
        stopChild();
      }
    }, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);

    emitProgress(options.onProgress, `Running agy (${binary}).`, "starting", {
      threadId: options.resumeConversationId ?? null,
      agentPid,
      agentBinary: resolveExecutable(binary, env) ?? binary,
      pid: agentPid
    });

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

    const handleInit = (event) => {
      if (init) {
        return;
      }
      init = event.init && typeof event.init === "object" ? event.init : {};
      conversationId = event.conversation_id ?? init.conversation_id ?? conversationId;
      if (init.permission_mode !== EXPECTED_PERMISSION_MODE) {
        // The profile this run was promised is not the one agy loaded.
        permissionMismatch = String(init.permission_mode ?? "unknown");
        stopChild();
        return;
      }
      // agy rewrites the file from what it loaded; it must be this profile.
      if (!settingsMatchProfile(settingsFile, profileName)) {
        settingsMismatch = true;
        stopChild();
        return;
      }
      startupValidated = true;
      clearTimeout(startupTimer);
      emitProgress(options.onProgress, `agy conversation ${conversationId} (model ${init.model ?? "default"}).`, "running", {
        threadId: conversationId,
        agentPid
      });
    };

    const handleEvent = (event) => {
      if (event?.event === "init") {
        handleInit(event);
        return;
      }
      if (!startupValidated) {
        // Nothing counts before agy has started with checked permissions.
        return;
      }
      if (event?.event === "result") {
        finalResult = event.result && typeof event.result === "object" ? event.result : null;
        conversationId = finalResult?.conversation_id || conversationId;
        return;
      }
      const step = event?.step_update;
      if (!step || typeof step !== "object") {
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

    const consumeLine = (line) => {
      if (!line.startsWith("{")) {
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      try {
        handleEvent(event);
      } catch (error) {
        // A bug in handling must not leave a run half-validated: fail closed.
        eventError = error instanceof Error ? error.message : String(error);
        stopChild();
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
        consumeLine(line);
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
      removePromptDelivery(delivery);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      removePromptDelivery(delivery);
      consumeLine(lineBuffer.trim());

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
        startupValidated,
        result: finalResult,
        finalMessage: String(response ?? "").trimEnd(),
        structuredOutput:
          finalResult?.structured_output && typeof finalResult.structured_output === "object"
            ? finalResult.structured_output
            : null,
        deniedActions: Array.isArray(finalResult?.denied_actions) ? finalResult.denied_actions : [],
        timedOut: /print timeout after/i.test(stderr),
        authRequired,
        permissionMismatch,
        settingsMismatch,
        startupTimedOut,
        eventError,
        killedByBridge,
        resumeConversationId: options.resumeConversationId ?? null,
        migratedFrom,
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
      "The permission rules in the plugin's agy home were not this run's profile when agy started, so the run was stopped. Check that nothing else edits that settings file."
    );
    return failures;
  }
  if (run.eventError) {
    failures.push(`The bridge could not process agy's output (${run.eventError}); the run was stopped.`);
    return failures;
  }
  if (run.startupTimedOut) {
    failures.push("agy did not start within 90 seconds and was stopped.");
    return failures;
  }
  if (!run.init || !run.startupValidated) {
    failures.push("agy never reported its start-up event, so the run's permissions could not be checked.");
  }
  if (run.resumeConversationId) {
    const missing = new RegExp(`conversation\\s+"?${escapeRegExp(run.resumeConversationId)}"?\\s+not found`, "i").test(
      run.stderr ?? ""
    );
    if (missing || (run.conversationId && run.conversationId !== run.resumeConversationId)) {
      failures.push(
        `agy could not find conversation ${run.resumeConversationId} in the plugin's agy homes and started a new one instead. Start a fresh run.`
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
  if (!run.startupValidated || !run.conversationId || run.status !== 0 || run.result?.status !== "SUCCESS") {
    return false;
  }
  if (run.authRequired || run.permissionMismatch || run.settingsMismatch || run.startupTimedOut || run.timedOut || run.eventError) {
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

/** Where agy keeps a conversation's artifacts inside an agy home. */
export function resolveConversationDir(home, conversationId) {
  return conversationFiles(home, conversationId).brain;
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
