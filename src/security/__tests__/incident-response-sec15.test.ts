// ═══════════════════════════════════════════════════════════════
// Tests: Incident Response & Rollback (SEC-15)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IncidentResponse } from "../incident-response.js";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Incident Response SEC-15", () => {
  let ir: IncidentResponse;

  beforeEach(() => {
    ir = new IncidentResponse();
  });

  describe("quarantine mode", () => {
    it("starts not quarantined", () => {
      expect(ir.isQuarantined()).toBe(false);
    });

    it("activates quarantine", () => {
      ir.quarantine("security breach detected");
      expect(ir.isQuarantined()).toBe(true);
    });

    it("deactivates quarantine", () => {
      ir.quarantine("test");
      ir.exitQuarantine();
      expect(ir.isQuarantined()).toBe(false);
    });

    it("can be activated multiple times", () => {
      ir.quarantine("first");
      ir.quarantine("second");
      expect(ir.isQuarantined()).toBe(true);
    });
  });

  describe("snapshot creation", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "sec15-snap-"));
      process.env.PEPAGI_DATA_DIR = tmpDir;
      // Create memory dir with test data
      await mkdir(join(tmpDir, "memory"), { recursive: true });
      await writeFile(join(tmpDir, "memory", "test.json"), '{"test": true}');
    });

    afterEach(async () => {
      delete process.env.PEPAGI_DATA_DIR;
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("creates snapshot with metadata", async () => {
      // Use a fresh instance after env var is set
      const freshIR = new IncidentResponse();
      // Snapshot will try to read from PEPAGI_DATA_DIR but instance was created with old path
      // Test the metadata structure
      const snap = await freshIR.snapshot("pre-deployment backup");
      expect(snap.id).toMatch(/^snap-\d+$/);
      expect(snap.reason).toBe("pre-deployment backup");
      expect(snap.timestamp).toBeTruthy();
      expect(snap.hash).toBeTruthy();
    });

    it("tracks snapshots in list", async () => {
      await ir.snapshot("first");
      await ir.snapshot("second");
      expect(ir.getSnapshots()).toHaveLength(2);
    });
  });

  describe("forensic export structure", () => {
    it("returns export metadata", async () => {
      const exportMeta = await ir.forensicExport();
      expect(exportMeta.exportId).toMatch(/^forensic-\d+$/);
      expect(exportMeta.timestamp).toBeTruthy();
      expect(Array.isArray(exportMeta.snapshots)).toBe(true);
      expect(typeof exportMeta.auditLogEntries).toBe("number");
      expect(Array.isArray(exportMeta.memoryFiles)).toBe(true);
    });
  });

  describe("rollback safety", () => {
    it("returns false for non-existent snapshot", async () => {
      const result = await ir.rollback("snap-nonexistent");
      expect(result).toBe(false);
    });
  });
});
