// ═══════════════════════════════════════════════════════════════
// PEPAGI — Path Validator (Centralized File-Access Security)
//
// EVERY file-system operation in the entire codebase MUST call
// validatePath() before touching disk.  This module is the single
// point of enforcement — if it throws, the operation is blocked.
//
// Defence-in-depth:
//   1. Normalize the path (collapses ../, ./, double-slashes)
//   2. Resolve ALL symlinks via realpath()  →  prevents symlink bypass
//   3. Check resolved path against allowed base directories
//   4. Check resolved path against sensitive-path deny-list
//   5. On violation: throw PathSecurityError, emit event, audit log
// ═══════════════════════════════════════════════════════════════

import { realpath } from "node:fs/promises";
import { resolve, normalize, dirname } from "node:path";
import { homedir } from "node:os";
import { auditLog } from "./audit-log.js";
import { eventBus } from "../core/event-bus.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("PathValidator");

// ── Error class ──────────────────────────────────────────────

export class PathSecurityError extends Error {
  /** The raw path the caller tried to access */
  public readonly rawPath: string;
  /** The fully-resolved canonical path (after symlinks) */
  public readonly resolvedPath: string;
  /** Which tool / caller triggered the check */
  public readonly toolName: string;

  constructor(message: string, rawPath: string, resolvedPath: string, toolName: string) {
    super(message);
    this.name = "PathSecurityError";
    this.rawPath = rawPath;
    this.resolvedPath = resolvedPath;
    this.toolName = toolName;
  }
}

// ── Sensitive paths inside ~ that are ALWAYS blocked ─────────

const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".netrc",
  ".docker/config.json",
  ".kube/config",
];

// ── Resolved-base cache ──────────────────────────────────────
// On macOS /tmp is a symlink to /private/tmp — we must resolve
// the allowed bases themselves so the prefix check works.

let resolvedBasesCache: string[] | null = null;

async function getResolvedBases(): Promise<string[]> {
  if (resolvedBasesCache) return resolvedBasesCache;
  const rawBases = [homedir(), "/tmp", process.cwd()];
  const resolved: string[] = [];
  for (const b of rawBases) {
    try {
      resolved.push(await realpath(b));
    } catch {
      resolved.push(resolve(normalize(b)));
    }
  }
  resolvedBasesCache = [...new Set(resolved)];
  return resolvedBasesCache;
}

/** Exported only for tests — do NOT call in production. */
export function _resetBasesCache(): void {
  resolvedBasesCache = null;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Validate that `rawPath` resolves to an allowed location.
 *
 * **Allowed directories** (after symlink resolution):
 *   - User home directory  (`~/`)  — excluding sensitive sub-dirs
 *   - Temp directory        (`/tmp/`)
 *   - Current working directory  (`process.cwd()`)
 *
 * **Always blocked** (even under ~/):
 *   `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube/config`, `~/.netrc`, …
 *
 * @param rawPath  The path the caller wants to access
 * @param toolName Identifier for audit log (e.g. "read_file")
 * @param taskId   Optional task ID for audit trail
 * @returns The canonically resolved path (safe to use for fs ops)
 * @throws {PathSecurityError} if the path is outside allowed dirs
 */
export async function validatePath(
  rawPath: string,
  toolName = "unknown",
  taskId?: string,
): Promise<string> {
  const bases = await getResolvedBases();
  const home = bases[0] ?? homedir();

  // ── 0. Detect ../ traversal targeting sensitive paths ──────
  // Even if the resolved path lands somewhere "safe" (e.g. deep
  // CWD makes ../../../../etc/passwd resolve to ~/etc/passwd),
  // the intent is clearly malicious. Block any raw path that
  // contains ../ and, after normalization, ends with a known
  // sensitive target like /etc/passwd, /etc/shadow, etc.
  if (rawPath.includes("..")) {
    const normalized = resolve(normalize(rawPath));
    const TRAVERSAL_TARGETS = ["/etc/passwd", "/etc/shadow", "/etc/hosts", "/proc/", "/sys/"];
    const looksLikeTraversal = TRAVERSAL_TARGETS.some(t => normalized.endsWith(t) || normalized.includes(t));
    // Also block if the raw path has enough ../ segments to plausibly escape
    // any reasonable working directory (4+ levels of ../)
    const dotdotCount = (rawPath.match(/\.\.\//g) ?? []).length;
    if (looksLikeTraversal || dotdotCount >= 4) {
      const msg = `Path traversal detected: ${rawPath} (normalized: ${normalized})`;
      emitAndLog(rawPath, normalized, toolName, taskId, "path_traversal", msg);
      throw new PathSecurityError(msg, rawPath, normalized, toolName);
    }
  }

  // ── 1. Resolve symlinks ────────────────────────────────────
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(resolve(normalize(rawPath)));
  } catch {
    // Path doesn't exist yet (write_file creating new file).
    // Resolve the parent directory's symlinks + append the leaf.
    const normalized = resolve(normalize(rawPath));
    const parentDir = dirname(normalized);
    const leaf = normalized.slice(parentDir.length);
    try {
      const resolvedParent = await realpath(parentDir);
      resolvedPath = resolvedParent + leaf;
    } catch {
      // Parent also absent — use plain normalized path
      resolvedPath = normalized;
    }
  }

  // ── 2. Allowed-base check ──────────────────────────────────
  const inAllowed = bases.some(
    base => resolvedPath === base || resolvedPath.startsWith(base + "/"),
  );

  if (!inAllowed) {
    const msg = `Path outside allowed directories: ${resolvedPath}`;
    emitAndLog(rawPath, resolvedPath, toolName, taskId, "path_traversal", msg);
    throw new PathSecurityError(msg, rawPath, resolvedPath, toolName);
  }

  // ── 3. Sensitive-subdir deny-list ──────────────────────────
  if (resolvedPath.startsWith(home + "/")) {
    const relative = resolvedPath.slice(home.length + 1);
    const isSensitive = SENSITIVE_HOME_DIRS.some(
      s => relative === s || relative.startsWith(s + "/"),
    );
    if (isSensitive) {
      const msg = `Access to sensitive path blocked: ${resolvedPath}`;
      emitAndLog(rawPath, resolvedPath, toolName, taskId, "sensitive_path", msg);
      throw new PathSecurityError(msg, rawPath, resolvedPath, toolName);
    }
  }

  return resolvedPath;
}

// ── Helpers ──────────────────────────────────────────────────

function emitAndLog(
  rawPath: string,
  resolvedPath: string,
  toolName: string,
  taskId: string | undefined,
  category: string,
  message: string,
): void {
  logger.error(`SEC: ${toolName} ${category}`, { rawPath, resolvedPath, taskId });
  eventBus.emit({
    type: "security:blocked",
    reason: message,
    taskId: taskId ?? "",
  });
  void auditLog({
    taskId,
    actionType: `${category}:${toolName}`,
    details: `CRITICAL — raw="${rawPath}" resolved="${resolvedPath}"`,
    outcome: "blocked",
  });
}
