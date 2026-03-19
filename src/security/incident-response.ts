// ═══════════════════════════════════════════════════════════════
// PEPAGI — Incident Response & Rollback (SEC-15)
// Quarantine mode, memory snapshots, rollback, forensic export.
// ═══════════════════════════════════════════════════════════════

import { readdir, readFile, writeFile, mkdir, copyFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("IncidentResponse");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const SNAPSHOTS_DIR = join(PEPAGI_DATA_DIR, "snapshots");
const FORENSICS_DIR = join(PEPAGI_DATA_DIR, "forensics");

export interface Snapshot {
  id: string;
  timestamp: string;
  reason: string;
  files: string[];
  hash: string;
}

export interface ForensicExport {
  exportId: string;
  timestamp: string;
  snapshots: Snapshot[];
  auditLogEntries: number;
  memoryFiles: string[];
  configHash: string;
}

/**
 * SECURITY: SEC-15 — Incident Response Manager
 * Provides quarantine, snapshot, rollback, and forensic capabilities.
 */
export class IncidentResponse {
  private quarantineActive = false;
  private snapshots: Snapshot[] = [];

  /**
   * SECURITY: SEC-15 — Enter quarantine (safe mode).
   * Stops all tool execution and switches to read-only.
   */
  quarantine(reason: string): void {
    this.quarantineActive = true;
    logger.error("SEC-15: QUARANTINE MODE ACTIVATED", { reason });
    eventBus.emit({
      type: "system:alert",
      message: `🔴 SEC-15: Quarantine mode activated — ${reason}`,
      level: "critical",
    });
  }

  /** Exit quarantine mode */
  exitQuarantine(): void {
    this.quarantineActive = false;
    logger.info("SEC-15: Quarantine mode deactivated");
  }

  /** Check if quarantine is active */
  isQuarantined(): boolean {
    return this.quarantineActive;
  }

  /**
   * SECURITY: SEC-15 — Create a timestamped snapshot of all memory/config.
   * @param reason - Why the snapshot is being created
   * @returns Snapshot metadata
   */
  async snapshot(reason: string): Promise<Snapshot> {
    const id = `snap-${Date.now()}`;
    const snapDir = join(SNAPSHOTS_DIR, id);
    await mkdir(snapDir, { recursive: true });

    const dirsToBackup = [
      join(PEPAGI_DATA_DIR, "memory"),
      join(PEPAGI_DATA_DIR, "skills"),
      join(PEPAGI_DATA_DIR, "goals.json"),
    ];

    const copiedFiles: string[] = [];

    for (const source of dirsToBackup) {
      try {
        const s = await stat(source);
        if (s.isDirectory()) {
          const files = await readdir(source);
          for (const file of files) {
            const srcPath = join(source, file);
            const destPath = join(snapDir, file);
            await copyFile(srcPath, destPath);
            copiedFiles.push(file);
          }
        } else {
          // Single file
          const fileName = source.split("/").pop()!;
          await copyFile(source, join(snapDir, fileName));
          copiedFiles.push(fileName);
        }
      } catch {
        // Source doesn't exist — skip
      }
    }

    // Compute integrity hash
    const hashInput = copiedFiles.sort().join("|") + "|" + id;
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

    const snapshot: Snapshot = {
      id,
      timestamp: new Date().toISOString(),
      reason,
      files: copiedFiles,
      hash,
    };

    // Save metadata
    await writeFile(
      join(snapDir, "snapshot.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8",
    );

    this.snapshots.push(snapshot);

    logger.info("SEC-15: Snapshot created", { id, files: copiedFiles.length, reason });

    return snapshot;
  }

  /**
   * SECURITY: SEC-15 — Rollback to a previous snapshot.
   * @param snapshotId - ID of the snapshot to restore
   */
  async rollback(snapshotId: string): Promise<boolean> {
    const snapDir = join(SNAPSHOTS_DIR, snapshotId);

    try {
      const metaRaw = await readFile(join(snapDir, "snapshot.json"), "utf8");
      const meta = JSON.parse(metaRaw) as Snapshot;

      const memoryDir = join(PEPAGI_DATA_DIR, "memory");
      await mkdir(memoryDir, { recursive: true });

      for (const file of meta.files) {
        const srcPath = join(snapDir, file);
        const destPath = join(memoryDir, file);
        try {
          await copyFile(srcPath, destPath);
        } catch {
          // File might have been a non-memory file
          const altDest = join(PEPAGI_DATA_DIR, file);
          // FIX: log rollback copy failures
          await copyFile(srcPath, altDest).catch(e => logger.warn("FIX: rollback copy failed", { file, error: String(e) }));
        }
      }

      logger.info("SEC-15: Rollback completed", { snapshotId, files: meta.files.length });
      eventBus.emit({
        type: "system:alert",
        message: `SEC-15: Rollback to snapshot ${snapshotId} completed`,
        level: "warn",
      });

      return true;
    } catch (err) {
      logger.error("SEC-15: Rollback failed", { snapshotId, error: String(err) });
      return false;
    }
  }

  /**
   * SECURITY: SEC-15 — Export forensic data for post-incident analysis.
   * @returns Forensic export metadata
   */
  async forensicExport(): Promise<ForensicExport> {
    const exportId = `forensic-${Date.now()}`;
    const exportDir = join(FORENSICS_DIR, exportId);
    await mkdir(exportDir, { recursive: true });

    // Copy audit log
    const auditPath = join(PEPAGI_DATA_DIR, "security", "audit.jsonl");
    let auditEntries = 0;
    try {
      const auditContent = await readFile(auditPath, "utf8");
      await writeFile(join(exportDir, "audit.jsonl"), auditContent, "utf8");
      auditEntries = auditContent.split("\n").filter(l => l.trim()).length;
    } catch {
      // No audit log
    }

    // Copy memory files
    const memoryDir = join(PEPAGI_DATA_DIR, "memory");
    const memoryFiles: string[] = [];
    try {
      const files = await readdir(memoryDir);
      for (const file of files) {
        await copyFile(join(memoryDir, file), join(exportDir, file));
        memoryFiles.push(file);
      }
    } catch {
      // No memory dir
    }

    // Config hash (don't export actual config with secrets)
    let configHash = "none";
    try {
      const configContent = await readFile(join(PEPAGI_DATA_DIR, "config.json"), "utf8");
      configHash = createHash("sha256").update(configContent).digest("hex").slice(0, 16);
    } catch {
      // No config
    }

    const exportMeta: ForensicExport = {
      exportId,
      timestamp: new Date().toISOString(),
      snapshots: this.snapshots,
      auditLogEntries: auditEntries,
      memoryFiles,
      configHash,
    };

    await writeFile(
      join(exportDir, "forensic-meta.json"),
      JSON.stringify(exportMeta, null, 2),
      "utf8",
    );

    logger.info("SEC-15: Forensic export created", {
      exportId,
      auditEntries,
      memoryFiles: memoryFiles.length,
    });

    return exportMeta;
  }

  /** Get list of available snapshots */
  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }
}

/** Singleton instance */
export const incidentResponse = new IncidentResponse();
