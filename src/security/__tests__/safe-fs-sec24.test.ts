// ═══════════════════════════════════════════════════════════════
// Tests: Filesystem Race Condition Defense (SEC-24)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isSymlinkSafe, safeReadFile, safeWriteFile, isWithinDataDir, hasPathTraversal } from "../safe-fs.js";

describe("Filesystem Race Condition Defense SEC-24", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sec24-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("symlink detection", () => {
    it("returns true for regular files", async () => {
      const filePath = join(tmpDir, "regular.txt");
      await writeFile(filePath, "content");
      expect(await isSymlinkSafe(filePath)).toBe(true);
    });

    it("returns false for symlinks", async () => {
      const targetPath = join(tmpDir, "target.txt");
      const linkPath = join(tmpDir, "link.txt");
      await writeFile(targetPath, "secret content");
      await symlink(targetPath, linkPath);
      expect(await isSymlinkSafe(linkPath)).toBe(false);
    });

    it("returns true for non-existent files", async () => {
      expect(await isSymlinkSafe(join(tmpDir, "nonexistent.txt"))).toBe(true);
    });
  });

  describe("TOCTOU-safe read", () => {
    it("reads existing file content", async () => {
      const filePath = join(tmpDir, "data.json");
      await writeFile(filePath, '{"key": "value"}');
      const content = await safeReadFile(filePath);
      expect(content).toBe('{"key": "value"}');
    });

    it("returns null for non-existent file", async () => {
      const content = await safeReadFile(join(tmpDir, "missing.json"));
      expect(content).toBeNull();
    });

    it("uses file descriptor (no TOCTOU gap)", async () => {
      const filePath = join(tmpDir, "fd-test.txt");
      await writeFile(filePath, "safe read");
      // Read succeeds because it opens a file handle directly
      const content = await safeReadFile(filePath);
      expect(content).toBe("safe read");
    });
  });

  describe("atomic write", () => {
    it("writes file atomically", async () => {
      const filePath = join(tmpDir, "atomic.txt");
      await safeWriteFile(filePath, "atomic content");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("atomic content");
    });

    it("creates parent directories", async () => {
      const filePath = join(tmpDir, "sub", "dir", "file.txt");
      await safeWriteFile(filePath, "nested content");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("nested content");
    });

    it("overwrites existing file atomically", async () => {
      const filePath = join(tmpDir, "overwrite.txt");
      await writeFile(filePath, "old");
      await safeWriteFile(filePath, "new");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("new");
    });
  });

  describe("path validation", () => {
    it("detects path traversal with ..", () => {
      expect(hasPathTraversal("/data/../../../etc/passwd")).toBe(true);
    });

    it("detects path traversal with ~", () => {
      expect(hasPathTraversal("~/../../secret")).toBe(true);
    });

    it("accepts clean paths", () => {
      expect(hasPathTraversal("/home/user/.pepagi/data.json")).toBe(false);
    });

    it("validates data directory containment", () => {
      expect(isWithinDataDir("/etc/passwd")).toBe(false);
    });
  });
});
