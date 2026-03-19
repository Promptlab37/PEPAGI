// ═══════════════════════════════════════════════════════════════
// PEPAGI — Safe Filesystem Operations (SEC-24)
// TOCTOU-safe reads, symlink protection, atomic writes.
// ═══════════════════════════════════════════════════════════════

import { open, lstat, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("SafeFS");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");

/**
 * SECURITY: SEC-24 — Check if a path is a symlink.
 * Rejects symlinks in data directories to prevent symlink race attacks.
 * @param filePath - Path to check
 * @returns true if path is safe (not a symlink or doesn't exist)
 */
export async function isSymlinkSafe(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      logger.warn("SEC-24: Symlink detected in data directory", {
        path: filePath,
      });
      eventBus.emit({
        type: "security:blocked",
        taskId: "safe-fs",
        reason: `SEC-24: Symlink rejected: ${filePath}`,
      });
      return false;
    }
    return true;
  } catch {
    // File doesn't exist — safe to create
    return true;
  }
}

/**
 * SECURITY: SEC-24 — TOCTOU-safe file read using file descriptor.
 * Opens file first, then reads from the same descriptor, avoiding
 * the existsSync + readFile race window.
 * @param filePath - Path to read
 * @returns File contents or null if file doesn't exist
 */
export async function safeReadFile(filePath: string): Promise<string | null> {
  // SEC-24: Symlink protection in data directories
  const resolved = resolve(filePath);
  if (resolved.startsWith(PEPAGI_DATA_DIR)) {
    const safe = await isSymlinkSafe(filePath);
    if (!safe) return null;
  }

  let handle;
  try {
    handle = await open(filePath, "r");
    const content = await handle.readFile("utf8");
    return content;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * SECURITY: SEC-24 — Atomic write with temp file + rename.
 * Also checks for symlinks before writing.
 * @param filePath - Target path
 * @param content - Content to write
 */
export async function safeWriteFile(filePath: string, content: string): Promise<void> {
  // SEC-24: Symlink protection
  const resolved = resolve(filePath);
  if (resolved.startsWith(PEPAGI_DATA_DIR)) {
    const safe = await isSymlinkSafe(filePath);
    if (!safe) {
      throw new Error(`SEC-24: Cannot write to symlink: ${filePath}`);
    }
  }

  // Ensure directory exists
  await mkdir(dirname(filePath), { recursive: true });

  // Atomic write: write to temp, then rename
  const tmpPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * SECURITY: SEC-24 — Check if a path is within the allowed data directory.
 * Prevents path traversal attacks.
 */
export function isWithinDataDir(filePath: string): boolean {
  const resolved = resolve(filePath);
  return resolved.startsWith(PEPAGI_DATA_DIR);
}

/**
 * SECURITY: SEC-24 — Validate that a path doesn't contain traversal sequences.
 */
export function hasPathTraversal(filePath: string): boolean {
  return filePath.includes("..") || filePath.includes("~");
}
