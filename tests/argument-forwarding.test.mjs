import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "../plugins/agy-cc/scripts/lib/args.mjs";
import { buildEnv, installFakeAgy, lastPrintRun } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "agy-cc", "scripts", "agy-bridge.mjs");

test("a backslash only escapes a quote, so paths survive tokenizing", () => {
  // The tokenizer used to treat every backslash as an escape, which turned
  // `C:\src\app.ts` into `C:srcapp.ts`.
  assert.deepEqual(splitRawArgumentString(String.raw`inspect C:\src\app.ts`), [
    "inspect",
    String.raw`C:\src\app.ts`
  ]);
  assert.deepEqual(splitRawArgumentString(String.raw`focus on /foo\d+/`), [
    "focus",
    "on",
    String.raw`/foo\d+/`
  ]);
});

test("quotes still group words and are still escapable", () => {
  assert.deepEqual(splitRawArgumentString('keep "quoted words"'), ["keep", "quoted words"]);
  assert.deepEqual(splitRawArgumentString(String.raw`say \"hi\"`), ["say", '"hi"']);
});

test("a repeatable option collects every value in order", () => {
  const { options } = parseArgs(["--add-dir", "a", "--model", "m", "--add-dir=b"], {
    valueOptions: ["model"],
    multiOptions: ["add-dir"]
  });
  assert.deepEqual(options["add-dir"], ["a", "b"]);
  assert.equal(options.model, "m");
});

function setupReviewableRepo() {
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

test("flags packed into one argument alongside another are not dropped", () => {
  // Slash commands forward the user's arguments as a single string. When a
  // command also adds its own flag, that string is no longer the sole argv
  // entry — and it used to be swallowed as one unknown option, silently losing
  // --base, --scope, --model, --mode and any focus text.
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupReviewableRepo();

  const result = run("node", [SCRIPT, "review", "--model gemini-3.8-flash-low --mode plan --effort high"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastPrintRun(fakeAgyLog).argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  assert.doesNotMatch(result.stderr, /ignoring unknown option/);
});

test("delegate forwards --add-dir and --timeout", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupReviewableRepo();
  const extra = makeTempDir();

  const result = run("node", [SCRIPT, "run", "--add-dir", extra, "--timeout", "120", "read the other folder"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastPrintRun(fakeAgyLog).argv;
  const dirs = argv.flatMap((token, index) => (token === "--add-dir" ? [argv[index + 1]] : []));
  assert.ok(dirs.map((dir) => path.resolve(dir)).includes(path.resolve(extra)), dirs.join(" "));
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], "120s");
});

test("delegate refuses an --add-dir that is not a directory", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupReviewableRepo();

  const result = run("node", [SCRIPT, "run", "--add-dir", path.join(repo, "nope"), "x"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--add-dir is not a directory/);
});
