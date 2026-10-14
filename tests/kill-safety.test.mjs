import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { processLooksLikeOurs, terminateProcessTree } from "../plugins/agy-cc/scripts/lib/process.mjs";
import { buildProcessMarkers, createProgressReporter, OUR_PROCESS_MARKERS } from "../plugins/agy-cc/scripts/lib/tracked-jobs.mjs";

// Pids come out of a json file on disk and the operating system reuses them, so
// a stale record can name whatever now holds that number.
const OUR_MARKERS = OUR_PROCESS_MARKERS;

function fakeCommandLine(text) {
  return () => ({
    command: "ps",
    args: [],
    status: text === null ? 1 : 0,
    signal: null,
    stdout: text ?? "",
    stderr: "",
    error: null
  });
}

test("a process whose command line matches is recognised as ours", () => {
  const looksOurs = processLooksLikeOurs(1234, OUR_MARKERS, {
    platform: "linux",
    runCommandImpl: fakeCommandLine("/usr/bin/node /path/to/agy-bridge.mjs run-worker --job-id x")
  });
  assert.equal(looksOurs, true);
});

test("an unrelated process is not recognised as ours", () => {
  const looksOurs = processLooksLikeOurs(1234, OUR_MARKERS, {
    platform: "linux",
    runCommandImpl: fakeCommandLine("/usr/bin/ssh-agent -s")
  });
  assert.equal(looksOurs, false);
});

test("an unreadable command line fails closed", () => {
  const looksOurs = processLooksLikeOurs(1234, OUR_MARKERS, {
    platform: "linux",
    runCommandImpl: fakeCommandLine(null)
  });
  assert.equal(looksOurs, false);
});

test("terminateProcessTree refuses to signal a pid that is not ours", () => {
  let killed = false;
  const outcome = terminateProcessTree(4321, {
    expect: OUR_MARKERS,
    platform: "linux",
    runCommandImpl: fakeCommandLine("/usr/bin/ssh-agent -s"),
    killImpl: () => {
      killed = true;
    }
  });

  assert.equal(killed, false, "an unrelated process must not be signalled");
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.reason, "identity-mismatch");
});

test("terminateProcessTree still signals a pid that is ours", () => {
  const signals = [];
  const outcome = terminateProcessTree(4321, {
    expect: OUR_MARKERS,
    platform: "linux",
    runCommandImpl: fakeCommandLine("/usr/bin/node /plugins/agy-cc/scripts/agy-bridge.mjs run-worker"),
    killImpl: (pid, signal) => {
      signals.push([pid, signal]);
    },
    isAliveImpl: () => false
  });

  assert.ok(signals.length > 0, "the matching process should be signalled");
  assert.equal(outcome.attempted, true);
});

test("no expectation means no identity check, so existing callers are unchanged", () => {
  const signals = [];
  terminateProcessTree(4321, {
    platform: "linux",
    killImpl: (pid, signal) => {
      signals.push([pid, signal]);
    },
    isAliveImpl: () => false
  });
  assert.ok(signals.length > 0);
});

test("the recorded agy binary is recognised on every platform's command line", () => {
  for (const [binary, line] of [
    [String.raw`C:\Users\me\AppData\Local\agy\bin\agy.exe`, String.raw`"C:\Users\me\AppData\Local\agy\bin\agy.exe" -p=hello --output-format stream-json`],
    ["/Users/me/.local/bin/agy", "/Users/me/.local/bin/agy -p=hello --output-format stream-json"],
    [String.raw`C:\tmp\bin\agy.cmd`, String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\tmp\bin\agy.cmd" ^"-p=x^""`]
  ]) {
    const markers = buildProcessMarkers([binary]);
    assert.equal(processLooksLikeOurs(1, markers, { platform: "linux", runCommandImpl: fakeCommandLine(line) }), true, line);
  }
});

test("an agy process is only ours when it is the program the run recorded", () => {
  const line = "/Users/me/.local/bin/agy -p=hello --output-format stream-json";
  for (const markers of [OUR_MARKERS, buildProcessMarkers(["/opt/other/agy"]), buildProcessMarkers([null])]) {
    assert.equal(processLooksLikeOurs(1, markers, { platform: "linux", runCommandImpl: fakeCommandLine(line) }), false);
  }
});

test("the bridge is recognised with quoted, spaced and flagged script paths", () => {
  for (const line of [
    String.raw`"C:\Program Files\nodejs\node.exe" C:\p\agy-cc\scripts\agy-bridge.mjs run-worker --cwd C:\x --job-id run-1`,
    String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\John Smith\.claude\plugins\agy-cc\scripts\agy-bridge.mjs" run-worker --cwd C:\x`,
    String.raw`"C:\Program Files\nodejs\node.exe" C:/Users/me/.claude/plugins/agy-cc/scripts/agy-bridge.mjs run --background`,
    "/usr/local/bin/node /Users/John Smith/.claude/plugins/agy-cc/scripts/agy-bridge.mjs run-worker --cwd /tmp/x",
    "node --no-warnings /opt/agy-cc/scripts/agy-bridge.mjs image --out /tmp/a.png"
  ]) {
    assert.equal(processLooksLikeOurs(1, OUR_MARKERS, { platform: "linux", runCommandImpl: fakeCommandLine(line) }), true, line);
  }
});

test("the stop target is recorded even when the run log cannot be written", () => {
  const events = [];
  const report = createProgressReporter({
    logFile: path.join(os.tmpdir(), "agy-cc-no-such-dir", "nested", "run.log"),
    onEvent: (event) => events.push(event)
  });
  assert.doesNotThrow(() => report({ message: "Running agy.", agentPid: 42, agentBinary: "/opt/agy" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].agentPid, 42);
  assert.equal(events[0].agentBinary, "/opt/agy");
});

test("node merely mentioning the bridge, or running a non-run subcommand, is not ours", () => {
  for (const line of [
    "node other.mjs --label /tmp/agy-bridge.mjs run",
    "node /x/other.mjs --label /tmp/agy-bridge.mjs run",
    "node /x/other.mjs /tmp/agy-bridge.mjs",
    String.raw`"C:\Program Files\nodejs\node.exe" C:\p\agy-bridge.mjs stop run-1`,
    "/usr/bin/node /p/agy-bridge.mjs.bak run",
    "/usr/bin/node /p/not-agy-bridge.mjs run"
  ]) {
    assert.equal(processLooksLikeOurs(1, OUR_MARKERS, { platform: "linux", runCommandImpl: fakeCommandLine(line) }), false, line);
  }
});

test("words that merely contain agy are not ours", () => {
  for (const line of [
    "/usr/bin/strategy-runner",
    String.raw`C:\apps\agyfoo.exe`,
    "/opt/legacy/bin/run",
    String.raw`C:\tools\editor.exe C:\Users\me\AppData\Local\agy\bin\agy.exe`,
    String.raw`node C:\tmp\bin\agy -p=x`,
    "/usr/bin/vim /home/me/plugins/agy-cc/scripts/agy-bridge.mjs"
  ]) {
    assert.equal(processLooksLikeOurs(1, OUR_MARKERS, { platform: "linux", runCommandImpl: fakeCommandLine(line) }), false, line);
  }
});
