import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cursor-cc");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set is complete and does not expose continue", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md"
  ]);
});

test("plugin surfaces use /cursor-cc names and the cursor-agent binary, not codex", () => {
  const files = [
    "commands/check.md",
    "commands/review.md",
    "commands/critique.md",
    "commands/delegate.md",
    "commands/runs.md",
    "commands/show.md",
    "commands/stop.md",
    "agents/cursor-delegate.md",
    "hooks/hooks.json",
    "skills/cursor-delegate-runtime/SKILL.md",
    "skills/cursor-run-output/SKILL.md",
    "scripts/cursor-bridge.mjs"
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
    assert.doesNotMatch(source, /codex-companion/, `${file} should not reference codex-companion`);
  }

  const bridge = read("scripts/cursor-bridge.mjs");
  assert.match(bridge, /cursor-bridge/);
  assert.match(bridge, /CURSOR_AGENT_BINARY|resolveCursorBinary|getCursorAvailability/);
  assert.doesNotMatch(bridge, /enable-review-gate|stopReviewGate|stop-review-gate/);

  const review = read("commands/review.md");
  assert.match(review, /\/cursor-cc:review/);
  assert.match(review, /cursor-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Prefer the bridge's own detached worker/i);
  assert.match(review, /Bridge `--background` owns the long-running process group/i);
  assert.doesNotMatch(review, /is what actually detaches the run/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return Cursor's output verbatim to the user/i);
  assert.match(review, /The bridge script parses `--wait` and `--background`/);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--mode <ask\|plan>/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/cursor-cc:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/cursor-cc:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);
  assert.match(critique, /--model <model>/);
  assert.match(critique, /--mode <ask\|plan>/);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "cursor-cc:cursor-delegate"/);
  assert.match(delegate, /do not call `Skill\(cursor-cc:cursor-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current Cursor thread/);
  assert.match(delegate, /Start a new Cursor thread/);

  const agent = read("agents/cursor-delegate.md");
  assert.match(agent, /cursor-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);

  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.doesNotMatch(hooks, /stop-review-gate-hook\.mjs/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);

  const check = read("commands/check.md");
  assert.match(check, /cursor-bridge\.mjs" check --json/);
  assert.doesNotMatch(check, /enable-review-gate|disable-review-gate/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const command of ["check", "review", "critique", "delegate", "runs", "show", "stop"]) {
    assert.match(readme, new RegExp(`/cursor-cc:${command}`), `README should document /cursor-cc:${command}`);
  }
  assert.doesNotMatch(readme, /\/cursor-cc:import/);
  assert.match(readme, /plugin install cursor-cc@rionmint-cursor-cc/);
  assert.doesNotMatch(readme, /\bcodex\b/i);
  assert.doesNotMatch(readme, /review-gate|enable-review-gate/i);
});

test("runtime skill only forwards run once", () => {
  const runtimeSkill = read("skills/cursor-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /cursor-bridge\.mjs" run '<raw arguments>'/);
  // The forwarded string reaches a shell, so it must be single-quoted.
  assert.doesNotMatch(runtimeSkill, /run "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);

  const resultHandling = read("skills/cursor-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Cursor run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Cursor was never successfully invoked, do not generate a substitute answer at all/i);
});
