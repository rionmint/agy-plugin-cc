import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "cursor-cc-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

// A piped prompt is read wholesale into memory, so it needs a ceiling.
export const MAX_PIPED_STDIN_BYTES = 8 * 1024 * 1024;

export function readStdinIfPiped(maxBytes = MAX_PIPED_STDIN_BYTES) {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let read;
    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === "EAGAIN") {
        continue;
      }
      if (error?.code === "EOF") {
        break;
      }
      throw error;
    }
    if (read === 0) {
      break;
    }
    total += read;
    if (total > maxBytes) {
      throw new Error(`Piped input exceeds the ${maxBytes} byte limit.`);
    }
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
