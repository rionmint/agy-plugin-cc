import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  assertSafeJobId,
  generateJobId,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir
} from "../plugins/cursor-cc/scripts/lib/state.mjs";

// Run ids arrive from slash-command arguments (`/cursor-cc:show <run-id>`), so
// they are user input that becomes a path component.
const TRAVERSAL_IDS = [
  "../../outside",
  "..\\..\\outside",
  "..",
  "a/b",
  "a\\b",
  "/etc/passwd",
  "C:\\Windows\\System32\\x",
  "",
  "  ",
  "-leading-dash-is-fine-but-not-first"
];

test("resolveJobFile refuses a run id that would escape the run directory", () => {
  const workspace = makeTempDir();
  for (const id of TRAVERSAL_IDS) {
    assert.throws(() => resolveJobFile(workspace, id), /Invalid run id/, `should reject ${JSON.stringify(id)}`);
    assert.throws(() => resolveJobLogFile(workspace, id), /Invalid run id/, `should reject ${JSON.stringify(id)}`);
  }
});

test("generated run ids are accepted and stay inside the run directory", () => {
  const workspace = makeTempDir();
  const jobsDir = resolveJobsDir(workspace);

  for (const prefix of ["review", "critique", "task"]) {
    const id = generateJobId(prefix);
    assert.equal(assertSafeJobId(id), id);
    const jobFile = resolveJobFile(workspace, id);
    assert.equal(path.dirname(jobFile), jobsDir);
    assert.equal(path.dirname(resolveJobLogFile(workspace, id)), jobsDir);
  }
});

test("a dotted but non-traversing id is still allowed", () => {
  const workspace = makeTempDir();
  const id = "review-1.2.3-abc";
  assert.equal(path.dirname(resolveJobFile(workspace, id)), resolveJobsDir(workspace));
});
