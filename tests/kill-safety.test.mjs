import test from "node:test";
import assert from "node:assert/strict";

import { processLooksLikeOurs, terminateProcessTree } from "../plugins/cursor-cc/scripts/lib/process.mjs";

// Pids come out of a json file on disk and the operating system reuses them, so
// a stale record can name whatever now holds that number.
const OUR_MARKERS = ["cursor-agent", "cursor-bridge.mjs"];

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
    runCommandImpl: fakeCommandLine("/usr/bin/node /path/to/cursor-bridge.mjs run-worker --job-id x")
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
    runCommandImpl: fakeCommandLine("/usr/bin/node /plugins/cursor-cc/scripts/cursor-bridge.mjs run-worker"),
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
