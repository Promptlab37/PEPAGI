// ═══════════════════════════════════════════════════════════════
// PEPAGI — Structured Logger
// ═══════════════════════════════════════════════════════════════

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
// SECURITY: SEC-02 — Scrub credentials from log string values
import { scrubCredentials } from "../security/credential-scrubber.js";

// OPS-01: no log rotation — log directory grows without bound in long-running deployments
async function rotateLogs(logsDir: string, maxAgeDays = 30): Promise<void> {
  try {
    const { readdir, unlink, stat } = await import("node:fs/promises");
    const files = await readdir(logsDir);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith("pepagi-") || !file.endsWith(".jsonl")) continue;
      const filePath = join(logsDir, file);
      const { mtimeMs } = await stat(filePath);
      if (mtimeMs < cutoff) await unlink(filePath).catch(() => {});
    }
  } catch { /* ignore rotation errors */ }
}

let rotationDone = false;

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  taskId?: string;
  message: string;
  data?: unknown;
}

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.PEPAGI_LOG_LEVEL as LogLevel) ?? "info";

/** Keys whose values are redacted before writing to disk */
const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "apitoken", "api_token",
  "password", "passwd", "secret", "token",
  "authorization", "auth", "credential", "credentials",
  "anthropic_api_key", "openai_api_key", "google_api_key",
  "aws_secret_access_key", "stripe_secret_key",
]);

function scrubSensitive(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  // SECURITY: SEC-02 — Scrub credential patterns from string values
  if (typeof value === "string") return scrubCredentials(value).scrubbed;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => scrubSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : scrubSensitive(v, depth + 1);
  }
  return out;
}

async function writeToFile(entry: LogEntry): Promise<void> {
  try {
    const dir = join(PEPAGI_DATA_DIR, "logs");
    await mkdir(dir, { recursive: true });
    // OPS-01: run log rotation once per process startup (after the directory exists)
    if (!rotationDone) {
      rotationDone = true;
      void rotateLogs(dir);
    }
    const date = entry.timestamp.slice(0, 10);
    const path = join(dir, `pepagi-${date}.jsonl`);
    const safeEntry = { ...entry, data: scrubSensitive(entry.data) };
    await appendFile(path, JSON.stringify(safeEntry) + "\n", "utf8");
  } catch {
    // don't crash if we can't write logs
  }
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[MIN_LEVEL];
}

function log(level: LogLevel, component: string, message: string, data?: unknown, taskId?: string): void {
  // SECURITY: SEC-02 — Scrub credentials from log messages
  const safeMessage = scrubCredentials(message).scrubbed;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    taskId,
    message: safeMessage,
    data,
  };

  if (shouldLog(level)) {
    const color = LEVEL_COLORS[level];
    const time = entry.timestamp.slice(11, 19);
    const prefix = color(`[${time}] [${level.toUpperCase().padEnd(5)}] [${component}]`);
    const msg = `${prefix} ${message}`;
    if (level === "error") {
      console.error(msg, data ? chalk.gray(JSON.stringify(data)) : "");
    } else {
      console.log(msg, data !== undefined ? chalk.gray(JSON.stringify(data)) : "");
    }
  }

  void writeToFile(entry);
}

export class Logger {
  private component: string;

  constructor(component: string) {
    this.component = component;
  }

  debug(message: string, data?: unknown, taskId?: string): void {
    log("debug", this.component, message, data, taskId);
  }

  info(message: string, data?: unknown, taskId?: string): void {
    log("info", this.component, message, data, taskId);
  }

  warn(message: string, data?: unknown, taskId?: string): void {
    log("warn", this.component, message, data, taskId);
  }

  error(message: string, data?: unknown, taskId?: string): void {
    log("error", this.component, message, data, taskId);
  }
}
