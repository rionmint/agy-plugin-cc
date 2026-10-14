import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCursor, FAKE_SESSION_ID } from "./fake-cursor-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildHeadlessArgs,
  buildReviewPrompt,
  cursorChildEnv,
  extractSessionId,
  getCursorAuthStatus,
  getCursorAvailability,
  parseStructuredOutput,
  resolveCursorBinary,
  runHeadlessAgent,
  unwrapResultEnvelope
} from "../plugins/cursor-cc/scripts/lib/cursor.mjs";
import { runCommand } from "../plugins/cursor-cc/scripts/lib/process.mjs";

test("cursorChildEnv drops SHELL on Windows so Cursor runs its hooks with PowerShell", () => {
  const env = { SHELL: "/usr/bin/bash.exe", PATH: "C:\\bin", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(cursorChildEnv(env, "win32"), { PATH: "C:\\bin", ComSpec: "C:\\Windows\\system32\\cmd.exe" });
  assert.deepEqual(cursorChildEnv({ Shell: "bash", PATH: "x" }, "win32"), { PATH: "x" });
  assert.equal(env.SHELL, "/usr/bin/bash.exe");
  const noShell = { PATH: "x" };
  assert.equal(cursorChildEnv(noShell, "win32"), noShell);
});

test("cursorChildEnv keeps SHELL on other platforms", () => {
  const env = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
  assert.equal(cursorChildEnv(env, "darwin"), env);
  assert.equal(cursorChildEnv(env, "linux"), env);
});

test("resolveCursorBinary prefers CURSOR_AGENT_BINARY override", () => {
  assert.equal(resolveCursorBinary({ CURSOR_AGENT_BINARY: "/custom/cursor-agent" }), "/custom/cursor-agent");
  assert.equal(resolveCursorBinary({}), "cursor-agent");
});

test("getCursorAvailability reports available with fake cursor-agent on PATH", () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir);
  const env = buildEnv(binDir);

  const status = getCursorAvailability(process.cwd(), { env });
  assert.equal(status.available, true);
  assert.match(status.detail, /2026\.08\.25-fake|ok/i);
});

test("getCursorAuthStatus treats a successful status probe as logged in", () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir);
  const env = buildEnv(binDir, { CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "" });

  const auth = getCursorAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "status-probe");
});

test("getCursorAuthStatus treats `Not logged in` as not logged in", () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir, "not-logged-in");
  const env = buildEnv(binDir, { CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "" });

  const auth = getCursorAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /not logged in/i);
});

test("getCursorAuthStatus accepts an environment key without shelling out", () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir, "not-logged-in");
  const env = buildEnv(binDir, { CURSOR_API_KEY: "sk-fake" });

  const auth = getCursorAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.authMethod, "api-key");
});

test("buildHeadlessArgs uses --workspace, --mode and --trust", () => {
  const args = buildHeadlessArgs({
    cwd: "/repo",
    mode: "ask",
    model: "auto",
    outputFormat: "json"
  });

  assert.deepEqual(args, [
    "--print",
    "--workspace",
    "/repo",
    "--mode",
    "ask",
    "--model",
    "auto",
    "--output-format",
    "json",
    "--trust"
  ]);
});

test("buildHeadlessArgs keeps the prompt off the command line", () => {
  const args = buildHeadlessArgs({ cwd: "/repo", mode: "ask" });
  assert.ok(!args.includes("-p"));
  assert.ok(!args.some((arg) => arg.includes("%")));
});

test("buildHeadlessArgs resumes an existing session instead of assigning one", () => {
  const args = buildHeadlessArgs({ resumeSessionId: "abc-123" });
  assert.equal(args[0], "--resume");
  assert.equal(args[1], "abc-123");
  assert.ok(!args.includes("--session-id"));
});

test("buildHeadlessArgs adds --force only for a write run", () => {
  assert.ok(buildHeadlessArgs({ force: true }).includes("--force"));
  assert.ok(!buildHeadlessArgs({ mode: "ask" }).includes("--force"));
});

test("asking for write access and a read-only mode at once is an error", () => {
  // Silently honouring one of the two is how a read-only request becomes a
  // write run, so the combination is refused instead.
  assert.throws(
    () => buildHeadlessArgs({ force: true, mode: "ask" }),
    /both a read-only mode \(ask\) and write access/
  );
});

test("runHeadlessAgent captures stdout and session id from fake cursor-agent", async () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    mode: "ask",
    outputFormat: "json"
  });

  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(result.threadId, FAKE_SESSION_ID);
  assert.ok(result.args.includes("--print"));
  assert.ok(result.args.includes("--mode"));
  assert.ok(result.args.includes("ask"));
  assert.ok(result.args.includes("--trust"));
});

test("runHeadlessAgent reports agentPid from the spawned child", async () => {
  const binDir = makeTempDir();
  installFakeCursor(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "pid check",
    env,
    onProgress: (event) => progressEvents.push(event)
  });

  assert.equal(typeof result.agentPid, "number");
  assert.ok(result.agentPid > 0);
  assert.ok(progressEvents.some((event) => event?.agentPid === result.agentPid));
});

test("unwrapResultEnvelope returns the assistant text for a json run", () => {
  const raw = JSON.stringify({ type: "result", result: "the answer", session_id: FAKE_SESSION_ID });
  const { text, envelope } = unwrapResultEnvelope(raw);
  assert.equal(text, "the answer");
  assert.equal(envelope.session_id, FAKE_SESSION_ID);
});

test("unwrapResultEnvelope leaves plain text alone", () => {
  const { text, envelope } = unwrapResultEnvelope("just words");
  assert.equal(text, "just words");
  assert.equal(envelope, null);
});

test("extractSessionId finds the id in a json envelope", () => {
  const raw = `noise\n${JSON.stringify({ type: "result", session_id: FAKE_SESSION_ID })}\n`;
  assert.equal(extractSessionId(raw), FAKE_SESSION_ID);
});

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput unwraps the cursor result envelope first", () => {
  const raw = JSON.stringify({
    type: "result",
    result: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
    session_id: FAKE_SESSION_ID
  });
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});

test("live cursor-agent --help advertises the headless flags this bridge uses", () => {
  const help = runCommand("cursor-agent", ["--help"], { cwd: process.cwd() });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // Optional smoke test; only runs when a real Cursor CLI is installed.
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  for (const flag of [
    "-p",
    "--print",
    "--output-format",
    "--mode",
    "--workspace",
    "--trust",
    "--model",
    "--resume",
    "--continue",
    "--force"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
