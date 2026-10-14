#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildImagePrompt,
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  detectImageType,
  getAgyAuthStatus,
  getAgyAvailability,
  IMAGE_FILE_EXTENSIONS,
  listConversationImages,
  parseStructuredOutput,
  readUserToolPermission,
  resolveAgyHome,
  resolvePermissionProfile,
  runAgyWithRecovery
} from "./lib/agy.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForSession,
  getSessionRuntimeStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  patchJobIfActive,
  removeRunDir,
  resolveRunDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  OUR_PROCESS_MARKERS,
  resolveJobKillTargets,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderImageResult,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// agy cannot run git in a read-only run, so the bridge collects the diff itself
// and hands all of it over (through a prompt file when it is long). Past this
// size the context drops to a file list and agy reads the files directly.
const REVIEW_MAX_INLINE_FILES = 400;
const REVIEW_MAX_INLINE_DIFF_BYTES = 1024 * 1024;
// One image took 54–269 s in the agy media manual's measurements.
const DEFAULT_IMAGE_TIMEOUT = "900s";
// `plan` is the one agy mode that changes behaviour for a bridge run. It is
// not the read-only boundary — the permission profile is — so it is optional.
const VALID_MODES = new Set(["plan"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ASPECT_RATIO_PATTERN = /^[1-9][0-9]?:[1-9][0-9]?$/;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-bridge.mjs check [--json]",
      "  node scripts/agy-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--mode plan] [--timeout <dur>]",
      "  node scripts/agy-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--mode plan] [--timeout <dur>] [focus text]",
      "  node scripts/agy-bridge.mjs run [--background] [--write [--allow-commands]] [--resume-last|--resume|--fresh] [--model <model>] [--effort <level>] [--mode plan] [--add-dir <dir>]... [--timeout <dur>] [prompt]",
      "  node scripts/agy-bridge.mjs image [--background] [--out <path>] [--aspect <w:h>] [--ref <image>]... [--model <model>] [--timeout <dur>] <description>",
      "  node scripts/agy-bridge.mjs runs [run-id] [--all] [--json]",
      "  node scripts/agy-bridge.mjs show [run-id] [--json]",
      "  node scripts/agy-bridge.mjs stop [run-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeMode(mode) {
  if (mode == null) {
    return null;
  }
  const normalized = String(mode).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_MODES.has(normalized)) {
    throw new Error(`Unsupported mode "${mode}". The only mode is: plan.`);
  }
  return normalized;
}

function normalizeEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  return normalized;
}

function normalizeTimeout(value, fallback = null) {
  if (value == null || String(value).trim() === "") {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  const withUnit = /^[0-9]+$/.test(text) && text !== "0" ? `${text}s` : text;
  if (!/^(0|[1-9][0-9]{0,5}(s|m|h))$/.test(withUnit)) {
    throw new Error(`Unsupported timeout "${value}". Use a number of seconds or a duration such as 600s, 30m, 2h.`);
  }
  return withUnit;
}

/**
 * Slash commands hand us the user's argument string as a single argv entry, so
 * it has to be tokenized here. Doing that only when it is the *sole* entry was
 * wrong: `review --background '<all the flags>'` arrives as two entries, and the
 * second one was then treated as one unknown option and dropped — silently
 * losing `--base`, `--scope`, `--model`, `--mode` and any focus text.
 *
 * Any entry that carries whitespace is a packed string and gets split.
 */
function normalizeArgv(argv) {
  const normalized = [];
  for (const entry of argv) {
    if (typeof entry !== "string") {
      normalized.push(entry);
      continue;
    }
    if (!entry.trim()) {
      continue;
    }
    if (/\s/.test(entry)) {
      normalized.push(...splitRawArgumentString(entry));
      continue;
    }
    normalized.push(entry);
  }
  return normalized;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    unknownMode: config.unknownMode ?? "warn",
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.unknown?.length) {
    for (const token of parsed.unknown) {
      process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
    }
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

// agy answers in Markdown, so a bare heading such as "### Findings" is skipped
// in favour of the first line that says something.
function firstMeaningfulLine(text, fallback) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const line = lines.find((value) => !/^#{1,6}\s/.test(value)) ?? lines[0];
  return line ?? fallback;
}

/**
 * Tell the user when the bridge had to continue a turn that agy ended on a
 * refused permission, and what would have let agy do it.
 */
function buildRecoveryNotes(run) {
  const refused = (run.recoveredFrom ?? []).flat();
  if (refused.length === 0) {
    return [];
  }
  const names = [...new Set(refused.map((entry) => [entry?.action, entry?.display_name].filter(Boolean).join("/")))];
  const notes = [
    `agy stopped on a permission this run does not grant (${names.join(", ")}); the bridge continued the same conversation once without it.`
  ];
  if (refused.some((entry) => entry?.action === "read_file")) {
    notes.push("If agy needed files outside this repository, rerun with --add-dir <that directory>.");
  }
  if (refused.some((entry) => entry?.action === "write_file")) {
    notes.push("agy can only edit files inside the repository it was started in.");
  }
  return notes;
}

async function buildCheckReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const agyStatus = getAgyAvailability(cwd);
  const authStatus = await getAgyAuthStatus(cwd);
  const agyHome = resolveAgyHome();
  const userToolPermission = readUserToolPermission();

  const nextSteps = [];
  if (!agyStatus.available) {
    nextSteps.push("Install the Antigravity CLI and make sure `agy` is on PATH (or set AGY_BINARY).");
    nextSteps.push(
      "Windows: `irm https://antigravity.google/cli/install.ps1 | iex`. macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`."
    );
  }
  if (agyStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `agy` once in a terminal and complete the Google sign-in it asks for.");
    nextSteps.push("Verify with `agy models` — it lists the models your account can use.");
    nextSteps.push(
      "If `agy models` works in your terminal but this check still fails, your platform keeps the sign-in inside the home directory; set AGY_CC_HOME to a folder you have signed in from."
    );
  }

  return {
    ready: nodeStatus.available && agyStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    agy: agyStatus,
    auth: authStatus,
    agyHome,
    userToolPermission,
    sessionRuntime: getSessionRuntimeStatus(),
    actionsTaken,
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const finalReport = await buildCheckReport(cwd, []);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "The Antigravity CLI (agy) is not installed or not on PATH. Install it, set AGY_BINARY if needed, then rerun `/agy-cc:check`."
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentClaudeSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /agy-cc:runs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

/** A run id for the scratch directory, even for a foreground run without one. */
function ensureRunId(request, prefix) {
  return request.jobId ?? generateJobId(prefix);
}

function agyPayload(run) {
  return {
    status: run.status,
    stderr: run.stderr,
    stdout: run.finalMessage,
    failures: run.failures,
    conversationId: run.conversationId,
    permissionProfile: run.permissionProfile,
    attempts: run.attempts ?? 1,
    deniedActions: run.deniedActions,
    notes: buildRecoveryNotes(run)
  };
}

async function executeReviewRun(request) {
  ensureAgyAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target, {
    maxInlineFiles: REVIEW_MAX_INLINE_FILES,
    maxInlineDiffBytes: REVIEW_MAX_INLINE_DIFF_BYTES
  });

  const structured = reviewName === "Critique";
  const prompt = structured
    ? buildCritiquePrompt(context, focusText)
    : buildReviewPrompt({
        targetLabel: context.target.label,
        focusText,
        collectionGuidance: context.collectionGuidance,
        reviewInput: context.content
      });

  const runId = ensureRunId(request, "review");
  let run;
  try {
    run = await runAgyWithRecovery(context.repoRoot, {
      prompt,
      runDir: resolveRunDir(context.repoRoot, runId),
      // The read-only profile is the safety boundary for a review: writes,
      // commands, MCP tools and URL actions are all denied by rule.
      permissionProfile: "read-only",
      mode: request.mode ?? undefined,
      model: request.model,
      effort: request.effort,
      printTimeout: request.timeout,
      jsonSchemaPath: structured ? REVIEW_SCHEMA : null,
      requireResponse: !structured,
      onProgress: request.onProgress
    });
  } finally {
    removeRunDir(context.repoRoot, runId);
  }

  const failures = run.failures;
  if (structured) {
    const parsed = parseStructuredOutput(run, {
      status: run.status,
      failureMessage: failures.join(" ")
    });
    const ok = failures.length === 0 && parsed.parsed != null;
    const payload = {
      review: reviewName,
      target,
      threadId: run.threadId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      agy: agyPayload(run),
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };

    return {
      exitStatus: ok ? 0 : 1,
      threadId: run.threadId,
      turnId: null,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        failures,
        notes: buildRecoveryNotes(run)
      }),
      summary:
        parsed.parsed?.summary ??
        failures[0] ??
        parsed.parseError ??
        firstMeaningfulLine(run.finalMessage, `${reviewName} finished.`),
      jobTitle: `agy ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: run.threadId,
    agy: agyPayload(run)
  };
  const rendered = renderNativeReviewResult(
    {
      status: run.status,
      stdout: run.finalMessage,
      stderr: failures.length ? run.stderr : "",
      failures,
      notes: buildRecoveryNotes(run)
    },
    { reviewLabel: reviewName, targetLabel: target.label }
  );

  return {
    exitStatus: failures.length === 0 ? 0 : 1,
    threadId: run.threadId,
    turnId: null,
    payload,
    rendered,
    summary: failures[0] ?? firstMeaningfulLine(run.finalMessage, `${reviewName} completed.`),
    jobTitle: `agy ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeConversationId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous agy delegate conversation was found for this repository.");
    }
    resumeConversationId = latestThread.id;
  }

  if (!request.prompt && !resumeConversationId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const prompt = String(request.prompt ?? "").trim() || (resumeConversationId ? DEFAULT_CONTINUE_PROMPT : "");
  const write = Boolean(request.write);
  const permissionProfile = resolvePermissionProfile({ write, allowCommands: request.allowCommands });

  const runId = ensureRunId(request, "run");
  let run;
  try {
    run = await runAgyWithRecovery(workspaceRoot, {
      prompt,
      runDir: resolveRunDir(workspaceRoot, runId),
      resumeConversationId,
      // Without --write the run uses the read-only profile, which denies
      // writes and commands by rule. --write allows edits inside the
      // workspace; --allow-commands additionally allows terminal commands.
      permissionProfile,
      mode: write ? undefined : (request.mode ?? undefined),
      write,
      model: request.model,
      effort: request.effort,
      addDirs: request.addDirs ?? [],
      printTimeout: request.timeout,
      onProgress: request.onProgress
    });
  } finally {
    removeRunDir(workspaceRoot, runId);
  }

  const rawOutput = typeof run.finalMessage === "string" ? run.finalMessage : "";
  const failureMessage = run.failures.join("\n");
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      failures: run.failures,
      notes: buildRecoveryNotes(run)
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write
    }
  );
  const payload = {
    status: run.status,
    threadId: run.threadId,
    rawOutput,
    agy: agyPayload(run)
  };

  return {
    exitStatus: run.failures.length === 0 ? 0 : 1,
    threadId: run.threadId,
    turnId: null,
    payload,
    rendered,
    summary: run.failures[0] ?? firstMeaningfulLine(rawOutput, `${taskMetadata.title} finished.`),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write
  };
}

function formatTimestampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The file the image is copied to. Never an existing file. */
function resolveImageOutputPath(cwd, requested, extension) {
  let target;
  if (!requested) {
    target = path.join(cwd, `agy-image-${formatTimestampForFile()}${extension}`);
  } else {
    const resolved = path.resolve(cwd, requested);
    let isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      target = path.join(resolved, `agy-image-${formatTimestampForFile()}${extension}`);
    } else {
      const currentExt = path.extname(resolved);
      // The content decides the extension: agy draws JPEG, and a `.png` name
      // on JPEG bytes is a file that lies about itself.
      target = currentExt.toLowerCase() === extension ? resolved : `${resolved.slice(0, resolved.length - currentExt.length)}${extension}`;
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    return target;
  }
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free file name next to ${target}.`);
}

function resolveReferenceImages(cwd, refs = []) {
  return refs.map((ref) => {
    const resolved = path.resolve(cwd, ref);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Reference image not found: ${ref}`);
    }
    if (!stat.isFile() || !IMAGE_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(`Reference must be an image file (.jpg, .jpeg, .png, .webp): ${ref}`);
    }
    return resolved;
  });
}

async function executeImageRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);

  const references = resolveReferenceImages(request.cwd, request.refs ?? []);
  const addDirs = [...new Set(references.map((ref) => path.dirname(ref)))];
  const prompt = buildImagePrompt({
    description: request.description,
    aspectRatio: request.aspect,
    referencePaths: references
  });
  const home = resolveAgyHome();
  const startedAt = Date.now();

  const runId = ensureRunId(request, "image");
  let run;
  try {
    run = await runAgyWithRecovery(workspaceRoot, {
      prompt,
      runDir: resolveRunDir(workspaceRoot, runId),
      // Drawing needs no write permission: the image lands in agy's own
      // conversation folder and the bridge copies it out.
      permissionProfile: "read-only",
      model: request.model,
      addDirs,
      printTimeout: request.timeout ?? DEFAULT_IMAGE_TIMEOUT,
      requireResponse: false,
      agyHome: home,
      onProgress: request.onProgress
    });
  } finally {
    removeRunDir(workspaceRoot, runId);
  }

  // The answer text can say "still generating" while the file is already
  // there, so the file decides whether the run worked.
  const images = run.conversationId
    ? listConversationImages(home, run.conversationId, { sinceMs: startedAt - 5000 })
    : [];
  const payload = {
    status: run.status,
    threadId: run.threadId,
    rawOutput: run.finalMessage,
    agy: agyPayload(run),
    images: images.map((image) => ({ source: image.path, bytes: image.size })),
    output: null
  };

  if (images.length === 0) {
    const failures = run.failures.length ? run.failures : ["agy finished without producing an image."];
    return {
      exitStatus: 1,
      threadId: run.threadId,
      turnId: null,
      payload,
      rendered: renderImageResult({ failures, response: run.finalMessage }),
      summary: failures[0],
      jobTitle: "agy Image",
      jobClass: "image"
    };
  }

  const source = images[0];
  const bytes = fs.readFileSync(source.path);
  const detected = detectImageType(bytes) ?? { type: "unknown", extension: path.extname(source.path).toLowerCase() };
  const output = resolveImageOutputPath(request.cwd, request.out, detected.extension);
  fs.writeFileSync(output, bytes, { flag: "wx" });
  payload.output = { path: output, bytes: bytes.length, type: detected.type, source: source.path };

  return {
    exitStatus: 0,
    threadId: run.threadId,
    turnId: null,
    payload,
    rendered: renderImageResult({
      output: payload.output,
      otherImages: images.slice(1).map((image) => image.path),
      warnings: [...run.failures, ...buildRecoveryNotes(run)],
      response: run.finalMessage
    }),
    summary: `Saved ${output}`,
    jobTitle: "agy Image",
    jobClass: "image"
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Critique" ? "critique" : "review",
    title: reviewName === "Review" ? "agy Review" : `agy ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "agy Resume" : "agy Delegate";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Delegate";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /agy-cc:runs ${payload.jobId} for progress.\n`;
}

function createBridgeJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createBridgeJob({
    prefix: "run",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "agy-bridge.mjs");
  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  const child = spawnWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, {
      status: "queued",
      phase: "queued",
      pid: workerPid,
      bridgePid: workerPid,
      agentPid: null,
      logFile,
      request
    });
  } else {
    // No pid means the worker never started. Leaving the record `queued` would
    // show a run that is waiting for something that will never happen.
    const message = "Failed to start the background worker.";
    appendLogLine(logFile, message);
    claimJobTerminal(job.workspaceRoot, job.id, "failed", {
      errorMessage: message,
      summary: message,
      logFile,
      request
    });
    throw new Error(`${message} Run without --background to see the error.`);
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      pid: workerPid
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "mode", "effort", "timeout", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const mode = normalizeMode(options.mode);
  const effort = normalizeEffort(options.effort);
  const timeout = normalizeTimeout(options.timeout);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createBridgeJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    mode,
    effort,
    timeout,
    focusText,
    reviewName: config.reviewName,
    jobId: job.id
  };

  if (options.background && !options.wait) {
    ensureAgyAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "mode", "effort", "timeout", "cwd", "prompt-file"],
    multiOptions: ["add-dir"],
    booleanOptions: ["json", "write", "allow-commands", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const mode = normalizeMode(options.mode);
  const effort = normalizeEffort(options.effort);
  const timeout = normalizeTimeout(options.timeout);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const addDirs = (options["add-dir"] ?? []).map((dir) => path.resolve(cwd, dir));

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const allowCommands = Boolean(options["allow-commands"]);
  // Validates the --write / --allow-commands combination up front.
  resolvePermissionProfile({ write, allowCommands });
  if (write && mode) {
    // `plan` never edits. Silently honouring one and discarding the other
    // would lose what the caller asked for.
    throw new Error(`--write cannot be combined with --mode ${mode}; plan mode does not edit files. Drop one of the two.`);
  }
  for (const dir of addDirs) {
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new Error(`--add-dir is not a directory: ${dir}`);
    }
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = {
    kind: "task",
    cwd,
    model,
    mode,
    effort,
    timeout,
    prompt,
    write,
    allowCommands,
    addDirs,
    resumeLast,
    jobId: job.id
  };

  if (options.background) {
    ensureAgyAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleImage(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["out", "aspect", "model", "timeout", "cwd", "prompt-file"],
    multiOptions: ["ref"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const description = String(readTaskPrompt(cwd, options, positionals) ?? "").trim();
  if (!description) {
    throw new Error("Describe the image to make.");
  }
  const aspect = options.aspect ? String(options.aspect).trim() : null;
  if (aspect && !ASPECT_RATIO_PATTERN.test(aspect)) {
    throw new Error(`Unsupported aspect ratio "${options.aspect}". Use the form 1:1 or 16:9.`);
  }
  const timeout = normalizeTimeout(options.timeout, DEFAULT_IMAGE_TIMEOUT);
  const refs = options.ref ?? [];
  // Fail on a missing reference before anything is queued.
  resolveReferenceImages(cwd, refs);

  const job = createBridgeJob({
    prefix: "image",
    kind: "image",
    title: "agy Image",
    workspaceRoot,
    jobClass: "image",
    summary: shorten(description)
  });
  const request = {
    kind: "image",
    cwd,
    description,
    aspect,
    refs,
    out: options.out ?? null,
    model: options.model ? String(options.model).trim() : null,
    timeout,
    jobId: job.id
  };

  if (options.background && !options.wait) {
    ensureAgyAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeImageRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function readStoredJobWithRetry(workspaceRoot, jobId, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 25;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readStoredJob(workspaceRoot, jobId);
    if (last) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = await readStoredJobWithRetry(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  let runner;
  if (request.kind === "review" || storedJob.jobClass === "review") {
    runner = () => executeReviewRun({ ...request, onProgress: progress });
  } else if (request.kind === "image" || storedJob.jobClass === "image") {
    runner = () => executeImageRun({ ...request, onProgress: progress });
  } else {
    runner = () => executeTaskRun({ ...request, onProgress: progress });
  }

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    runner,
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`runs --wait` requires a run id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable delegate run found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable delegate run found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function terminateJobProcessTrees(job) {
  const targets = resolveJobKillTargets(job);
  const results = [];
  for (const pid of targets) {
    results.push({ pid, ...terminateProcessTree(pid, { expect: OUR_PROCESS_MARKERS }) });
  }
  if (results.length === 0) {
    return { attempted: false, delivered: false, method: null, results: [] };
  }
  return {
    attempted: results.some((entry) => entry.attempted),
    delivered: results.some((entry) => entry.delivered),
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    results
  };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  const preClaimRecord = { ...job, ...existing };
  const killTargets = resolveJobKillTargets(preClaimRecord);

  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: "Stopped by user.",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const killResult = terminateJobProcessTrees(preClaimRecord);

  if (!claim.claimed && claim.status && claim.status !== "cancelled") {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: killResult.delivered,
      alreadyTerminal: true,
      claimOrder: "claim-before-kill",
      killTargets
    };
    outputCommandResult(
      payload,
      `Job ${job.id} is already ${claim.status}; not overwritten by stop.\n`,
      options.json
    );
    return;
  }

  appendLogLine(
    existing.logFile ?? job.logFile,
    killResult.delivered
      ? "Stopped by user (claim-before-kill)."
      : `Stop claimed; process tree kill delivered=${killResult.delivered} method=${killResult.method ?? "none"}.`
  );

  const merged = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: killResult.delivered
      ? "Stopped by user."
      : "Stop claimed but process may still be running (kill not delivered).",
    cancelKill: killResult,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const nextJob = merged.job ?? claim.job ?? {
    ...existing,
    status: "cancelled",
    phase: "cancelled",
    title: job.title
  };
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    killAttempted: killResult.attempted,
    killDelivered: killResult.delivered,
    killMethod: killResult.method,
    killTargets,
    claimOrder: "claim-before-kill",
    claimed: claim.claimed
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, ...payload }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check":
      await handleCheck(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "critique":
      await handleReviewCommand(argv, {
        reviewName: "Critique"
      });
      break;
    case "run":
      await handleTask(argv);
      break;
    case "image":
      await handleImage(argv);
      break;
    case "run-worker":
      await handleTaskWorker(argv);
      break;
    case "runs":
      await handleStatus(argv);
      break;
    case "show":
      handleResult(argv);
      break;
    case "run-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "stop":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, readStoredJobWithRetry };
