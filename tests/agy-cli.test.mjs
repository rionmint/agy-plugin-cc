import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEnv,
  FAKE_CONVERSATION_ID,
  installFakeAgy,
  lastPrintRun,
  readFakeAgyLog
} from "./fake-agy-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  agyChildEnv,
  buildAgySettings,
  buildHeadlessArgs,
  buildImagePrompt,
  buildPromptDelivery,
  buildReviewPrompt,
  detectImageType,
  EXPECTED_PERMISSION_MODE,
  getAgyAuthStatus,
  getAgyAvailability,
  INLINE_PROMPT_MAX_CHARS,
  judgeAgyRun,
  listConversationImages,
  parseStructuredOutput,
  PERMISSION_PROFILES,
  prepareAgyHome,
  removePromptDelivery,
  resolveAgyBinary,
  resolveAgyHome,
  resolveAgyHomeRoot,
  syncConversationInto,
  resolvePermissionProfile,
  runAgyWithRecovery,
  runHeadlessAgent,
  settingsMatchProfile,
  assertPrivateHomes
} from "../plugins/agy-cc/scripts/lib/agy.mjs";
import { buildCmdLine, runCommand } from "../plugins/agy-cc/scripts/lib/process.mjs";
import { buildProcessMarkers, OUR_PROCESS_MARKERS } from "../plugins/agy-cc/scripts/lib/tracked-jobs.mjs";
import { resolvePluginDataDir } from "../plugins/agy-cc/scripts/lib/state.mjs";
import { takePluginDataOption } from "../plugins/agy-cc/scripts/agy-bridge.mjs";

function fakeSetup(scenario = "default", extra = {}) {
  const binDir = makeTempDir();
  const home = makeTempDir();
  const realHome = makeTempDir();
  const cwd = makeTempDir();
  const log = path.join(makeTempDir(), "fake-agy.log");
  installFakeAgy(binDir, scenario);
  const env = buildEnv(binDir, { FAKE_AGY_LOG: log, ...extra });
  return { binDir, home, realHome, cwd, log, env };
}

test("resolveAgyBinary prefers AGY_BINARY", () => {
  assert.equal(resolveAgyBinary({ AGY_BINARY: "/custom/agy" }), "/custom/agy");
  assert.equal(resolveAgyBinary({}), "agy");
});

test("each permission profile has its own agy home under one root", () => {
  assert.equal(resolveAgyHomeRoot({ AGY_CC_HOME: "/x/home" }), path.resolve("/x/home"));
  assert.equal(resolveAgyHomeRoot({ CLAUDE_PLUGIN_DATA: "/data" }), path.join("/data", "agy-homes"));
  assert.match(resolveAgyHomeRoot({}), /agy-cc-homes$/);
  const env = { CLAUDE_PLUGIN_DATA: "/data" };
  assert.equal(resolveAgyHome("read-only", env), path.join("/data", "agy-homes", "read-only"));
  assert.equal(resolveAgyHome("write-commands", env), path.join("/data", "agy-homes", "write-commands"));
  assert.throws(() => resolveAgyHome("../../etc", env), /Unknown permission profile/);
});

test("the plugin's own data directory wins over a CLAUDE_PLUGIN_DATA another plugin exported", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/data/cursor-cc-rionmint-cursor-cc", AGY_CC_PLUGIN_DATA: "/data/agy-cc-rionmint-agy-cc" };
  assert.equal(resolvePluginDataDir(env), "/data/agy-cc-rionmint-agy-cc");
  assert.equal(resolveAgyHomeRoot(env), path.join("/data/agy-cc-rionmint-agy-cc", "agy-homes"));
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: "/data/x", AGY_CC_PLUGIN_DATA: "  " }), "/data/x");
  assert.equal(resolvePluginDataDir({}), null);
});

test("--plugin-data is taken off the command line wherever it is and becomes AGY_CC_PLUGIN_DATA", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/other-plugin" };
  assert.deepEqual(takePluginDataOption(["check", "--plugin-data", "/mine", "--json"], env), ["check", "--json"]);
  assert.equal(env.AGY_CC_PLUGIN_DATA, path.resolve("/mine"));
  const inline = {};
  assert.deepEqual(takePluginDataOption(["review", "--plugin-data=/x y", "--base main"], inline), ["review", "--base main"]);
  assert.equal(inline.AGY_CC_PLUGIN_DATA, path.resolve("/x y"));
  const empty = {};
  assert.deepEqual(takePluginDataOption(["runs", "--plugin-data", ""], empty), ["runs"]);
  assert.equal(empty.AGY_CC_PLUGIN_DATA, undefined, "an unexpanded or empty value is ignored");
  const untouched = {};
  assert.deepEqual(takePluginDataOption(["run", "fix it --plugin-data /evil"], untouched), ["run", "fix it --plugin-data /evil"]);
  assert.equal(untouched.AGY_CC_PLUGIN_DATA, undefined, "text inside the raw arguments is not an option");
});

test("agyChildEnv swaps USERPROFILE on Windows and leaves HOME alone", () => {
  const env = { USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me", PATH: "x" };
  const next = agyChildEnv(env, "D:\\plugin-home", "win32");
  assert.equal(next.USERPROFILE, "D:\\plugin-home");
  assert.equal(next.HOME, "/c/Users/me");
  assert.equal(env.USERPROFILE, "C:\\Users\\me", "the caller's env is not mutated");
  // Case-insensitive on Windows: an existing `UserProfile` is reused, not duplicated.
  const mixed = agyChildEnv({ UserProfile: "C:\\u" }, "D:\\h", "win32");
  assert.deepEqual(Object.keys(mixed), ["UserProfile"]);
  assert.equal(mixed.UserProfile, "D:\\h");
});

test("agyChildEnv swaps HOME on macOS and Linux", () => {
  const next = agyChildEnv({ HOME: "/Users/me" }, "/data/agy-home", "darwin");
  assert.equal(next.HOME, "/data/agy-home");
});

test("permission profiles deny state changes by rule, never by asking", () => {
  const readOnly = PERMISSION_PROFILES["read-only"];
  for (const rule of ["write_file(*)", "command(*)", "unsandboxed(*)", "execute_url(*)", "mcp(*)"]) {
    assert.ok(readOnly.deny.includes(rule), rule);
  }
  assert.ok(!PERMISSION_PROFILES.write.deny.includes("write_file(*)"));
  assert.ok(PERMISSION_PROFILES.write.deny.includes("command(*)"));
  assert.ok(PERMISSION_PROFILES["write-commands"].allow.includes("command(*)"));
  // unsandboxed(*) blocks every command on Windows, so it must not survive
  // into the profile that is meant to run commands.
  assert.ok(!PERMISSION_PROFILES["write-commands"].deny.includes("unsandboxed(*)"));
});

test("resolvePermissionProfile maps flags to profiles and refuses commands without write", () => {
  assert.equal(resolvePermissionProfile({}), "read-only");
  assert.equal(resolvePermissionProfile({ write: true }), "write");
  assert.equal(resolvePermissionProfile({ write: true, allowCommands: true }), "write-commands");
  assert.throws(() => resolvePermissionProfile({ allowCommands: true }), /--allow-commands requires --write/);
});

test("buildAgySettings always asks for request-review and keeps paid credits off", () => {
  const settings = buildAgySettings("read-only", { model: "Gemini 4 Argon (High)" });
  assert.equal(settings.toolPermission, EXPECTED_PERMISSION_MODE);
  assert.equal(settings.useG1Credits, false);
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.equal(settings.model, "Gemini 4 Argon (High)");
  assert.deepEqual(settings.permissions.ask, []);
  assert.throws(() => buildAgySettings("yolo"), /Unknown permission profile/);
});

test("prepareAgyHome writes the profile and a gitconfig that includes the user's", () => {
  const home = makeTempDir();
  const realHome = makeTempDir();
  fs.mkdirSync(path.join(realHome, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(
    path.join(realHome, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ model: "Gemini 4 Argon (High)", toolPermission: "always-proceed" })
  );

  const settingsFile = prepareAgyHome(home, "read-only", { realHome });
  const written = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(written.toolPermission, "request-review", "the user's always-proceed is not copied");
  assert.equal(written.model, "Gemini 4 Argon (High)", "the user's model choice is kept");
  assert.ok(written.permissions.deny.includes("command(*)"));

  const gitconfig = fs.readFileSync(path.join(home, ".gitconfig"), "utf8");
  assert.match(gitconfig, /\[include\]/);
  assert.ok(gitconfig.includes(path.join(realHome, ".gitconfig").replace(/\\/g, "/")));
});

test("buildHeadlessArgs attaches the prompt to -p and always disables slash commands", () => {
  const args = buildHeadlessArgs({ promptArg: "--looks like a flag", model: "gemini-3.8-flash-low", effort: "high" });
  assert.equal(args[0], "-p=--looks like a flag");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--print-timeout") + 1], "3600s");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("buildHeadlessArgs resumes a conversation and adds directories and a schema", () => {
  const args = buildHeadlessArgs({
    promptArg: "go on",
    resumeConversationId: FAKE_CONVERSATION_ID,
    addDirs: ["/a", "/b"],
    jsonSchemaPath: "/schemas/review.json",
    printTimeout: "600s"
  });
  assert.equal(args[args.indexOf("--conversation") + 1], FAKE_CONVERSATION_ID);
  assert.deepEqual(
    args.flatMap((token, index) => (token === "--add-dir" ? [args[index + 1]] : [])),
    ["/a", "/b"]
  );
  assert.equal(args[args.indexOf("--json-schema") + 1], "/schemas/review.json");
  assert.equal(args[args.indexOf("--print-timeout") + 1], "600s");
});

test("asking for write access and plan mode at once is an error", () => {
  assert.throws(() => buildHeadlessArgs({ promptArg: "x", write: true, mode: "plan" }), /both --mode plan and write access/);
});

test("an empty prompt or a NUL byte is refused", () => {
  assert.throws(() => buildHeadlessArgs({ promptArg: "  " }), /A prompt is required/);
  assert.throws(() => buildHeadlessArgs({ promptArg: "a\0b" }), /NUL/);
});

test("short prompts go inline and long ones go through a prompt file", () => {
  const runDir = path.join(makeTempDir(), "run");
  const env = { PATH: "" };
  const short = buildPromptDelivery({ prompt: "hello", runDir, binary: "/opt/agy", env, platform: "linux" });
  assert.equal(short.promptArg, "hello");
  assert.equal(short.promptFile, null);

  const longText = "x".repeat(INLINE_PROMPT_MAX_CHARS + 1);
  const long = buildPromptDelivery({ prompt: longText, runDir, binary: "/opt/agy", env, platform: "linux" });
  assert.equal(fs.readFileSync(long.promptFile, "utf8"), longText);
  assert.deepEqual(long.addDirs, [long.promptDir]);
  assert.equal(path.dirname(long.promptDir), runDir, "a fresh directory inside the run directory");
  assert.match(long.promptArg, /Your complete instructions are in the file .+prompt\.md \. /);
  assert.ok(long.promptArg.length < 400);
});

test("a .cmd shim on Windows never receives the prompt inline", () => {
  const binDir = makeTempDir();
  fs.writeFileSync(path.join(binDir, "agy.cmd"), "@echo off\r\n");
  const runDir = path.join(makeTempDir(), "run");
  const delivery = buildPromptDelivery({
    prompt: "echo %PATH% & whoami",
    runDir,
    binary: path.join(binDir, "agy.cmd"),
    env: { PATH: binDir, PATHEXT: ".CMD" },
    platform: "win32"
  });
  assert.ok(delivery.promptFile, "the prompt went to a file");
  assert.ok(!delivery.promptArg.includes("%PATH%"));
  assert.equal(fs.readFileSync(delivery.promptFile, "utf8"), "echo %PATH% & whoami");
});

test("judgeAgyRun treats agy's misleading successes as failures", () => {
  const ok = {
    status: 0,
    init: { permission_mode: "request-review" },
    startupValidated: true,
    result: { status: "SUCCESS", response: "fine" },
    finalMessage: "fine",
    deniedActions: [],
    stderr: ""
  };
  assert.deepEqual(judgeAgyRun(ok), []);

  const noInit = { ...ok, init: null, startupValidated: false };
  assert.ok(judgeAgyRun(noInit).some((reason) => /never reported its start-up event/.test(reason)));
  assert.ok(judgeAgyRun({ ...ok, settingsMismatch: true }).some((reason) => /not this run's profile/.test(reason)));
  assert.ok(judgeAgyRun({ ...ok, startupTimedOut: true }).some((reason) => /did not start within 90 seconds/.test(reason)));

  const denied = { ...ok, finalMessage: "", result: { status: "SUCCESS", response: "" }, deniedActions: [{ action: "read_file", display_name: "ViewFile" }] };
  assert.ok(judgeAgyRun(denied).some((reason) => /read_file\/ViewFile/.test(reason)));
  assert.ok(judgeAgyRun(denied).some((reason) => /empty response/.test(reason)));

  const timedOut = { ...ok, timedOut: true, printTimeout: "5s" };
  assert.ok(judgeAgyRun(timedOut).some((reason) => /--print-timeout \(5s\)/.test(reason)));

  const lostConversation = { ...ok, resumeConversationId: "abc-1", conversationId: "zzz-9", stderr: 'warning: conversation "abc-1" not found' };
  assert.ok(judgeAgyRun(lostConversation).some((reason) => /could not find conversation abc-1/.test(reason)));

  const errored = { ...ok, status: 1, result: { status: "ERROR", response: "", error: "invalid model selection" }, finalMessage: "" };
  assert.ok(judgeAgyRun(errored).some((reason) => /status ERROR: invalid model selection/.test(reason)));

  const structuredOnly = { ...ok, finalMessage: "", structuredOutput: { verdict: "approve" } };
  assert.deepEqual(judgeAgyRun(structuredOnly), []);
});

test("parseStructuredOutput prefers agy's structured_output over the response text", () => {
  const parsed = parseStructuredOutput({
    structuredOutput: { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
    finalMessage: '{"verdict":"needs-attention","toolAction":"x"}'
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput falls back to fenced JSON in the text", () => {
  const parsed = parseStructuredOutput({
    finalMessage: 'Here:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n'
  });
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput(
    { finalMessage: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}' },
    { parsed: { verdict: "needs-attention" }, parseError: "stale", rawOutput: "stale", status: 7 }
  );
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("buildReviewPrompt tells agy it has no terminal", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Terminal commands are not available/);
  assert.match(prompt, /Git Status/);
});

test("buildImagePrompt hands the work to the image subagent and forbids commands", () => {
  const prompt = buildImagePrompt({ description: "a robot", aspectRatio: "16:9", referencePaths: ["/r/a.jpg"] });
  assert.match(prompt, /Do not run any terminal command/);
  assert.match(prompt, /image generation subagent/);
  assert.match(prompt, /\/r\/a\.jpg/);
  assert.match(prompt, /Aspect ratio 16:9/);
});

test("detectImageType reads magic bytes, not names", () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).extension, ".jpg");
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).extension, ".png");
  assert.equal(detectImageType(Buffer.from("RIFF0000WEBP", "latin1")).extension, ".webp");
  assert.equal(detectImageType(Buffer.from("text")), null);
});

test("getAgyAvailability and the models probe work with a signed-in fake", async () => {
  const { cwd, env, home } = fakeSetup();
  assert.equal(getAgyAvailability(cwd, { env }).available, true);
  const auth = await getAgyAuthStatus(cwd, { env, home });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.verified, true);
  assert.deepEqual(auth.models, ["gemini-3.8-flash-low", "fake-model"]);
});

test("the models probe reports a signed-out account", async () => {
  const { cwd, env, home } = fakeSetup("not-logged-in");
  const auth = await getAgyAuthStatus(cwd, { env, home });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /not signed in/);
});

test("runHeadlessAgent runs agy in the plugin home with the requested profile", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup();
  const progress = [];
  const run = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    agyHomeRoot: home,
    realHome,
    permissionProfile: "read-only",
    onProgress: (event) => progress.push(event)
  });

  assert.deepEqual(run.failures, []);
  assert.equal(run.status, 0);
  assert.match(run.finalMessage, /Handled the requested task/);
  assert.equal(run.threadId, FAKE_CONVERSATION_ID);
  assert.equal(run.init.permission_mode, "request-review");

  const entry = lastPrintRun(log);
  assert.equal(path.resolve(entry.home), path.resolve(path.join(home, "read-only")), "agy saw the read-only profile home");
  assert.ok(entry.settings.permissions.deny.includes("write_file(*)"));
  assert.equal(path.resolve(entry.cwd), path.resolve(cwd));
  assert.equal(typeof run.agentPid, "number");
  assert.ok(progress.some((event) => /Running tool: view_file/.test(event?.message ?? "")));
});

test("runHeadlessAgent hands the write profile over when asked", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup();
  await runHeadlessAgent(cwd, { prompt: "edit it", env, agyHomeRoot: home, realHome, permissionProfile: "write" });
  const entry = lastPrintRun(log);
  assert.ok(!entry.settings.permissions.deny.includes("write_file(*)"));
  assert.ok(entry.settings.permissions.deny.includes("command(*)"));
});

test("a run that starts in the wrong permission mode is stopped and failed", async () => {
  const { cwd, env, home, realHome } = fakeSetup("always-proceed", { FAKE_AGY_DELAY_MS: "15000" });
  const started = Date.now();
  const run = await runHeadlessAgent(cwd, { prompt: "review", env, agyHomeRoot: home, realHome });
  assert.ok(Date.now() - started < 10000, "the run was killed at init, not left to finish");
  assert.ok(run.failures.some((reason) => /permission mode "always-proceed"/.test(reason)));
});

test("a signed-out run is killed as soon as agy asks for a browser login", async () => {
  const { cwd, env, home, realHome } = fakeSetup("not-logged-in");
  const started = Date.now();
  const run = await runHeadlessAgent(cwd, { prompt: "hi", env, agyHomeRoot: home, realHome });
  assert.ok(Date.now() - started < 10000, "did not wait for agy's own login timeout");
  assert.ok(run.failures.some((reason) => /not signed in/.test(reason)));
});

test("a print timeout is reported as a failure despite exit 0 and SUCCESS", async () => {
  const { cwd, env, home, realHome } = fakeSetup("timeout");
  const run = await runHeadlessAgent(cwd, { prompt: "count", env, agyHomeRoot: home, realHome, printTimeout: "5s" });
  assert.equal(run.status, 0);
  assert.equal(run.result.status, "SUCCESS");
  assert.ok(run.failures.some((reason) => /--print-timeout \(5s\)/.test(reason)));
});

test("resuming an unknown conversation is reported instead of silently starting over", async () => {
  const { cwd, env, home, realHome } = fakeSetup("unknown-conversation");
  const run = await runHeadlessAgent(cwd, {
    prompt: "continue",
    env,
    agyHomeRoot: home,
    realHome,
    resumeConversationId: "abcdef12-0000-4000-8000-000000000000"
  });
  assert.ok(run.failures.some((reason) => /could not find conversation abcdef12/.test(reason)));
});

test("a refused permission is recovered by continuing the same conversation once", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup("denied-once");
  const run = await runAgyWithRecovery(cwd, { prompt: "review this", env, agyHomeRoot: home, realHome });
  assert.deepEqual(run.failures, []);
  assert.equal(run.attempts, 2);
  assert.match(run.finalMessage, /Recovered without the refused permission/);

  const printRuns = readFakeAgyLog(log).filter((entry) => entry.argv.some((token) => token.startsWith("-p=")));
  assert.equal(printRuns.length, 2);
  const second = printRuns[1].argv;
  assert.equal(second[second.indexOf("--conversation") + 1], FAKE_CONVERSATION_ID);
  assert.match(printRuns[1].prompt, /RunCommand/);
});

test("recovery is not attempted for a timeout", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup("timeout");
  const run = await runAgyWithRecovery(cwd, { prompt: "count", env, agyHomeRoot: home, realHome });
  assert.equal(run.attempts, 1);
  assert.equal(readFakeAgyLog(log).filter((entry) => entry.argv.some((token) => token.startsWith("-p="))).length, 1);
});

test("long prompts reach the fake agy through the prompt file", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup();
  const runDir = path.join(makeTempDir(), "run-x");
  const prompt = `code review ${"y".repeat(INLINE_PROMPT_MAX_CHARS)}`;
  const run = await runHeadlessAgent(cwd, { prompt, env, agyHomeRoot: home, realHome, runDir });
  assert.deepEqual(run.failures, []);
  const entry = lastPrintRun(log);
  assert.equal(entry.prompt, prompt);
  assert.ok(entry.argv.includes("--add-dir"));
});

test("listConversationImages finds what an image run drew", async () => {
  const { cwd, env, home, realHome } = fakeSetup("image");
  const started = Date.now();
  const run = await runHeadlessAgent(cwd, { prompt: "draw", env, agyHomeRoot: home, realHome, requireResponse: false });
  const images = listConversationImages(path.join(home, "read-only"), run.conversationId, { sinceMs: started - 5000 });
  assert.equal(images.length, 1);
  assert.equal(detectImageType(fs.readFileSync(images[0].path)).type, "jpeg");
});

test("concurrent runs each get the profile they asked for, from their own home", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup("default", { FAKE_AGY_DELAY_MS: "300" });
  await Promise.all([
    runHeadlessAgent(cwd, { prompt: "read only please", env, agyHomeRoot: home, realHome, permissionProfile: "read-only" }),
    runHeadlessAgent(cwd, { prompt: "write please", env, agyHomeRoot: home, realHome, permissionProfile: "write" }),
    runHeadlessAgent(cwd, { prompt: "read only again", env, agyHomeRoot: home, realHome, permissionProfile: "read-only" })
  ]);
  for (const entry of readFakeAgyLog(log).filter((item) => item.argv.some((token) => token.startsWith("-p=")))) {
    const wantsWrite = /write please/.test(entry.prompt);
    assert.equal(entry.settings.permissions.deny.includes("write_file(*)"), !wantsWrite, entry.prompt);
    assert.equal(path.basename(entry.home), wantsWrite ? "write" : "read-only", entry.prompt);
  }
});

test("live agy --help advertises the headless flags this bridge uses", () => {
  const help = runCommand("agy", ["--help"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // Optional smoke test; only runs when a real Antigravity CLI is installed.
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  if (/1\.3\.5-fake/.test(text) || !/--print-timeout/.test(text) && /fake agy/.test(text)) {
    return;
  }
  for (const flag of [
    "--print",
    "--output-format",
    "--conversation",
    "--json-schema",
    "--print-timeout",
    "--mode",
    "--model",
    "--effort",
    "--add-dir",
    "--disable-slash-commands"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a profile swapped in while agy starts is caught right after init", async () => {
  const { cwd, env, home, realHome } = fakeSetup("foreign-settings", { FAKE_AGY_DELAY_MS: "15000" });
  const started = Date.now();
  const run = await runHeadlessAgent(cwd, { prompt: "review", env, agyHomeRoot: home, realHome, permissionProfile: "read-only" });
  assert.ok(Date.now() - started < 10000, "the run was stopped at init");
  assert.equal(run.settingsMismatch, true);
  assert.ok(run.failures.some((reason) => /not this run's profile/.test(reason)));
});

test("settingsMatchProfile accepts agy's normalised rewrite of the profile", () => {
  const home = makeTempDir();
  const file = prepareAgyHome(home, "write", { realHome: makeTempDir(), model: null });
  assert.equal(settingsMatchProfile(file, "write"), true);
  // agy drops default-valued keys when it rewrites the file.
  const rewritten = { permissions: { allow: [...PERMISSION_PROFILES.write.allow], deny: [...PERMISSION_PROFILES.write.deny].reverse() } };
  fs.writeFileSync(file, JSON.stringify(rewritten));
  assert.equal(settingsMatchProfile(file, "write"), true);
  assert.equal(settingsMatchProfile(file, "read-only"), false);
  fs.writeFileSync(file, JSON.stringify({ toolPermission: "always-proceed", permissions: rewritten.permissions }));
  assert.equal(settingsMatchProfile(file, "write"), false);
});

test("a run that never reports init is killed and failed", async () => {
  const { cwd, env, home, realHome } = fakeSetup("no-init");
  const run = await runHeadlessAgent(cwd, { prompt: "hi", env, agyHomeRoot: home, realHome, startupTimeoutMs: 1500 });
  assert.equal(run.startupTimedOut, true);
  assert.ok(run.failures.some((reason) => /did not start/.test(reason)));
});

test("a result without an init event is not accepted", async () => {
  const { cwd, env, home, realHome } = fakeSetup("result-without-init");
  const run = await runHeadlessAgent(cwd, { prompt: "hi", env, agyHomeRoot: home, realHome });
  assert.equal(run.result, null, "events before init are ignored");
  assert.ok(run.failures.some((reason) => /never reported its start-up event/.test(reason)));
});

test("a planted file in the run directory is neither overwritten nor removed", () => {
  const runDir = makeTempDir();
  const planted = path.join(runDir, "prompt.md");
  fs.writeFileSync(planted, "keep");
  const delivery = buildPromptDelivery({
    prompt: "z".repeat(INLINE_PROMPT_MAX_CHARS + 5),
    runDir,
    binary: "/opt/agy",
    env: { PATH: "" },
    platform: "linux"
  });
  assert.notEqual(delivery.promptFile, planted);
  assert.equal(fs.readFileSync(planted, "utf8"), "keep");
  removePromptDelivery(delivery);
  assert.equal(fs.existsSync(delivery.promptDir), false);
  assert.equal(fs.readFileSync(planted, "utf8"), "keep", "cleanup removed only what it created");
  assert.equal(fs.existsSync(runDir), true, "a run directory that already existed is kept");
});

test("a lost conversation is not rescued by the automatic follow-up turn", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup("unknown-conversation-denied");
  const run = await runAgyWithRecovery(cwd, {
    prompt: "continue",
    env,
    agyHomeRoot: home,
    realHome,
    resumeConversationId: "abcdef12-0000-4000-8000-000000000000"
  });
  assert.equal(run.attempts, 1);
  assert.ok(run.failures.some((reason) => /could not find conversation/.test(reason)));
  assert.equal(readFakeAgyLog(log).filter((entry) => entry.argv.some((token) => token.startsWith("-p="))).length, 1);
});

test("a batch file path that cmd would rewrite is refused", () => {
  assert.throws(() => buildCmdLine(String.raw`C:\tools\%SHIM_ROOT%\agy.cmd`, ["x"]), /cmd would rewrite/);
  assert.throws(() => buildCmdLine(String.raw`C:\tools\a!b\agy.cmd`, ["x"]), /cmd would rewrite/);
  assert.match(buildCmdLine(String.raw`C:\Program Files\agy\agy.cmd`, ["x"]), /"C:\\Program Files\\agy\\agy\.cmd"/);
});

test("the process markers match the recorded program at the start of the command line only", () => {
  assert.deepEqual(buildProcessMarkers([]), [...OUR_PROCESS_MARKERS]);
  const markers = buildProcessMarkers(["/opt/ag", String.raw`C:\tools\antigravity-cli.exe`, String.raw`C:\tools\agy.cmd`]);
  const matches = (line) => markers.some((marker) => (marker instanceof RegExp ? marker.test(line) : line.includes(marker)));
  assert.equal(matches("/opt/ag -p=x --output-format stream-json"), true, "a short name still counts");
  assert.equal(matches(String.raw`"C:\tools\antigravity-cli.exe" -p=x`), true);
  assert.equal(matches(String.raw`c:\TOOLS\ANTIGRAVITY-CLI.exe -p=x`), true, "Windows paths compare case-insensitively");
  assert.equal(matches(String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\tools\agy.cmd" ^"-p=x^""`), true, "the recorded shim");
  assert.equal(matches("/other/tools/ag -p=x"), false, "same name in another directory");
  assert.equal(matches("/usr/bin/foo /opt/ag"), false, "only as an argument");
  assert.equal(matches("/usr/bin/antigravity-cli-backup --run"), false);
});

test("settingsMatchProfile never throws and rejects malformed rule lists", () => {
  const home = makeTempDir();
  const file = prepareAgyHome(home, "read-only", { realHome: makeTempDir(), model: null });
  for (const broken of [
    { permissions: { allow: null, deny: [...PERMISSION_PROFILES["read-only"].deny] } },
    { permissions: { allow: "read_url(*)", deny: [] } },
    { permissions: { allow: [1], deny: [] } },
    { permissions: [] },
    { toolPermission: 7, permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny] } },
    { toolPermission: null, permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny] } },
    { permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny], ask: null } },
    { trustedWorkspaces: ["C:\\"], permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny] } },
    { artifactReviewPolicy: "always-proceed", permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny] } },
    { permissions: { allow: ["read_url(*)"], deny: [...PERMISSION_PROFILES["read-only"].deny], extra: [] } },
    []
  ]) {
    fs.writeFileSync(file, JSON.stringify(broken));
    assert.equal(settingsMatchProfile(file, "read-only"), false, JSON.stringify(broken));
  }
  fs.writeFileSync(file, "{not json");
  assert.equal(settingsMatchProfile(file, "read-only"), false);
  assert.equal(settingsMatchProfile(path.join(home, "missing.json"), "read-only"), false);
});

test("prepareAgyHome leaves an equivalent normalised file alone", () => {
  const home = makeTempDir();
  const file = prepareAgyHome(home, "write", { realHome: makeTempDir(), model: "M" });
  // What agy writes back: defaults dropped, empty ask dropped.
  const normalised = { model: "M", permissions: { allow: [...PERMISSION_PROFILES.write.allow], deny: [...PERMISSION_PROFILES.write.deny] }, showFeedbackSurvey: false, showTips: false };
  fs.writeFileSync(file, JSON.stringify(normalised));
  const before = fs.statSync(file, { bigint: true });
  prepareAgyHome(home, "write", { realHome: makeTempDir(), model: "M" });
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.ino, before.ino, "not rewritten");
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(normalised));
  prepareAgyHome(home, "write", { realHome: makeTempDir(), model: "Other" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "Other", "a real difference is written");
});

function seedConversation(root, profile, cid, { db = "db-v1", brainFile = "artifact", annotation = "ann" } = {}) {
  const base = path.join(root, profile, ".gemini", "antigravity-cli");
  fs.mkdirSync(path.join(base, "conversations"), { recursive: true });
  fs.writeFileSync(path.join(base, "conversations", `${cid}.db`), db);
  if (brainFile !== null) {
    fs.mkdirSync(path.join(base, "brain", cid, "scratch"), { recursive: true });
    fs.writeFileSync(path.join(base, "brain", cid, "scratch", "note.txt"), brainFile);
  }
  if (annotation !== null) {
    fs.mkdirSync(path.join(base, "annotations"), { recursive: true });
    fs.writeFileSync(path.join(base, "annotations", `${cid}.pbtxt`), annotation);
  }
  return base;
}

test("a conversation started read-only is copied into the write home before it is resumed", () => {
  const root = makeTempDir();
  const cid = "abcdef12-0000-4000-8000-000000000001";
  seedConversation(root, "read-only", cid);
  const writeHome = path.join(root, "write");
  const target = path.join(writeHome, ".gemini", "antigravity-cli");
  fs.mkdirSync(path.join(target, "brain", cid), { recursive: true });
  fs.writeFileSync(path.join(target, "brain", cid, "old.txt"), "older artifact");

  assert.equal(syncConversationInto(root, writeHome, cid), path.join(root, "read-only"));
  assert.equal(fs.readFileSync(path.join(target, "conversations", `${cid}.db`), "utf8"), "db-v1");
  assert.equal(fs.readFileSync(path.join(target, "brain", cid, "scratch", "note.txt"), "utf8"), "artifact");
  assert.equal(fs.existsSync(path.join(target, "brain", cid, "old.txt")), false, "artifacts are replaced, not merged");
  assert.equal(fs.readFileSync(path.join(target, "annotations", `${cid}.pbtxt`), "utf8"), "ann");
  const sourceDb = path.join(root, "read-only", ".gemini", "antigravity-cli", "conversations", `${cid}.db`);
  assert.equal(
    Math.round(fs.statSync(path.join(target, "conversations", `${cid}.db`)).mtimeMs),
    Math.round(fs.statSync(sourceDb).mtimeMs),
    "the copy keeps the source's time, so it does not look newer than it is"
  );
  assert.equal(syncConversationInto(root, writeHome, cid), null, "nothing newer elsewhere");
  assert.throws(() => syncConversationInto(root, writeHome, "../escape"), /unsafe conversation value/);
});

test("a conversation with an open journal on either side is not copied", () => {
  const root = makeTempDir();
  const cid = "abcdef12-0000-4000-8000-000000000002";
  const source = seedConversation(root, "read-only", cid);
  fs.writeFileSync(path.join(source, "conversations", `${cid}.db-shm`), "open");
  assert.throws(() => syncConversationInto(root, path.join(root, "write"), cid), /looks open in another agy run/);
  fs.rmSync(path.join(source, "conversations", `${cid}.db-shm`));

  const target = path.join(root, "write", ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${cid}.db-wal`), "stale");
  assert.throws(() => syncConversationInto(root, path.join(root, "write"), cid), /looks open in another agy run/);
  fs.rmSync(path.join(target, `${cid}.db-wal`));

  // A rollback journal (a write in progress, or a crash mid-write) counts too.
  fs.writeFileSync(path.join(source, "conversations", `${cid}.db-journal`), "hot");
  assert.throws(() => syncConversationInto(root, path.join(root, "write"), cid), /looks open in another agy run/);
});

test("a newer copy without artifacts leaves none of the older ones behind", () => {
  const root = makeTempDir();
  const cid = "abcdef12-0000-4000-8000-000000000004";
  const target = seedConversation(root, "write", cid, { db: "old", brainFile: "old artifact", annotation: "old ann" });
  const older = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(target, "conversations", `${cid}.db`), older, older);
  seedConversation(root, "read-only", cid, { db: "new", brainFile: null, annotation: null });

  assert.equal(syncConversationInto(root, path.join(root, "write"), cid), path.join(root, "read-only"));
  assert.equal(fs.readFileSync(path.join(target, "conversations", `${cid}.db`), "utf8"), "new");
  assert.equal(fs.existsSync(path.join(target, "brain", cid)), false, "brain the newer copy lacks is removed");
  assert.equal(fs.existsSync(path.join(target, "annotations", `${cid}.pbtxt`)), false, "annotation the newer copy lacks is removed");
  assert.deepEqual(fs.readdirSync(path.join(target, "brain")), [], "nothing is left aside");
});

test("a long prompt without a run directory gets a fresh temp directory of its own", () => {
  const delivery = buildPromptDelivery({
    prompt: "t".repeat(INLINE_PROMPT_MAX_CHARS + 5),
    runDir: null,
    binary: "/opt/agy",
    env: { PATH: "" },
    platform: "linux"
  });
  assert.equal(path.dirname(delivery.promptDir), path.resolve(os.tmpdir()));
  assert.match(path.basename(delivery.promptDir), /^agy-cc-prompt-/);
  assert.equal(fs.readFileSync(delivery.promptFile, "utf8").length, INLINE_PROMPT_MAX_CHARS + 5);
  removePromptDelivery(delivery);
  assert.equal(fs.existsSync(delivery.promptDir), false);
});

test("a conversation containing a link is not copied", () => {
  const root = makeTempDir();
  const cid = "abcdef12-0000-4000-8000-000000000003";
  const source = seedConversation(root, "read-only", cid);
  const outside = path.join(makeTempDir(), "secret.txt");
  fs.writeFileSync(outside, "do not copy");
  try {
    fs.symlinkSync(outside, path.join(source, "brain", cid, "scratch", "link.txt"), "file");
  } catch {
    // creating symlinks needs a privilege on some Windows set-ups; nothing to test then
    return;
  }
  assert.throws(() => syncConversationInto(root, path.join(root, "write"), cid), /contains a link/);
  assert.equal(fs.existsSync(path.join(root, "write", ".gemini", "antigravity-cli", "conversations", `${cid}.db`)), false);
});

test("profile homes that are links or the same directory stop the run", () => {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "read-only"), { recursive: true });
  // A junction needs no privilege on Windows; elsewhere it is a symlink.
  fs.symlinkSync(path.join(root, "read-only"), path.join(root, "write"), "junction");
  assert.throws(() => assertPrivateHomes(root), /link or not a directory/);
  assert.throws(() => prepareAgyHome(path.join(root, "write"), "write", { realHome: makeTempDir(), model: null }), /link or not a directory/);
});

test("a resumed run picks its conversation up from another profile home", async () => {
  const { cwd, env, home, realHome, log } = fakeSetup();
  const cid = FAKE_CONVERSATION_ID;
  const source = path.join(home, "read-only", ".gemini", "antigravity-cli", "conversations");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, `${cid}.db`), "from read-only");
  const progress = [];
  const run = await runHeadlessAgent(cwd, {
    prompt: "apply it",
    env,
    agyHomeRoot: home,
    realHome,
    permissionProfile: "write",
    resumeConversationId: cid,
    onProgress: (event) => progress.push(typeof event === "string" ? event : event.message)
  });
  assert.deepEqual(run.failures, []);
  assert.equal(path.resolve(run.migratedFrom), path.resolve(path.join(home, "read-only")));
  assert.equal(
    fs.readFileSync(path.join(home, "write", ".gemini", "antigravity-cli", "conversations", `${cid}.db`), "utf8"),
    "from read-only"
  );
  assert.ok(progress.some((message) => /Copied conversation/.test(message)));
  assert.equal(path.basename(lastPrintRun(log).home), "write");
});

test("prompt cleanup leaves a directory that was swapped out from under it", () => {
  const runDir = makeTempDir();
  const delivery = buildPromptDelivery({
    prompt: "q".repeat(INLINE_PROMPT_MAX_CHARS + 5),
    runDir,
    binary: "/opt/agy",
    env: { PATH: "" },
    platform: "linux"
  });
  // Something replaces the prompt directory with a different one holding a
  // file of the same name.
  fs.renameSync(delivery.promptDir, `${delivery.promptDir}-moved`);
  fs.mkdirSync(delivery.promptDir);
  fs.writeFileSync(path.join(delivery.promptDir, "prompt.md"), "not ours");
  removePromptDelivery(delivery);
  assert.equal(fs.readFileSync(path.join(delivery.promptDir, "prompt.md"), "utf8"), "not ours");
});

test("prepareAgyHome rewrites a file with keys it did not write", () => {
  const home = path.join(makeTempDir(), "read-only");
  const file = prepareAgyHome(home, "read-only", { realHome: makeTempDir(), model: null });
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), enableTelemetry: false, trustedWorkspaces: ["C:\\"] }));
  prepareAgyHome(home, "read-only", { realHome: makeTempDir(), model: null });
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.trustedWorkspaces, undefined);
  assert.equal(written.enableTelemetry, undefined);
  assert.equal(settingsMatchProfile(file, "read-only"), true);
});
