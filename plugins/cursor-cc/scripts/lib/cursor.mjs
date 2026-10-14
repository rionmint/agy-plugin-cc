import fs from "node:fs";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, spawnCli } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

// Upper bound on how much a single run may print back to us. The bridge holds
// this in memory, so an unbounded child would be a denial of service.
const MAX_AGENT_OUTPUT_BYTES = 32 * 1024 * 1024;

const DEFAULT_BINARY = "cursor-agent";
const BINARY_ENV = "CURSOR_AGENT_BINARY";

/** Read-only execution modes exposed by the Cursor CLI. */
export const READ_ONLY_MODES = new Set(["ask", "plan"]);

export function resolveCursorBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

export function runCursor(args = [], options = {}) {
  const binary = options.binary ?? resolveCursorBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
  });
}

export function getCursorAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveCursorBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    const alt = binaryAvailable(binary, ["-v"], { cwd, env: options.env });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary
      };
    }
    return { available: true, detail: alt.detail, binary };
  }
  return { available: true, detail: versionStatus.detail, binary };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "status-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

/**
 * `cursor-agent status` is cheap and does not spend tokens, so it is the
 * preferred auth probe. It prints `Logged in as <account>` when authenticated
 * and `Not logged in` otherwise.
 */
export function runStatusProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveCursorBinary(options.env ?? process.env);
  const env = options.env ?? process.env;

  if (env?.CURSOR_API_KEY || env?.CURSOR_AUTH_TOKEN) {
    return buildAuthStatus({
      available: true,
      loggedIn: true,
      detail: "authenticated via environment key",
      source: "env",
      authMethod: "api-key",
      verified: false
    });
  }

  const result = runCursor(["status"], { cwd, env, binary });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: `${binary} binary not found`,
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({ available: true, loggedIn: false, detail: result.error.message });
  }

  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (/not\s+logged\s+in/i.test(stdout)) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: "not logged in; run `cursor-agent login` or set CURSOR_API_KEY"
    });
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({ available: true, loggedIn: false, detail: detail || "status probe failed" });
  }

  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: firstLine(stdout) || "logged in",
    source: "status-probe",
    authMethod: "cursor-cli",
    verified: true
  });
}

export function getCursorAuthStatus(cwd, options = {}) {
  const availability = getCursorAvailability(cwd, options);
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
  return runStatusProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s✓✗*-]+/, "").trim())
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

/**
 * Build the argv for a headless (`--print`) Cursor run.
 *
 * The prompt is deliberately NOT in here — it goes to the child on stdin, which
 * Cursor accepts and which keeps free-form text off a Windows command line
 * (where cmd would expand `%VAR%` inside it).
 *
 * Differences from other coding CLIs that matter here:
 * - the working directory flag is `--workspace`, not `--cwd`
 * - `--output-format` is only honoured together with `--print`
 * - headless runs stop on a workspace-trust prompt unless `--trust` is passed
 * - read-only is a *mode* (`ask` / `plan`), not a sandbox profile
 * - a session id cannot be assigned up front; it is reported back in the
 *   json envelope as `session_id`
 */
// Flag values reach the child as separate argv entries, so a value that starts
// with `-` is read by Cursor's own parser as another flag. `--model --force`
// would quietly turn a read-only review into a write-capable run, so every
// value that goes next to a flag is checked before it is pushed.
const VALUE_PATTERNS = {
  model: /^[A-Za-z0-9][A-Za-z0-9._:@[\]=,/-]{0,127}$/,
  mode: /^(ask|plan)$/,
  session: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  outputFormat: /^(text|json|stream-json)$/,
  sandbox: /^(enabled|disabled)$/
};

export function assertSafeCliValue(kind, value) {
  const text = String(value ?? "");
  const pattern = VALUE_PATTERNS[kind];
  if (!pattern || !pattern.test(text)) {
    throw new Error(`Refusing to pass an unsafe ${kind} value to cursor-agent: ${JSON.stringify(value)}`);
  }
  return text;
}

/** A workspace path is free-form, but it must never look like a flag. */
export function assertSafeWorkspace(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("-") || /[\r\n\0]/.test(text)) {
    throw new Error(`Refusing to pass an unsafe workspace path to cursor-agent: ${JSON.stringify(value)}`);
  }
  return text;
}

export function buildHeadlessArgs(options = {}) {
  if (options.force && options.mode) {
    // These two say opposite things about whether the run may edit files.
    // Picking one silently is how a read-only request becomes a write run.
    throw new Error(
      `Refusing to run with both a read-only mode (${options.mode}) and write access.`
    );
  }

  const args = [];

  if (options.resumeSessionId) {
    args.push("--resume", assertSafeCliValue("session", options.resumeSessionId));
  } else if (options.continueLast) {
    args.push("--continue");
  }

  args.push("--print");

  if (options.cwd) {
    args.push("--workspace", assertSafeWorkspace(options.cwd));
  }
  if (options.mode) {
    args.push("--mode", assertSafeCliValue("mode", options.mode));
  }
  if (options.model) {
    args.push("--model", assertSafeCliValue("model", options.model));
  }

  const outputFormat = assertSafeCliValue("outputFormat", options.outputFormat || "text");
  args.push("--output-format", outputFormat);

  if (options.streamPartialOutput && outputFormat === "stream-json") {
    args.push("--stream-partial-output");
  }
  if (options.trust !== false) {
    args.push("--trust");
  }
  if (options.force && !options.mode) {
    args.push("--force");
  }
  if (options.approveMcps) {
    args.push("--approve-mcps");
  }
  if (options.sandbox) {
    args.push("--sandbox", assertSafeCliValue("sandbox", options.sandbox));
  }
  for (const dir of options.pluginDirs ?? []) {
    // A plugin directory is a path like the workspace, and it must not be able
    // to masquerade as a flag either.
    args.push("--plugin-dir", assertSafeWorkspace(dir));
  }

  return args;
}

/** Pull the session id out of whatever Cursor printed, if it is in there. */
export function extractSessionId(stdout) {
  const text = String(stdout ?? "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      const id = obj.session_id ?? obj.sessionId ?? obj.chatId ?? null;
      if (id) {
        return String(id);
      }
    } catch {
      // not a json line; keep scanning
    }
  }
  const match = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return match ? match[0] : null;
}

/**
 * Cursor's `--output-format json` wraps the answer in a result envelope.
 * Unwrap it so callers get the assistant text rather than the envelope.
 */
export function unwrapResultEnvelope(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    return { text, envelope: null };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && typeof obj.result === "string") {
      return { text: obj.result, envelope: obj };
    }
    return { text, envelope: obj };
  } catch {
    return { text, envelope: null };
  }
}

/**
 * The environment a headless Cursor run starts with. On Windows Cursor writes
 * every command hook, including the Claude Code hooks it imports, as a
 * PowerShell command line, but runs that line with `$SHELL` when it is set.
 * Under Git Bash (and Claude Code's Bash tool) `SHELL` is bash, the line is a
 * bash syntax error, bash exits 2, and Cursor reads exit 2 as "blocked", so
 * every shell call is refused. Without `SHELL` Cursor uses PowerShell and the
 * hooks run as written.
 */
export function cursorChildEnv(env = process.env, platform = process.platform) {
  if (platform !== "win32" || !env || !Object.keys(env).some((key) => key.toUpperCase() === "SHELL")) {
    return env;
  }
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "SHELL"));
}

export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveCursorBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Cursor run."));
  }

  const args = buildHeadlessArgs({
    ...options,
    cwd: options.cwd ?? cwd
  });

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    const child = spawnCli(binary, args, {
      cwd,
      env: cursorChildEnv(options.env ?? process.env, platform),
      stdio: ["pipe", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    // Cursor reads the prompt from stdin and infers print mode from the pipe.
    child.stdin.on("error", () => {
      // the child may exit before the prompt is fully flushed; the close
      // handler reports the real failure
    });
    child.stdin.end(prompt);

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running cursor-agent (${binary}).`, "starting", {
      threadId: options.resumeSessionId ?? null,
      agentPid,
      pid: agentPid
    });

    // A stuck or hostile child can print forever. Keep a bounded window rather
    // than growing a string until the bridge runs out of memory.
    const maxOutputBytes = options.maxOutputBytes ?? MAX_AGENT_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let truncated = false;

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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      const sessionId = options.resumeSessionId ?? extractSessionId(stdout);
      const { text: finalMessage, envelope } = unwrapResultEnvelope(stdout);

      emitProgress(
        options.onProgress,
        status === 0 ? "Cursor finished." : `Cursor exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: sessionId, agentPid }
      );

      resolve({
        status,
        signal,
        stdout,
        stderr,
        truncated,
        sessionId,
        threadId: sessionId,
        agentPid,
        envelope,
        finalMessage: (finalMessage || stdout).trimEnd(),
        args,
        binary
      });
    });
  });
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Cursor did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  // Peel the `--output-format json` envelope first so the schema payload is reachable.
  const text = unwrapResultEnvelope(rawOutput).text.trim();

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
    parseError: "Could not parse structured JSON from Cursor output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
