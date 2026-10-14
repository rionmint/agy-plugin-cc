#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { claimJobTerminal, loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveJobKillTargets, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  // Each entry is one `export` line. A value carrying a newline would append a
  // second line of its own choosing to a file the host later sources, so a
  // value with a line break is dropped rather than escaped.
  const text = String(value);
  if (/[\r\n\0]/.test(text)) {
    process.stderr.write(`[cursor-cc] refusing to export ${name}: value contains a line break\n`);
    return;
  }
  // SessionStart fires again on every resume and compaction, and the host
  // inlines this file into every Bash call. Appending the same export each time
  // grows it until the command line overflows (Git Bash cuts `bash -c` at 8192
  // bytes), so skip the write when the variable's last export already carries
  // this value. Comparing against the last export, not any earlier one, keeps
  // A -> B -> A ending on A.
  const envFile = process.env.CLAUDE_ENV_FILE;
  const line = `export ${name}=${shellEscape(text)}`;
  let current = "";
  try {
    current = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const prefix = `export ${name}=`;
  const lastExport = current
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith(prefix))
    .pop();
  if (lastExport === line) {
    return;
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(envFile, `${separator}${line}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      try {
        claimJobTerminal(workspaceRoot, job.id, "cancelled", {
          errorMessage: "Stopped by session end.",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          bridgePid: null
        });
      } catch {
      }

      const killTargets = resolveJobKillTargets(job);
      for (const pid of killTargets) {
        try {
          terminateProcessTree(pid, { expect: ["cursor-agent", "cursor-bridge.mjs"] });
        } catch {
        }
      }
    }
  }

  const nextState = loadState(workspaceRoot);
  saveState(workspaceRoot, {
    ...nextState,
    jobs: nextState.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
