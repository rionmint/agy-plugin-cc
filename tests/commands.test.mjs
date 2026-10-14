import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy-cc");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

const SURFACE_FILES = [
  "commands/check.md",
  "commands/review.md",
  "commands/critique.md",
  "commands/delegate.md",
  "commands/image.md",
  "commands/runs.md",
  "commands/show.md",
  "commands/stop.md",
  "agents/agy-delegate.md",
  "hooks/hooks.json",
  "prompts/critique.md",
  "skills/agy-delegate-runtime/SKILL.md",
  "skills/agy-run-output/SKILL.md",
  "scripts/agy-bridge.mjs"
];

test("command set is complete and does not expose continue", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "image.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md"
  ]);
});

test("no surface still talks about the CLI this plugin was ported from", () => {
  for (const file of SURFACE_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcursor\b|cursor-agent|cursor-cc/i, `${file} should not mention cursor`);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
  }
  for (const file of ["README.md", "SECURITY.md"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /\/cursor-cc:|cursor-agent --/i, `${file} should not document cursor commands`);
  }
});

test("plugin surfaces use /agy-cc names and the agy bridge", () => {
  const bridge = read("scripts/agy-bridge.mjs");
  assert.match(bridge, /agy-bridge/);
  assert.match(bridge, /getAgyAvailability/);
  assert.doesNotMatch(bridge, /dangerously-skip-permissions/);

  const review = read("commands/review.md");
  assert.match(review, /\/agy-cc:review/);
  assert.match(review, /agy-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Prefer the bridge's own detached worker/i);
  assert.match(review, /Bridge `--background` owns the long-running process group/i);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return agy's output verbatim to the user/i);
  assert.match(review, /The bridge script parses `--wait` and `--background`/);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--mode plan/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/agy-cc:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/agy-cc:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "agy-cc:agy-delegate"/);
  assert.match(delegate, /do not call `Skill\(agy-cc:agy-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current agy thread/);
  assert.match(delegate, /Start a new agy thread/);

  const image = read("commands/image.md");
  assert.match(image, /agy-bridge\.mjs" image/);
  assert.match(image, /image --background/);
  assert.match(image, /single quote, a backtick/);

  const agent = read("agents/agy-delegate.md");
  assert.match(agent, /agy-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /`--allow-commands` \(always together with `--write`\)/);

  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);

  const check = read("commands/check.md");
  assert.match(check, /agy-bridge\.mjs" check --json/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const command of ["check", "review", "critique", "delegate", "image", "runs", "show", "stop"]) {
    assert.match(readme, new RegExp(`/agy-cc:${command}`), `README should document /agy-cc:${command}`);
  }
  assert.match(readme, /plugin install agy-cc@rionmint-agy-cc/);
});

test("runtime skill only forwards run once", () => {
  const runtimeSkill = read("skills/agy-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /agy-bridge\.mjs" run '<raw arguments>'/);
  // The forwarded string reaches a shell, so it must be single-quoted.
  assert.doesNotMatch(runtimeSkill, /run "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `image`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);

  const resultHandling = read("skills/agy-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete agy run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if agy was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(resultHandling, /agy run problems/);
});
