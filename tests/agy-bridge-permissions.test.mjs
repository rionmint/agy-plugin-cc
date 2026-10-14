import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy, lastPrintRun } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy-cc");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeAgyLog = path.join(pluginDataDir, "fake-agy.log");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeAgyLog };
}

function deny(entry) {
  return entry.settings?.permissions?.deny ?? [];
}

function allow(entry) {
  return entry.settings?.permissions?.allow ?? [];
}

// The read-only boundary is the permission profile the bridge writes into its
// own agy home, not an agy mode. Every invocation has to carry the profile its
// command promises, and must run in that home rather than the user's.

test("review runs with the read-only profile in the plugin's own agy home", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.equal(path.resolve(entry.home), path.resolve(path.join(pluginDataDir, "agy-home")));
  for (const rule of ["write_file(*)", "command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"]) {
    assert.ok(deny(entry).includes(rule), rule);
  }
  assert.equal(entry.settings.toolPermission, "request-review");
  assert.ok(!entry.argv.includes("--mode"), entry.argv.join(" "));
  assert.ok(!entry.argv.includes("--dangerously-skip-permissions"));
});

test("critique asks agy for the review schema", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  const schema = entry.argv[entry.argv.indexOf("--json-schema") + 1];
  assert.match(schema, /review-output\.schema\.json$/);
  assert.ok(deny(entry).includes("write_file(*)"));
});

test("run without --write stays read-only", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.ok(deny(entry).includes("write_file(*)"));
  assert.ok(deny(entry).includes("command(*)"));
});

test("run with --write allows edits but still denies commands", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "make the change"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.ok(!deny(entry).includes("write_file(*)"));
  assert.ok(deny(entry).includes("command(*)"));
  assert.ok(!entry.argv.includes("--mode"));
});

test("run with --write --allow-commands also allows commands", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "--allow-commands", "run the tests and fix them"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.ok(allow(entry).includes("command(*)"));
  assert.ok(!deny(entry).includes("command(*)"));
  assert.ok(!deny(entry).includes("unsandboxed(*)"));
});

test("--allow-commands without --write is refused before agy starts", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--allow-commands", "run the tests"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-commands requires --write/);
  assert.equal(lastPrintRun(fakeAgyLog), null);
});

test("--write with --mode plan is refused", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "--mode", "plan", "change it"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--write cannot be combined with --mode plan/);
  assert.equal(lastPrintRun(fakeAgyLog), null);
});

test("an explicit --mode plan is honoured", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  const result = run("node", [SCRIPT, "review", "--mode", "plan"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.equal(entry.argv[entry.argv.indexOf("--mode") + 1], "plan");
});

test("an unsupported mode is rejected before spawning agy", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();

  for (const mode of ["accept-edits", "auto", "yolo"]) {
    const result = run("node", [SCRIPT, "review", "--mode", mode], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
    });
    assert.notEqual(result.status, 0, mode);
    assert.match(`${result.stdout}${result.stderr}`, /Unsupported mode/);
  }
  assert.equal(lastPrintRun(fakeAgyLog), null);
});

test("the user's own agy settings are never touched", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupRepo();
  const userHome = makeTempDir();
  const userSettings = path.join(userHome, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });
  const original = JSON.stringify({ toolPermission: "always-proceed", model: "Gemini 4 Argon (High)" });
  fs.writeFileSync(userSettings, original);

  const homeEnv = process.platform === "win32" ? { USERPROFILE: userHome } : { HOME: userHome };
  const result = run("node", [SCRIPT, "run", "hello"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog, ...homeEnv })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(userSettings, "utf8"), original);
  const entry = lastPrintRun(fakeAgyLog);
  assert.notEqual(path.resolve(entry.home), path.resolve(userHome));
  assert.equal(entry.settings.toolPermission, "request-review");
  assert.equal(entry.settings.model, "Gemini 4 Argon (High)");
});
