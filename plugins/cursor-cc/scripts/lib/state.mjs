import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "cursor-cc-runs");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

function resolveBridgePidField(existing = {}, patch = {}) {
  if (patch.bridgePid !== undefined) {
    return patch.bridgePid;
  }
  if (patch.companionPid !== undefined) {
    return patch.companionPid;
  }
  return existing.bridgePid ?? existing.companionPid ?? null;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  // The run directory holds prompts, repository excerpts and pids. On a shared
  // machine the fallback root is under the system temp directory, so it is
  // created owner-only rather than with the default 0o777 & ~umask.
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    for (const dir of [resolveStateDir(cwd), resolveJobsDir(cwd)]) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // best effort; a pre-existing directory we do not own stays as it is
      }
    }
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readLockToken(lockPath) {
  try {
    return String(fs.readFileSync(lockPath, "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Whether the process named in the lock file is still running.
 *
 * An empty lock means nothing is claimed yet — see `acquireLock` for why that
 * cannot happen for a lock we created — and is treated as *held*, not stale.
 * Guessing "stale" there is what lets a waiter steal a live holder's lock.
 */
function lockHolderIsAlive(lockPath) {
  const token = readLockToken(lockPath);
  const pid = Number.parseInt(token.split(":")[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Claim the lock atomically *with its contents already in place*.
 *
 * `openSync(lockPath, "wx")` followed by a write leaves a window in which the
 * lock exists but is empty. A waiter that looked in during that window saw no
 * pid, concluded the lock was stale, and unlinked it — out from under a holder
 * that was still inside its critical section.
 *
 * `link()` closes the window: the file is written completely under a private
 * name first, and the link into the shared name is a single atomic operation
 * that fails if the name is taken.
 *
 * @returns the token written on success, or null when the lock is already held.
 */
function acquireLock(lockPath, token) {
  const stagingPath = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(stagingPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    fs.linkSync(stagingPath, lockPath);
    return token;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return null;
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(stagingPath);
    } catch {
      // the staging copy is disposable
    }
  }
}

/** Release only if the lock still carries our token; never someone else's. */
function releaseLock(lockPath, token) {
  if (readLockToken(lockPath) !== token) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  let brokeStaleLock = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (acquireLock(lockPath, token) === null) {
      // Break a lock left behind by a dead process, but only once, so two live
      // waiters cannot ping-pong over each other's lock.
      if (!brokeStaleLock && !lockHolderIsAlive(lockPath)) {
        brokeStaleLock = true;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // someone else got there first
        }
        continue;
      }
      sleepMs(LOCK_RETRY_MS);
      continue;
    }

    try {
      return fn();
    } finally {
      releaseLock(lockPath, token);
    }
  }

  throw new Error(
    `Timed out acquiring state lock at ${lockPath}. If no other run is active, delete that file.`
  );
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function readJobFileIfPresent(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

function upsertJobInState(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    });
    return;
  }
  state.jobs[existingIndex] = {
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  };
}

/** Claim terminal status for job file + index under one lock. cancelled wins. */
export function claimJobTerminal(cwd, jobId, nextStatus, patch = {}) {
  if (!isTerminalJobStatus(nextStatus)) {
    throw new Error(`claimJobTerminal requires a terminal status, got: ${nextStatus}`);
  }

  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;

    if (!existing) {
      return { claimed: false, status: null, job: null, reason: "missing" };
    }

    const currentStatus = existing.status;
    if (isTerminalJobStatus(currentStatus)) {
      if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
        return { claimed: false, status: "cancelled", job: existing, reason: "cancelled-wins" };
      }
      if (nextStatus === "cancelled" && currentStatus !== "cancelled") {
        return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
      }
      if (currentStatus === "cancelled" && nextStatus === "cancelled") {
        const merged = {
          ...existing,
          ...patch,
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          updatedAt: nowIso()
        };
        writeJobFileUnlocked(cwd, jobId, merged);
        upsertJobInState(state, {
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          summary: merged.summary ?? existing.summary,
          threadId: merged.threadId ?? existing.threadId ?? null,
          pid: null,
          agentPid: null,
          errorMessage: merged.errorMessage ?? existing.errorMessage
        });
        saveStateUnlocked(cwd, state);
        return { claimed: false, status: "cancelled", job: merged, reason: "cancelled-merge" };
      }
      return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
    }

    const completedAt = patch.completedAt ?? nowIso();
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      status: nextStatus,
      phase: patch.phase ?? (nextStatus === "completed" ? "done" : nextStatus),
      pid: patch.pid === undefined ? null : patch.pid,
      agentPid: patch.agentPid === undefined ? null : patch.agentPid,
      bridgePid: resolveBridgePidField(existing, patch),
      completedAt,
      updatedAt: nowIso()
    };
    if (nextStatus === "cancelled") {
      nextJob.cancelledAt = patch.cancelledAt ?? completedAt;
    }

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextStatus,
      phase: nextJob.phase,
      summary: nextJob.summary ?? existing.summary,
      threadId: nextJob.threadId ?? existing.threadId ?? null,
      turnId: nextJob.turnId ?? existing.turnId ?? null,
      pid: null,
      agentPid: null,
      bridgePid: nextJob.bridgePid ?? null,
      errorMessage: nextJob.errorMessage,
      completedAt,
      logFile: nextJob.logFile ?? existing.logFile ?? null,
      sessionId: nextJob.sessionId ?? existing.sessionId,
      kind: nextJob.kind ?? existing.kind,
      kindLabel: nextJob.kindLabel ?? existing.kindLabel,
      title: nextJob.title ?? existing.title,
      jobClass: nextJob.jobClass ?? existing.jobClass,
      write: nextJob.write ?? existing.write
    });
    saveStateUnlocked(cwd, state);
    return { claimed: true, status: nextStatus, job: nextJob, reason: "claimed" };
  });
}

/** Patch non-terminal job under lock; no-op if missing/terminal. */
export function patchJobIfActive(cwd, jobId, patch = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;
    if (!existing) {
      return { patched: false, status: null, job: null, reason: "missing" };
    }
    if (isTerminalJobStatus(existing.status)) {
      return { patched: false, status: existing.status, job: existing, reason: "terminal" };
    }

    const bridgePid = resolveBridgePidField(existing, patch);
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      bridgePid,
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      pid:
        patch.pid !== undefined
          ? patch.pid
          : (bridgePid ?? existing.pid ?? null),
      updatedAt: nowIso()
    };

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextJob.status,
      phase: nextJob.phase,
      summary: nextJob.summary,
      threadId: nextJob.threadId,
      turnId: nextJob.turnId,
      pid: nextJob.pid,
      agentPid: nextJob.agentPid,
      bridgePid: nextJob.bridgePid,
      logFile: nextJob.logFile,
      errorMessage: nextJob.errorMessage
    });
    saveStateUnlocked(cwd, state);
    return { patched: true, status: nextJob.status, job: nextJob, reason: "patched" };
  });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw = "";
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read bridge state file ${stateFile}: ${error.message}`);
  }

  if (!raw.trim()) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stateFile, quarantinePath);
    } catch {
    }
    throw new Error(
      `Bridge state file is corrupt and was quarantined${quarantinePath ? ` to ${quarantinePath}` : ""}: ${error.message}`
    );
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

/**
 * A job record carries a `logFile` path, and pruning deletes it. The record is
 * JSON on disk, so that path is not trustworthy: a tampered state file could
 * name any file on the machine and have the plugin delete it on the next save.
 * Only paths that really sit inside this workspace's run directory are removed.
 */
function isInsideJobsDir(cwd, filePath) {
  if (!filePath) {
    return false;
  }
  try {
    const jobsDir = fs.realpathSync(resolveJobsDir(cwd));
    // realpath the parent, not the file: the file is about to be deleted and a
    // symlink at the leaf must not redirect the unlink.
    const target = path.resolve(filePath);
    const parent = fs.realpathSync(path.dirname(target));
    const resolved = path.join(parent, path.basename(target));
    const relative = path.relative(jobsDir, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function removeJobLogIfOwned(cwd, filePath) {
  if (!isInsideJobsDir(cwd, filePath)) {
    return;
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
      return;
    }
    fs.unlinkSync(filePath);
  } catch {
    // already gone, or not ours to remove
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeJobLogIfOwned(cwd, job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

// Run ids reach these helpers straight from slash-command arguments
// (`/cursor-cc:show <run-id>` and friends), and they become a path component.
// Without this gate an id of `../../x` reads and writes outside the run
// directory. generateJobId only ever produces `<prefix>-<base36>-<base36>`.
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeJobId(jobId) {
  const id = String(jobId ?? "");
  if (!JOB_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error(`Invalid run id: ${JSON.stringify(jobId)}`);
  }
  return id;
}

export function resolveJobLogFile(cwd, jobId) {
  const safeId = assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${safeId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  const safeId = assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${safeId}.json`);
}
