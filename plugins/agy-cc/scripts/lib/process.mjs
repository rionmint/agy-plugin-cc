import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Locate a command on PATH, honouring PATHEXT on Windows.
 * Returns the concrete file path, or null when nothing matches.
 */
export function resolveExecutable(command, env = process.env) {
  const name = String(command ?? "");
  if (!name) {
    return null;
  }
  if (name.includes("/") || name.includes("\\")) {
    return fs.existsSync(name) ? name : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  // On Windows an extension-less file is not executable, so PATHEXT entries win
  // over the bare name.
  const extensions =
    process.platform === "win32"
      ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""]
      : [""];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Escape a single token for a cmd.exe command line.
 *
 * Double quotes alone are NOT enough. cmd counts quotes itself, so a token that
 * contains a `"` closes the quoted region early and everything after it is
 * parsed as cmd syntax — `&`, `|`, `>` and friends become operators again. That
 * is a command-injection hole, and it is reachable from any value that reaches
 * argv (a model id, a session id, a path).
 *
 * So: quote the token for the child's own CRT parser first, then caret-escape
 * every character cmd treats as special — the quotes included. cmd strips the
 * carets before handing the line to the child, which sees a normally quoted
 * argument, while cmd itself never sees an unescaped operator.
 *
 * A `.bat` / `.cmd` target needs that escaping applied TWICE. The batch file
 * expands `%*` (or `%1`) into its own line and cmd re-parses the result, so a
 * single round of carets is consumed by the outer parse and the metacharacters
 * come back to life inside the script. This is the CVE-2024-24576 class of bug.
 *
 * This mirrors the escaping used by cross-spawn, which is the de-facto standard
 * fix for this on Windows.
 */
const CMD_META_CHARACTERS = /[<>"^|&%!()]/g;

export function quoteWindowsArg(value, doubleEscape = false) {
  let text = String(value ?? "");
  // Escape embedded quotes and any trailing backslashes for the CRT parser.
  text = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  text = `"${text}"`;
  // Then hide every cmd metacharacter, including the quotes we just added.
  text = text.replace(CMD_META_CHARACTERS, "^$&");
  if (doubleEscape) {
    text = text.replace(CMD_META_CHARACTERS, "^$&");
  }
  return text;
}

/**
 * Build the `cmd /d /s /c` line for a batch-file target and its arguments.
 *
 * The target and the arguments need opposite treatment, which is easy to get
 * wrong: caret-escaping the quotes around the target hides them from cmd's own
 * tokenizer, so a path containing a space is split at the space and the run
 * fails with "is not recognized as an internal or external command". The target
 * therefore keeps real quotes, and the whole line is wrapped in one more pair
 * that `/s` strips before parsing the rest. Arguments still get the caret
 * treatment, because they are the ones carrying untrusted text.
 *
 * A Windows path cannot contain `"`, so quoting the target is unambiguous.
 */
export function buildCmdLine(resolvedTarget, args = []) {
  const target = `"${String(resolvedTarget).replace(/"/g, "")}"`;
  const rest = args.map((arg) => quoteWindowsArg(arg, true));
  return `"${[target, ...rest].join(" ")}"`;
}

/**
 * Spawn a CLI that may be a Windows `.cmd` / `.bat` shim.
 *
 * Node refuses to exec those directly (EINVAL, the CVE-2024-27980 mitigation),
 * and `shell: true` would hand the whole command line to cmd unquoted. So the
 * shim case goes through `cmd /d /s /c` with every token quoted individually.
 *
 * Note: cmd still expands `%VAR%` inside quoted tokens. Keep free-form text
 * (prompts in particular) off the command line and pass it on stdin instead.
 */
export function spawnCli(command, args = [], options = {}) {
  const env = options.env ?? process.env;
  const resolved = resolveExecutable(command, env) ?? command;

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const line = buildCmdLine(resolved, args);
    return spawn(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
      ...options,
      windowsVerbatimArguments: true
    });
  }

  return spawn(resolved, args, options);
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const env = options.env ?? process.env;
  const shell = options.shell ?? false;

  // libuv already searches PATH (and PATHEXT on Windows), so no shell is
  // needed to find an executable — which keeps repository-derived argv, git
  // refs in particular, safe from metacharacter expansion. The one case libuv
  // cannot handle is a .cmd / .bat shim: it finds the file and then refuses to
  // exec it (EINVAL). Those go through cmd.exe with each token quoted.
  let target = command;
  let finalArgs = args;
  let windowsVerbatimArguments = false;

  if (!shell && process.platform === "win32") {
    const resolved = resolveExecutable(command, env);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      target = env.ComSpec ?? "cmd.exe";
      finalArgs = ["/d", "/s", "/c", buildCmdLine(resolved, args)];
      windowsVerbatimArguments = true;
    }
  }

  const result = spawnSyncImpl(target, finalArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell,
    windowsVerbatimArguments,
    windowsHide: true
  });

  const status = result.status == null ? (result.signal ? 1 : null) : result.status;

  return {
    command,
    args,
    status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isZombieProcess(pid) {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return true;
    }
    const stat = String(result.stdout ?? "").trim();
    if (!stat) {
      return true;
    }
    return /\bZ\b|^Z/i.test(stat) || stat.toUpperCase().includes("Z");
  } catch {
    return false;
  }
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return !isZombieProcess(pid);
    }
    throw error;
  }
  return !isZombieProcess(pid);
}

function tryKill(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return { ok: true, missing: false, denied: false };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { ok: false, missing: true, denied: false };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return { ok: false, missing: false, denied: true };
    }
    throw error;
  }
}

/**
 * The command line of a running process, or null when it cannot be read.
 *
 * Pids come out of a json file on disk, and the operating system reuses pids.
 * Without a check, stopping a run that already exited can signal whatever now
 * holds that number — the user's editor, a shell, another Claude session.
 */
export function processCommandLine(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const result = runCommandImpl(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").CommandLine`
      ],
      { env: options.env }
    );
    if (result.error || result.status !== 0) {
      return null;
    }
    const text = String(result.stdout ?? "").trim();
    return text || null;
  }

  const result = runCommandImpl("ps", ["-p", String(Number(pid)), "-o", "args="], { env: options.env });
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = String(result.stdout ?? "").trim();
  return text || null;
}

/**
 * True when the process still looks like something this plugin started.
 * Unreadable command lines are treated as a mismatch: refusing to kill is the
 * safe failure, and the run is still marked cancelled either way.
 */
export function processLooksLikeOurs(pid, expect, options = {}) {
  if (!expect) {
    return true;
  }
  const commandLine = processCommandLine(pid, options);
  if (!commandLine) {
    return false;
  }
  const patterns = Array.isArray(expect) ? expect : [expect];
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(commandLine) : commandLine.includes(String(pattern))
  );
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  if (options.expect && !processLooksLikeOurs(pid, options.expect, options)) {
    return { attempted: false, delivered: false, method: null, reason: "identity-mismatch" };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl =
    options.isAliveImpl ?? ((candidatePid) => processIsAlive(candidatePid, killImpl));
  const graceMs = options.graceMs ?? 200;

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      const direct = tryKill(killImpl, pid, "SIGTERM");
      if (direct.missing) {
        return { attempted: true, delivered: false, method: "kill" };
      }
      return { attempted: true, delivered: true, method: "kill" };
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const methods = [];
  let signaledLiveProcess = false;

  const groupKill = tryKill(killImpl, -pid, "SIGTERM");
  if (groupKill.ok) {
    methods.push("process-group");
    signaledLiveProcess = true;
  } else if (groupKill.denied) {
    methods.push("process-group-denied");
  }

  if (isAliveImpl(pid)) {
    const directKill = tryKill(killImpl, pid, "SIGTERM");
    if (directKill.ok) {
      methods.push("process");
      signaledLiveProcess = true;
    } else if (directKill.missing) {
      return {
        attempted: true,
        delivered: signaledLiveProcess,
        method: methods.join("+") || "process"
      };
    } else if (directKill.denied) {
      methods.push("process-denied");
    }
  } else if (!signaledLiveProcess) {
    return {
      attempted: true,
      delivered: false,
      method: methods.join("+") || "process-group"
    };
  } else {
    return {
      attempted: true,
      delivered: true,
      method: methods.join("+") || "process-group"
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveImpl(pid)) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process" };
    }
    sleepMs(20);
  }

  if (!isAliveImpl(pid)) {
    return { attempted: true, delivered: true, method: methods.join("+") || "process" };
  }

  const groupKillHard = tryKill(killImpl, -pid, "SIGKILL");
  if (groupKillHard.ok) {
    methods.push("process-group-sigkill");
  }
  if (isAliveImpl(pid)) {
    const directKillHard = tryKill(killImpl, pid, "SIGKILL");
    if (directKillHard.ok) {
      methods.push("process-sigkill");
    } else if (directKillHard.missing) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process-sigkill" };
    }
  } else {
    return { attempted: true, delivered: true, method: methods.join("+") || "process-group-sigkill" };
  }

  sleepMs(40);
  const stillAlive = isAliveImpl(pid);
  return {
    attempted: true,
    delivered: !stillAlive,
    method: methods.join("+") || "process-sigkill"
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
