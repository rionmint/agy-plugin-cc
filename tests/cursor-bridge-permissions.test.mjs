import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCursor } from "./fake-cursor-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor-cc");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "cursor-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function lastFakeCursorArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const printRun = [...lines].reverse().find((entry) => entry.argv?.includes("--print"));
  assert.ok(printRun, "expected a headless cursor-agent --print invocation");
  return printRun.argv;
}

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeCursorLog = path.join(pluginDataDir, "fake-cursor.log");
  installFakeCursor(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeCursorLog };
}

// A headless run has nobody to answer a prompt, so two things have to hold on
// every invocation: the workspace must be pre-trusted, and read-only paths must
// carry an explicit Cursor mode rather than relying on a sandbox profile.

test("review runs read-only in ask mode and pre-trusts the workspace", () => {
  const { repo, binDir, pluginDataDir, fakeCursorLog } = setupRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_CURSOR_LOG: fakeCursorLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeCursorArgv(fakeCursorLog);
  assert.ok(argv.includes("--mode"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--mode") + 1], "ask");
  assert.ok(argv.includes("--trust"), argv.join(" "));
  assert.ok(!argv.includes("--force"), argv.join(" "));
});

test("run without --write stays in a read-only mode", () => {
  const { repo, binDir, pluginDataDir, fakeCursorLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_CURSOR_LOG: fakeCursorLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeCursorArgv(fakeCursorLog);
  assert.ok(argv.includes("--mode"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--mode") + 1], "ask");
  assert.ok(!argv.includes("--force"), argv.join(" "));
});

test("run with --write drops the read-only mode and allows tool calls", () => {
  const { repo, binDir, pluginDataDir, fakeCursorLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "make the change"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_CURSOR_LOG: fakeCursorLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeCursorArgv(fakeCursorLog);
  assert.ok(!argv.includes("--mode"), argv.join(" "));
  assert.ok(argv.includes("--force"), argv.join(" "));
  assert.ok(argv.includes("--trust"), argv.join(" "));
});

test("an explicit --mode plan is honoured", () => {
  const { repo, binDir, pluginDataDir, fakeCursorLog } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--mode", "plan"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_CURSOR_LOG: fakeCursorLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeCursorArgv(fakeCursorLog);
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
});

test("an unsupported mode is rejected before spawning cursor-agent", () => {
  const { repo, binDir, pluginDataDir, fakeCursorLog } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--mode", "yolo"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_CURSOR_LOG: fakeCursorLog })
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Unsupported mode/);
});
