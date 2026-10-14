import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeCliValue,
  assertSafePath,
  buildHeadlessArgs
} from "../plugins/agy-cc/scripts/lib/agy.mjs";

// Values sit next to a flag in argv, so anything that starts with `-` would be
// read by agy's own parser as another flag. `--model --dangerously-skip-permissions`
// would silently turn a read-only review into a run that approves everything.
const FLAG_LOOKALIKES = ["--dangerously-skip-permissions", "--yolo", "-c", "--add-dir", "--sandbox"];

test("a model value that looks like a flag is refused", () => {
  for (const value of FLAG_LOOKALIKES) {
    assert.throws(() => buildHeadlessArgs({ promptArg: "x", model: value }), /unsafe model value/, value);
  }
});

test("a resume conversation id that looks like a flag is refused", () => {
  for (const value of FLAG_LOOKALIKES) {
    assert.throws(
      () => buildHeadlessArgs({ promptArg: "x", resumeConversationId: value }),
      /unsafe conversation value/,
      value
    );
  }
});

test("an added directory or schema path that looks like a flag is refused", () => {
  for (const value of [...FLAG_LOOKALIKES, "with\nnewline"]) {
    assert.throws(() => buildHeadlessArgs({ promptArg: "x", addDirs: [value] }), /unsafe directory/, JSON.stringify(value));
    assert.throws(() => buildHeadlessArgs({ promptArg: "x", jsonSchemaPath: value }), /unsafe schema path/, JSON.stringify(value));
  }
  assert.throws(() => assertSafePath(""), /unsafe path/);
});

test("only plan is accepted as a mode", () => {
  assert.equal(assertSafeCliValue("mode", "plan"), "plan");
  for (const value of ["accept-edits", "auto", "write", "PLAN", ""]) {
    assert.throws(() => assertSafeCliValue("mode", value), /unsafe mode value/, value);
  }
});

test("only agy's effort levels are accepted", () => {
  for (const value of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(assertSafeCliValue("effort", value), value);
  }
  for (const value of ["ultra", "--max", ""]) {
    assert.throws(() => assertSafeCliValue("effort", value), /unsafe effort value/, value);
  }
});

test("timeouts must be a plain duration", () => {
  for (const value of ["0", "5s", "600s", "30m", "2h"]) {
    assert.equal(assertSafeCliValue("timeout", value), value);
  }
  for (const value of ["-5s", "5", "5 s", "1d", "5s;rm"]) {
    assert.throws(() => assertSafeCliValue("timeout", value), /unsafe timeout value/, value);
  }
});

test("only the three documented output formats are accepted", () => {
  for (const value of ["text", "json", "stream-json"]) {
    assert.equal(assertSafeCliValue("outputFormat", value), value);
  }
  assert.throws(() => buildHeadlessArgs({ promptArg: "x", outputFormat: "yaml" }), /unsafe outputFormat value/);
});

test("shell metacharacters in a model value are refused rather than escaped", () => {
  for (const value of ['x" & whoami', "a|b", "a&b", "a>b", "a%PATH%b", "a\nb", "a b"]) {
    assert.throws(() => assertSafeCliValue("model", value), /unsafe model value/, JSON.stringify(value));
  }
});

test("real agy model ids still pass", () => {
  for (const value of [
    "gemini-4-argon-medium",
    "gemini-3.8-flash-low",
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-low",
    "gpt-oss-120b-medium"
  ]) {
    assert.equal(assertSafeCliValue("model", value), value);
  }
});

test("real paths still pass", () => {
  for (const value of [String.raw`C:\repo dir\sub`, "/home/me/repo", String.raw`C:\Users\me\proj`]) {
    assert.equal(assertSafePath(value), value);
  }
});
