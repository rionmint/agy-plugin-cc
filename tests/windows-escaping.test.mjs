import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCmdLine, quoteWindowsArg, spawnCli } from "../plugins/cursor-cc/scripts/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

// Arguments that have historically broken naive Windows quoting. The `"` cases
// are the command-injection ones: a bare double quote closes cmd's quoted
// region and everything after it is parsed as cmd syntax again.
const HOSTILE_ARGS = [
  'x" & echo pwned>PWNED.txt & rem "',
  'x" | whoami & rem "',
  "a & b",
  "a | b",
  "a > b",
  "a ^ b",
  "a (b) c",
  "pct:%PATH%",
  "bang:!PATH!",
  "plain-value",
  "C:\\path with space\\file.txt",
  "C:\\trailing\\backslash\\",
  'embedded "quoted" words'
];

test("quoteWindowsArg neutralises every cmd metacharacter", () => {
  const escaped = quoteWindowsArg("a & b | c > d ^ e % f ! g ( h )");
  for (const meta of ["&", "|", ">", "%", "!", "(", ")"]) {
    assert.ok(
      !new RegExp(`(^|[^^])\\${meta}`).test(escaped),
      `${meta} should never appear without a leading caret: ${escaped}`
    );
  }
});

test("quoteWindowsArg escapes twice for batch targets", () => {
  const once = quoteWindowsArg("a & b");
  const twice = quoteWindowsArg("a & b", true);
  assert.notEqual(once, twice);
  assert.ok(twice.includes("^^"), twice);
});

test("buildCmdLine double-escapes arguments but not the target", () => {
  const line = buildCmdLine("C:\\tools\\thing.cmd", ["a & b"]);
  assert.ok(line.includes('"C:\\tools\\thing.cmd"'), line);
  // The target keeps real quotes so cmd's own tokenizer can see them; only the
  // arguments are caret-escaped.
  assert.ok(!line.includes('^"C:\\tools'), line);
  assert.ok(line.includes("^^"), line);
});

// The round-trip only means anything on Windows, where cmd.exe is in the loop.
const describeWindows = process.platform === "win32" ? test : test.skip;

function installBatchEcho(dir) {
  const dumpPath = path.join(dir, "dump.mjs");
  fs.writeFileSync(dumpPath, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const batPath = path.join(dir, "echoargs.cmd");
  fs.writeFileSync(batPath, '@echo off\r\nnode "%~dp0dump.mjs" %*\r\n', "utf8");
  return batPath;
}

function runBatch(batPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(batPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describeWindows("arguments survive a .cmd shim byte for byte", async () => {
  const dir = makeTempDir();
  const batPath = installBatchEcho(dir);

  for (const value of HOSTILE_ARGS) {
    const { code, stdout, stderr } = await runBatch(batPath, ["--model", value], dir);
    assert.equal(code, 0, `exit ${code} for ${JSON.stringify(value)}: ${stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      assert.fail(`child did not return json for ${JSON.stringify(value)}: ${stdout}`);
    }
    assert.deepEqual(parsed, ["--model", value], `round-trip changed ${JSON.stringify(value)}`);
  }
});

describeWindows("a batch target whose path contains a space still runs", async () => {
  // Caret-escaping the quotes around the target hides them from cmd's own
  // tokenizer, which then splits the path at the space. Regression guard.
  const parent = makeTempDir();
  const dir = path.join(parent, "spaced dir");
  fs.mkdirSync(dir);
  const batPath = installBatchEcho(dir);

  const { code, stdout, stderr } = await runBatch(batPath, ["--model", "auto"], dir);
  assert.equal(code, 0, `exit ${code}: ${stderr}`);
  assert.deepEqual(JSON.parse(stdout.trim()), ["--model", "auto"]);
});

describeWindows("a quote-and-ampersand payload cannot execute a second command", async () => {
  const dir = makeTempDir();
  const batPath = installBatchEcho(dir);
  const marker = path.join(dir, "PWNED.txt");

  const payload = `x" & echo pwned>${marker} & rem "`;
  const { code } = await runBatch(batPath, ["--model", payload], dir);

  assert.equal(code, 0);
  assert.equal(fs.existsSync(marker), false, "the injected command must not have run");
});
