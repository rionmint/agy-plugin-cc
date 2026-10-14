import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "cursor-cc", "scripts", "session-lifecycle-hook.mjs");

function sessionStart(envFile, sessionId, pluginData = "/plugin-data") {
  const result = run(process.execPath, [HOOK, "SessionStart"], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginData },
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart" })
  });
  assert.equal(result.status, 0, result.stderr);
}

function lines(envFile) {
  return fs.readFileSync(envFile, "utf8").split("\n").filter(Boolean);
}

function lastExport(envFile, name) {
  return lines(envFile)
    .filter((line) => line.startsWith(`export ${name}=`))
    .pop();
}

test("SessionStart repeated on resume and compaction writes each export once", () => {
  const envFile = path.join(makeTempDir(), "sessionstart-hook-2.sh");

  for (let i = 0; i < 12; i += 1) {
    sessionStart(envFile, "session-a");
  }

  assert.deepEqual(lines(envFile), [
    "export CURSOR_CC_SESSION_ID='session-a'",
    "export CLAUDE_PLUGIN_DATA='/plugin-data'"
  ]);
});

test("a value that changes and changes back still ends on the latest value", () => {
  const envFile = path.join(makeTempDir(), "sessionstart-hook-2.sh");

  sessionStart(envFile, "session-a");
  sessionStart(envFile, "session-b");
  sessionStart(envFile, "session-a");

  assert.equal(lastExport(envFile, "CURSOR_CC_SESSION_ID"), "export CURSOR_CC_SESSION_ID='session-a'");
  assert.equal(lines(envFile).filter((line) => line.startsWith("export CLAUDE_PLUGIN_DATA=")).length, 1);
});

test("CRLF line endings are recognised as the same export", () => {
  const envFile = path.join(makeTempDir(), "sessionstart-hook-2.sh");
  fs.writeFileSync(
    envFile,
    "export CURSOR_CC_SESSION_ID='session-a'\r\nexport CLAUDE_PLUGIN_DATA='/plugin-data'\r\n"
  );

  sessionStart(envFile, "session-a");

  assert.equal(fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter(Boolean).length, 2);
});

test("an existing file without a trailing newline does not get a joined line", () => {
  const envFile = path.join(makeTempDir(), "sessionstart-hook-2.sh");
  fs.writeFileSync(envFile, "export OTHER='x'");

  sessionStart(envFile, "session-a");

  assert.deepEqual(lines(envFile), [
    "export OTHER='x'",
    "export CURSOR_CC_SESSION_ID='session-a'",
    "export CLAUDE_PLUGIN_DATA='/plugin-data'"
  ]);
});
