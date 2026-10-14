import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeCliValue,
  assertSafeWorkspace,
  buildHeadlessArgs
} from "../plugins/cursor-cc/scripts/lib/cursor.mjs";

// Values sit next to a flag in argv, so anything that starts with `-` is read
// by Cursor's own parser as another flag. `--model --force` would silently turn
// a read-only review into a write-capable run.
const FLAG_LOOKALIKES = ["--force", "--yolo", "-f", "--plugin-dir", "--sandbox"];

test("a model value that looks like a flag is refused", () => {
  for (const value of FLAG_LOOKALIKES) {
    assert.throws(() => buildHeadlessArgs({ model: value }), /unsafe model value/, value);
  }
});

test("a resume session id that looks like a flag is refused", () => {
  for (const value of FLAG_LOOKALIKES) {
    assert.throws(() => buildHeadlessArgs({ resumeSessionId: value }), /unsafe session value/, value);
  }
});

test("a workspace path that looks like a flag is refused", () => {
  for (const value of [...FLAG_LOOKALIKES, "with\nnewline"]) {
    assert.throws(() => buildHeadlessArgs({ cwd: value }), /unsafe workspace path/, JSON.stringify(value));
  }
  // An empty cwd simply means "no --workspace flag", which is Cursor's default.
  assert.ok(!buildHeadlessArgs({ cwd: "" }).includes("--workspace"));
  assert.throws(() => assertSafeWorkspace(""), /unsafe workspace path/);
});

test("only the two read-only modes are accepted", () => {
  assert.equal(assertSafeCliValue("mode", "ask"), "ask");
  assert.equal(assertSafeCliValue("mode", "plan"), "plan");
  for (const value of ["agent", "write", "yolo", "ASK", ""]) {
    assert.throws(() => assertSafeCliValue("mode", value), /unsafe mode value/, value);
  }
});

test("only the three documented output formats are accepted", () => {
  for (const value of ["text", "json", "stream-json"]) {
    assert.equal(assertSafeCliValue("outputFormat", value), value);
  }
  assert.throws(() => buildHeadlessArgs({ outputFormat: "yaml" }), /unsafe outputFormat value/);
});

test("shell metacharacters in a model value are refused rather than escaped", () => {
  for (const value of ['x" & whoami', "a|b", "a&b", "a>b", "a%PATH%b", "a\nb"]) {
    assert.throws(() => assertSafeCliValue("model", value), /unsafe model value/, JSON.stringify(value));
  }
});

test("real cursor model ids still pass", () => {
  for (const value of [
    "auto",
    "gpt-5.2",
    "gpt-5.3-codex-high-fast",
    "claude-opus-5-thinking-high",
    "claude-opus-4-8[context=1m,effort=high,fast=false]",
    "cursor-grok-4.6-high-fast"
  ]) {
    assert.equal(assertSafeCliValue("model", value), value);
  }
});

test("real workspace paths still pass", () => {
  for (const value of [String.raw`C:\repo dir\sub`, "/home/me/repo", String.raw`C:\Users\me\proj`]) {
    assert.equal(assertSafeWorkspace(value), value);
  }
});
