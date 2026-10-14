import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeAgy, lastPrintRun } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/agy-cc/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "agy-cc");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

test("check reports ready when fake agy is installed and signed in", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.agy.available, true);
  assert.match(payload.agyHome, /agy-homes$/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.equal(payload.reviewGateEnabled, undefined);
});

test("check reports not ready when agy models says to sign in", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "not-logged-in");

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.length > 0);
});

test("check ignores legacy review-gate flags as unknown options", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);

  const result = run("node", [SCRIPT, "check", "--enable-review-gate", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.reviewGateEnabled, undefined);
  assert.match(result.stderr, /ignoring unknown option/);
});

test("review renders a no-findings style result from fake agy", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes|No material issues found/i);
  assert.match(result.stdout, /# agy Review/);
  assert.match(result.stdout, /Target:/);
});

test("critique returns structured findings payload path", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run("node", [SCRIPT, "critique", "--json", "focus on docs"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
});

function setupReviewableRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeAgyLog = path.join(pluginDataDir, "fake-agy.log");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeAgyLog };
}

function lastFakeAgyArgv(logPath) {
  const entry = lastPrintRun(logPath);
  assert.ok(entry, "expected a headless agy -p= invocation");
  return entry.argv;
}

test("review forwards --model and --mode to agy", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "review", "--model", "auto", "--mode", "plan"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeAgyArgv(fakeAgyLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "auto");
  assert.ok(argv.includes("--mode"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
});

test("critique forwards --model and --mode to agy", () => {
  const { repo, binDir, pluginDataDir, fakeAgyLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "critique", "--model", "auto", "--mode", "plan", "focus on race conditions"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeAgyArgv(fakeAgyLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "auto");
  assert.ok(argv.includes("--mode"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
});

test("review rejects unsupported --mode values", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  for (const mode of ["accept-edits", "yolo", "write"]) {
    const result = run("node", [SCRIPT, "review", "--mode", mode], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, `expected rejection for --mode ${mode}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported mode/i);
  }
});

test("run delegates through fake agy and stores a finished job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("runs and show surface the latest finished run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const task = run("node", [SCRIPT, "run", "--json", "do a small thing"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const status = run("node", [SCRIPT, "runs", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished);
  assert.equal(statusPayload.latestFinished.status, "completed");
  assert.equal(statusPayload.needsReview, undefined);

  const result = run("node", [SCRIPT, "show"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /agy conversation ID: /);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  // Zombies still accept kill(0); treat them as not running.
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("stop terminates a tracked sleeper process and marks run cancelled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Stopping a run verifies that the pid still looks like something this plugin
  // started before signalling it, so the stand-ins have to carry a matching
  // command line rather than being anonymous `node -e` processes.
  const agentStub = path.join(repo, "agy-stub-bin/agy");
  const bridgeStub = path.join(repo, "agy-bridge.mjs.stub.mjs");
  const stubSource = "setInterval(() => {}, 1000);";
  fs.mkdirSync(path.dirname(agentStub), { recursive: true });
  fs.writeFileSync(agentStub, stubSource, "utf8");
  fs.writeFileSync(bridgeStub, stubSource, "utf8");

  const agent = spawn(process.execPath, [agentStub], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  agent.unref();
  const bridge = spawn(process.execPath, [bridgeStub], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  bridge.unref();
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const jobsDir = path.join(resolveStateDir(repo), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const logFile = path.join(jobsDir, `${jobId}.log`);
    fs.writeFileSync(logFile, "", "utf8");
    const job = {
      id: jobId,
      kind: "task",
      kindLabel: "delegate",
      title: "agy Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "fake running",
      status: "running",
      phase: "running",
      bridgePid,
      pid: bridgePid,
      agentPid,
      logFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);

    const result = run("node", [SCRIPT, "stop", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.killDelivered, true);
    assert.ok(payload.killTargets?.includes(agentPid));
    assert.ok(payload.killTargets?.includes(bridgePid));

    const jobs = listJobs(repo);
    const cancelled = jobs.find((entry) => entry.id === jobId);
    assert.equal(cancelled?.status, "cancelled");

    // Both process trees must actually be dead.
    assert.equal(processAlive(agentPid), false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }
});

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/agy-cc/scripts/agy-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "agy Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const stored = readStoredJobFromDisk(repo, jobId);
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    const jobs = listJobs(repo);
    assert.equal(jobs[0].pid, 424242);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

function readStoredJobFromDisk(workspaceRoot, jobId) {
  const jobFile = path.join(resolveStateDir(workspaceRoot), "jobs", `${jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

test("run-resume-candidate reports available after a completed run with thread id", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sessionId = "claude-session-1";
  const task = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      AGY_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(task.status, 0, task.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      AGY_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);
});

test("a failed agy run marks the job failed and says why", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "timeout");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "run", "count to a million"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /agy run problems:/);
  assert.match(result.stdout, /--print-timeout/);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    assert.equal(listJobs(repo)[0].status, "failed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("a long review goes through a prompt file that is cleaned up afterwards", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeAgyLog = path.join(pluginDataDir, "fake-agy.log");
  installFakeAgy(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "big.txt"), "a\n");
  run("git", ["add", "big.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "big.txt"), "changed line\n".repeat(3000));

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const entry = lastPrintRun(fakeAgyLog);
  assert.ok(entry.promptFile, "the prompt went through a file");
  assert.match(entry.prompt, /changed line/);
  assert.equal(fs.existsSync(entry.promptFile), false, "the prompt file was removed after the run");
});

test("image copies the drawn picture out of agy's conversation folder", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "image");

  const out = path.join(repo, "robot.png");
  const result = run("node", [SCRIPT, "image", "--out", out, "--aspect", "1:1", "--json", "a small robot"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // The fake draws JPEG, so the .png name is corrected rather than kept.
  assert.equal(payload.output.path, path.join(repo, "robot.jpg"));
  assert.equal(payload.output.type, "jpeg");
  const bytes = fs.readFileSync(payload.output.path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(payload.output.source, /brain/);
});

test("image never overwrites an existing file", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "image");
  const out = path.join(repo, "pic.jpg");
  fs.writeFileSync(out, "keep me");

  const result = run("node", [SCRIPT, "image", "--out", out, "--json", "a cat"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), "keep me");
  assert.equal(JSON.parse(result.stdout).output.path, path.join(repo, "pic-2.jpg"));
});

test("image fails clearly when agy drew nothing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "no-image");

  const result = run("node", [SCRIPT, "image", "a dog"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /No image was produced/);
});

test("image rejects a bad aspect ratio and a missing reference before running", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeAgyLog = path.join(pluginDataDir, "fake-agy.log");
  installFakeAgy(binDir, "image");
  const env = pluginDataEnv(pluginDataDir, binDir, { FAKE_AGY_LOG: fakeAgyLog });

  const badAspect = run("node", [SCRIPT, "image", "--aspect", "wide", "x"], { cwd: repo, env });
  assert.notEqual(badAspect.status, 0);
  assert.match(badAspect.stderr, /Unsupported aspect ratio/);

  const missingRef = run("node", [SCRIPT, "image", "--ref", path.join(repo, "none.jpg"), "x"], { cwd: repo, env });
  assert.notEqual(missingRef.status, 0);
  assert.match(missingRef.stderr, /Reference image not found/);
  assert.equal(lastPrintRun(fakeAgyLog), null);
});

test("a run continued after a refused permission says so and suggests --add-dir", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "denied-once");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "run", "read the sibling repository"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Recovered without the refused permission/);
  assert.match(result.stdout, /Notes:/);
  assert.match(result.stdout, /continued the same conversation once/);
});

test("image runs are listed as image, not as a generic run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "image");

  const image = run("node", [SCRIPT, "image", "a lamp"], { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) });
  assert.equal(image.status, 0, image.stderr);
  const runs = run("node", [SCRIPT, "runs", "--json"], { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) });
  assert.equal(JSON.parse(runs.stdout).latestFinished.kindLabel, "image");
});

test("an image saved from a run that timed out is kept but the run still fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "image-timeout");

  const result = run("node", [SCRIPT, "image", "--json", "a boat"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0, "a timed-out run is not a success");
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.output?.path, "the picture that exists is still saved");
  assert.ok(fs.existsSync(payload.output.path));
  assert.ok(payload.agy.failures.some((reason) => /--print-timeout/.test(reason)));
});

test("a critique whose structured output has the wrong shape fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "bad-shape");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "b\n");

  const result = run("node", [SCRIPT, "critique"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /unexpected review shape/);
});

test("a critique with a malformed finding or verdict is a failure", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeAgy(binDir, "bad-nested");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "b\n");

  const result = run("node", [SCRIPT, "critique"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /verdict` must be|findings\[0\]/);
});
