// ═══════════════════════════════════════════════════════════════
// PEPAGI — Cryptographic Audit Log
// ═══════════════════════════════════════════════════════════════

import { appendFile, readFile, mkdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
// SECURITY: SEC-02 — Scrub credentials from audit log details
import { scrubCredentials } from "./credential-scrubber.js";

export interface AuditEntry {
  timestamp: string;
  taskId?: string;
  agent?: string;
  actionType: string;
  details: string;
  outcome: "allowed" | "blocked" | "flagged";
  prevHash: string;
  hash: string;
}

const AUDIT_PATH = join(PEPAGI_DATA_DIR, "audit.jsonl");

// SECURITY: SEC-07 — HMAC key derived from machine-specific data or env
const HMAC_KEY = process.env.PEPAGI_AUDIT_HMAC_KEY
  ?? createHash("sha256").update(`pepagi-audit:${process.env.USER ?? "default"}:${process.env.HOME ?? ""}`).digest("hex");

// SECURITY: SEC-07 — Max individual log entry size (bytes)
const MAX_ENTRY_DETAILS_LENGTH = 4096;

// SECURITY: SEC-07 — Log rotation threshold (10 MB)
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

// SECURITY: SEC-07 — Control characters and ANSI escape regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function computeHash(entry: Omit<AuditEntry, "hash">): string {
  const str = JSON.stringify(entry);
  return createHmac("sha256", HMAC_KEY).update(str).digest("hex");
}

/**
 * SECURITY: SEC-07 — Sanitize log entry content.
 * Strips control characters, ANSI escapes, and truncates oversized values.
 */
function sanitizeLogContent(text: string): string {
  let clean = text;
  // Strip ANSI escape codes
  clean = clean.replace(ANSI_ESCAPE_RE, "");
  // Strip control characters (keep newlines \n and tabs \t)
  clean = clean.replace(CONTROL_CHARS_RE, "");
  // Truncate
  if (clean.length > MAX_ENTRY_DETAILS_LENGTH) {
    clean = clean.slice(0, MAX_ENTRY_DETAILS_LENGTH) + "[...truncated]";
  }
  return clean;
}

let lastHash = "genesis";

// SEC-05: Serialize all audit log writes through a single promise chain.
// Previously, concurrent calls both read the same `lastHash` before either
// could update it, causing the SHA-256 chain to fork silently.
let writeQueue: Promise<void> = Promise.resolve();

/** Append an entry to the audit log */
export function auditLog(params: {
  taskId?: string;
  agent?: string;
  actionType: string;
  details: string;
  outcome: "allowed" | "blocked" | "flagged";
}): Promise<AuditEntry> {
  // SEC-05: Chain every write onto the previous one. Only one write executes
  // at a time, so lastHash is always consistent when read.
  let resolveEntry!: (e: AuditEntry) => void;
  const entryPromise = new Promise<AuditEntry>(resolve => { resolveEntry = resolve; });

  writeQueue = writeQueue.then(async () => {
    await mkdir(PEPAGI_DATA_DIR, { recursive: true });

    // SECURITY: SEC-02 — Scrub credentials from audit details before persisting
    // SECURITY: SEC-07 — Sanitize log content (strip control chars, ANSI, truncate)
    const scrubbedDetails = sanitizeLogContent(scrubCredentials(params.details).scrubbed);

    // SECURITY: SEC-07 — Log rotation: archive if file exceeds threshold
    await rotateLogIfNeeded();

    const entryBase = {
      timestamp: new Date().toISOString(),
      taskId: params.taskId,
      agent: params.agent,
      actionType: params.actionType,
      details: scrubbedDetails,
      outcome: params.outcome,
      prevHash: lastHash,
    };

    const hash = computeHash(entryBase);
    const entry: AuditEntry = { ...entryBase, hash };
    lastHash = hash; // safe: only one writer active at a time

    await appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n", "utf8");
    resolveEntry(entry);
  });

  return entryPromise;
}

/** Read audit log entries, optionally filtered by taskId */
export async function getLog(taskId?: string): Promise<AuditEntry[]> {
  if (!existsSync(AUDIT_PATH)) return [];

  const content = await readFile(AUDIT_PATH, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  const entries = lines.map(l => JSON.parse(l) as AuditEntry);

  return taskId ? entries.filter(e => e.taskId === taskId) : entries;
}

/** Verify audit log integrity (HMAC hash chain) */
export async function verifyIntegrity(): Promise<{ valid: boolean; firstViolation?: number }> {
  const entries = await getLog();
  let prevHash = "genesis";

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; // TS-05: was entries[i]! — explicit check below
    if (!entry) continue;
    const { hash, ...rest } = entry;
    const expected = computeHash({ ...rest, prevHash });
    if (expected !== hash || entry.prevHash !== prevHash) {
      return { valid: false, firstViolation: i };
    }
    prevHash = hash;
  }

  return { valid: true };
}

/**
 * SECURITY: SEC-07 — Rotate audit log if it exceeds MAX_LOG_SIZE_BYTES.
 * Archives the current log with a timestamp suffix and starts a fresh file.
 */
async function rotateLogIfNeeded(): Promise<void> {
  try {
    if (!existsSync(AUDIT_PATH)) return;
    const s = await stat(AUDIT_PATH);
    if (s.size < MAX_LOG_SIZE_BYTES) return;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = AUDIT_PATH.replace(".jsonl", `-${ts}.jsonl`);
    await rename(AUDIT_PATH, archivePath);
    // Reset hash chain for new file
    lastHash = "genesis";
  } catch {
    // Non-critical: if rotation fails, continue writing to current file
  }
}

/**
 * SECURITY: SEC-07 — Get a sanitized summary of recent audit log entries.
 * Safe for consumption by Watchdog/Metacognition (no raw untrusted content).
 */
export async function getSanitizedSummary(limit = 50): Promise<Array<{
  timestamp: string;
  actionType: string;
  outcome: string;
  taskId?: string;
}>> {
  const entries = await getLog();
  return entries.slice(-limit).map(e => ({
    timestamp: e.timestamp,
    actionType: e.actionType,
    outcome: e.outcome,
    taskId: e.taskId,
  }));
}
