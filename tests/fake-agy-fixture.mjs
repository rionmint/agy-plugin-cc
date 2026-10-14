import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";
export const FAKE_NEW_CONVERSATION_ID = "99999999-8888-4777-8666-555555555555";

/**
 * Install a fake `agy` binary that behaves like agy 1.3.5 in the ways the
 * bridge depends on: `--version`, `models`, and `-p=<prompt>` with
 * `--output-format stream-json`.
 *
 * It reads the settings file from the home directory it was given (USERPROFILE
 * on Windows, HOME elsewhere), reports `toolPermission` as the permission mode
 * in its `init` event, and logs every invocation to FAKE_AGY_LOG.
 *
 * @param {string} binDir directory that will be prepended to PATH
 * @param {string} scenario
 *   "default" | "not-logged-in" | "fail-print" | "denied-once" | "timeout" |
 *   "always-proceed" | "unknown-conversation" | "image" | "no-image"
 */
export function installFakeAgy(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "agy");

  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const scenario = process.env.FAKE_AGY_SCENARIO || ${JSON.stringify(scenario)};
const fixedConversation = ${JSON.stringify(FAKE_CONVERSATION_ID)};
const newConversation = ${JSON.stringify(FAKE_NEW_CONVERSATION_ID)};
const argv = process.argv.slice(2);
const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
const settingsFile = path.join(home || "", ".gemini", "antigravity-cli", "settings.json");

let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
} catch {
  settings = null;
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function flagValues(name) {
  const values = [];
  argv.forEach((token, index) => {
    if (token === name && argv[index + 1] !== undefined) values.push(argv[index + 1]);
  });
  return values;
}

const printArg = argv.find((token) => token.startsWith("-p="));
let prompt = printArg ? printArg.slice(3) : null;
let promptFile = null;
const pointer = prompt && prompt.match(/^Your complete instructions are in the file (.+?) \\. /);
if (pointer) {
  promptFile = pointer[1];
  prompt = fs.readFileSync(promptFile, "utf8");
}

const logPath = process.env.FAKE_AGY_LOG;
if (logPath) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ argv, scenario, cwd: process.cwd(), home, settings, prompt, promptFile }) + "\\n"
  );
}

if (argv[0] === "--version") {
  process.stdout.write("1.3.5-fake\\n");
  process.exit(0);
}

if (argv[0] === "models") {
  process.stderr.write("Fetching available models...\\n");
  if (scenario === "not-logged-in") {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\\n");
    process.exit(1);
  }
  process.stdout.write("gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nfake-model\\tFake Model\\n");
  process.exit(0);
}

if (prompt === null) {
  process.stderr.write("fake agy: unknown invocation: " + argv.join(" ") + "\\n");
  process.exit(2);
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const resumeId = flagValue("--conversation");
let conversationId = resumeId || fixedConversation;
if (resumeId && scenario === "unknown-conversation") {
  process.stderr.write('warning: conversation "' + resumeId + '" not found\\n');
  conversationId = newConversation;
}
const usage = { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 };

if (scenario === "not-logged-in") {
  process.stderr.write("Authentication required. Please visit the URL to log in:\\n  https://accounts.example/oauth\\n");
  setTimeout(() => {
    emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", usage } });
    process.exit(1);
  }, 20000);
} else {
  const permissionMode = scenario === "always-proceed" ? "always-proceed" : (settings?.toolPermission ?? "request-review");
  emit({ event: "init", conversation_id: conversationId, init: { model: flagValue("--model") || "gemini-4-argon-medium", cwd: process.cwd(), tools: [], permission_mode: permissionMode } });

  const finish = () => {
    if (scenario === "fail-print") {
      process.stderr.write("fake agy failed the print run\\n");
      process.exit(2);
    }

    emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(process.cwd(), "README.md") } } } });

    const schemaPath = flagValue("--json-schema");
    let response;
    let structured = null;
    if (scenario === "denied-once" && !resumeId) {
      process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
      emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 1, num_turns: 1, usage, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
      process.exit(0);
    }
    if (scenario === "timeout") {
      process.stderr.write("[agy] print timeout after 5s with turn in progress; returning partial output\\n");
      emit({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "1^2 = 1\\n2^2 = ", duration_seconds: 0, num_turns: 1, usage } });
      process.exit(0);
    }
    if (scenario === "image" || scenario === "no-image") {
      if (scenario === "image") {
        const dir = path.join(home, ".gemini", "antigravity-cli", "brain", conversationId);
        fs.mkdirSync(dir, { recursive: true });
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
        fs.writeFileSync(path.join(dir, "fake_image_" + Date.now() + ".jpg"), jpeg);
      }
      response = scenario === "image" ? "Generated the image." : "";
    } else if (schemaPath || /critique|structured_output_contract/i.test(prompt)) {
      structured = { verdict: "approve", summary: "No material issues found in the reviewed changes.", findings: [], next_steps: ["Ship it."] };
      response = JSON.stringify({ ...structured, toolAction: "Finishing", toolSummary: "Done" });
    } else if (/code review|repository changes/i.test(prompt)) {
      response = "Reviewed uncommitted changes.\\nNo material issues found.";
    } else if (/Continue the original task/i.test(prompt)) {
      response = "Recovered without the refused permission.";
    } else {
      response = "Handled the requested task.";
    }

    for (const delta of [response]) {
      emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: delta } });
    }
    const result = { conversation_id: conversationId, status: "SUCCESS", response: response + (response ? "\\n" : ""), duration_seconds: 1, num_turns: resumeId ? 2 : 1, usage };
    if (structured && schemaPath) {
      result.structured_output = structured;
      result.json_schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    }
    emit({ event: "result", result });
    process.exit(0);
  };

  const delay = Number(process.env.FAKE_AGY_DELAY_MS || 0);
  if (delay > 0) {
    setTimeout(finish, delay);
  } else {
    finish();
  }
}
`;

  writeExecutable(scriptPath, source);

  // Windows cannot exec a shebang file, and `spawn` without a shell will not
  // find one. Drop a .cmd shim next to it so both code paths resolve. Through
  // the shim the bridge must deliver every prompt as a file, never inline.
  if (process.platform === "win32") {
    const shimPath = `${scriptPath}.cmd`;
    fs.writeFileSync(shimPath, `@echo off
node "%~dp0agy" %*
`, "utf8");
  }

  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };
}

/** Every logged invocation of the fake binary, oldest first. */
export function readFakeAgyLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The last `-p=` run the fake binary saw. */
export function lastPrintRun(logPath) {
  const entries = readFakeAgyLog(logPath).filter((entry) => entry.argv?.some((token) => token.startsWith("-p=")));
  return entries[entries.length - 1] ?? null;
}
