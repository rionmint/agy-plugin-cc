import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_SESSION_ID = "11111111-2222-4333-8444-555555555555";

/**
 * Install a fake `cursor-agent` binary that responds to --version / status / -p
 * so the bridge can be exercised hermetically.
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"fail-print"} scenario
 */
export function installFakeCursor(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "cursor-agent");

  const source = `#!/usr/bin/env node
import fs from "node:fs";

const scenario = ${JSON.stringify(scenario)};
const sessionId = ${JSON.stringify(FAKE_SESSION_ID)};
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function writeLog() {
  const logPath = process.env.FAKE_CURSOR_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ argv, scenario, cwd: process.cwd() }) + "\\n");
}

writeLog();

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write("2026.08.25-fake\\n");
  process.exit(0);
}

if (argv[0] === "status" || argv[0] === "whoami") {
  if (scenario === "not-logged-in") {
    process.stdout.write("Not logged in\\n");
    process.exit(0);
  }
  process.stdout.write("\\u2713 Logged in as fake@example.com\\n");
  process.exit(0);
}

if (argv[0] === "--list-models" || argv[0] === "models") {
  if (scenario === "not-logged-in") {
    process.stderr.write("Error: Authentication required. Run 'agent login'.\\n");
    process.exit(1);
  }
  process.stdout.write("Available models\\n\\nauto - Auto (current, default)\\nfake-model - Fake Model\\n");
  process.exit(0);
}

const printIndex = argv.indexOf("-p");
const isPrint = printIndex !== -1 || hasFlag("--print");

if (isPrint || hasFlag("--resume") || hasFlag("--continue")) {
  if (scenario === "not-logged-in") {
    process.stderr.write(
      "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\\n"
    );
    process.exit(1);
  }
  if (scenario === "fail-print") {
    process.stderr.write("fake cursor-agent failed the print run\\n");
    process.exit(2);
  }

  // The real CLI reads the prompt from stdin when one is piped in.
  let prompt = printIndex !== -1 ? (argv[printIndex + 1] ?? "") : "";
  if (!prompt) {
    try {
      prompt = fs.readFileSync(0, "utf8");
    } catch {
      prompt = "";
    }
  }
  const outputFormat = flagValue("--output-format") ?? "text";

  let body;
  if (/Return only valid JSON|critique|adversarial|structured/i.test(prompt)) {
    body = JSON.stringify({
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    });
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    body = "ALLOW: previous turn did not make code changes";
  } else if (/code review|repository changes|Reviewing/i.test(prompt)) {
    body = "Reviewed uncommitted changes.\\nNo material issues found.";
  } else {
    body = "Handled the requested task.";
  }

  if (outputFormat === "json") {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        result: body,
        session_id: sessionId,
        request_id: "req-fake",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
      }) + "\\n"
    );
  } else {
    process.stdout.write(body + "\\nsession_id: " + sessionId + "\\n");
  }
  process.exit(0);
}

process.stderr.write("fake cursor-agent: unknown invocation: " + argv.join(" ") + "\\n");
process.exit(1);
`;

  writeExecutable(scriptPath, source);

  // Windows cannot exec a shebang file, and `spawn` without a shell will not
  // find one. Drop a .cmd shim next to it so both code paths resolve.
  if (process.platform === "win32") {
    const shimPath = `${scriptPath}.cmd`;
    fs.writeFileSync(shimPath, `@echo off
node "%~dp0cursor-agent" %*
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
