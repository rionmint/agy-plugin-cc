import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/cursor-cc/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// Untracked file bodies are inlined into the prompt that goes to the agent, so
// whatever a repository puts there is what gets sent.
function setupRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  run("git", ["add", "tracked.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function reviewText(repo) {
  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  return collectReviewContext(repo, target).content;
}

function canSymlink() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cc-symlink-probe-"));
  const target = path.join(probe, "target.txt");
  fs.writeFileSync(target, "probe");
  try {
    fs.symlinkSync(target, path.join(probe, "link.txt"));
    return true;
  } catch {
    return false;
  }
}

const symlinkTest = canSymlink() ? test : test.skip;

symlinkTest("an untracked symlink is not followed into the prompt", () => {
  const repo = setupRepo();
  const secretDir = makeTempDir();
  const secretPath = path.join(secretDir, "id_rsa");
  fs.writeFileSync(secretPath, "SUPER_SECRET_PRIVATE_KEY_MATERIAL\n");

  fs.symlinkSync(secretPath, path.join(repo, "notes.md"));

  const content = reviewText(repo);
  assert.ok(content.includes("notes.md"), "the entry should still be listed");
  assert.doesNotMatch(content, /SUPER_SECRET_PRIVATE_KEY_MATERIAL/, "the link target must not be inlined");
  assert.match(content, /skipped: symlink/);
});

test("an untracked file whose name looks like a credential is held back", () => {
  const repo = setupRepo();
  for (const name of [".env", "id_rsa", "server.pem", ".npmrc"]) {
    fs.writeFileSync(path.join(repo, name), `SECRET_IN_${name}\n`);
  }

  const content = reviewText(repo);
  for (const name of [".env", "id_rsa", "server.pem", ".npmrc"]) {
    assert.doesNotMatch(
      content,
      new RegExp(`SECRET_IN_${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `${name} contents must not be inlined`
    );
  }
  assert.match(content, /skipped: name looks like a credential file/);
});

test("an ordinary untracked text file is still inlined", () => {
  const repo = setupRepo();
  fs.writeFileSync(path.join(repo, "notes.md"), "ORDINARY_UNTRACKED_CONTENT\n");

  const content = reviewText(repo);
  assert.match(content, /ORDINARY_UNTRACKED_CONTENT/);
});

test("env templates are shared on purpose and stay visible", () => {
  const repo = setupRepo();
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    fs.writeFileSync(path.join(repo, name), `TEMPLATE_BODY_${name.slice(5)}\n`);
  }

  const content = reviewText(repo);
  for (const suffix of ["example", "sample", "template"]) {
    assert.match(content, new RegExp(`TEMPLATE_BODY_${suffix}`), `.env.${suffix} should be inlined`);
  }
});
