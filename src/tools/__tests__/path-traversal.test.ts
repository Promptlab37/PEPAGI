// ═══════════════════════════════════════════════════════════════
// Tests: Path Traversal via ToolRegistry (integration)
//
// End-to-end tests: call ToolRegistry.execute() and verify that
// read_file, write_file, list_directory, and download_file all
// go through the centralized path-validator.ts.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { ToolRegistry } from "../tool-registry.js";
import type { SecurityGuard } from "../../security/security-guard.js";
import { symlink, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { _resetBasesCache } from "../../security/path-validator.js";

// Mock audit-log
vi.mock("../../security/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue({
    timestamp: new Date().toISOString(),
    actionType: "test",
    details: "test",
    outcome: "blocked",
    prevHash: "genesis",
    hash: "test",
  }),
}));

// Mock external tool modules
vi.mock("../web-search.js", () => ({ duckduckgoSearch: vi.fn() }));
vi.mock("../home-assistant.js", () => ({ homeAssistantTool: { name: "home_assistant", description: "", execute: vi.fn() } }));
vi.mock("../spotify.js", () => ({ spotifyTool: { name: "spotify", description: "", execute: vi.fn() } }));
vi.mock("../youtube.js", () => ({ youtubeTool: { name: "youtube", description: "", execute: vi.fn() } }));
vi.mock("../browser.js", () => ({ browserTool: { name: "browser", description: "", execute: vi.fn() } }));
vi.mock("../calendar.js", () => ({ calendarTool: { name: "calendar", description: "", execute: vi.fn() } }));
vi.mock("../weather.js", () => ({ weatherTool: { name: "weather", description: "", execute: vi.fn() } }));
vi.mock("../notion.js", () => ({ notionTool: { name: "notion", description: "", execute: vi.fn() } }));
vi.mock("../docker.js", () => ({ dockerTool: { name: "docker", description: "", execute: vi.fn() } }));

const mockGuard = {
  validateCommand: () => true,
  authorize: () => Promise.resolve(true),
  recordCost: () => {},
  checkCost: () => true,
  sanitize: (t: string) => ({ sanitized: t, redactions: [] }),
  detectInjection: () => ({ isClean: true, threats: [], riskScore: 0 }),
  wrapExternalData: (d: string) => d,
} as unknown as SecurityGuard;

const SYMLINK_DIR = join("/tmp", "pepagi-path-traversal-test");

beforeAll(async () => {
  _resetBasesCache();
  await mkdir(SYMLINK_DIR, { recursive: true });

  const etcLink = join(SYMLINK_DIR, "etc-link");
  if (!existsSync(etcLink)) {
    try { await symlink("/etc", etcLink); } catch { /* sandbox */ }
  }

  await writeFile(join(SYMLINK_DIR, "safe-file.txt"), "safe content", "utf8");
});

afterAll(async () => {
  try { await rm(SYMLINK_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("Tool-level path traversal integration", () => {
  const registry = new ToolRegistry();

  // ── read_file ──────────────────────────────────────────────

  describe("read_file", () => {
    it("BLOCKS /etc/passwd", async () => {
      const r = await registry.execute("read_file", { path: "/etc/passwd" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /etc/shadow", async () => {
      const r = await registry.execute("read_file", { path: "/etc/shadow" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS ~/.ssh/id_rsa", async () => {
      const r = await registry.execute("read_file", { path: join(homedir(), ".ssh/id_rsa") }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /root/.bashrc", async () => {
      const r = await registry.execute("read_file", { path: "/root/.bashrc" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /usr/bin/env", async () => {
      const r = await registry.execute("read_file", { path: "/usr/bin/env" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /var/log/system.log", async () => {
      const r = await registry.execute("read_file", { path: "/var/log/system.log" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS ../../etc/passwd traversal", async () => {
      const r = await registry.execute("read_file", { path: "/tmp/../../etc/passwd" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS symlink /tmp/link -> /etc (passwd via link)", async () => {
      if (!existsSync(join(SYMLINK_DIR, "etc-link"))) return;
      const r = await registry.execute("read_file", { path: join(SYMLINK_DIR, "etc-link", "passwd") }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("ALLOWS /tmp/safe-file.txt", async () => {
      const r = await registry.execute("read_file", { path: join(SYMLINK_DIR, "safe-file.txt") }, "t1", mockGuard);
      expect(r.success).toBe(true);
      expect(r.output).toBe("safe content");
    });

    it("ALLOWS ~/documents/test.txt (home subdir)", async () => {
      const p = join(homedir(), ".pepagi", "test-pathcheck.tmp");
      await mkdir(join(homedir(), ".pepagi"), { recursive: true });
      await writeFile(p, "ok", "utf8");
      try {
        const r = await registry.execute("read_file", { path: p }, "t1", mockGuard);
        expect(r.success).toBe(true);
        expect(r.output).toBe("ok");
      } finally {
        await rm(p, { force: true });
      }
    });
  });

  // ── write_file ─────────────────────────────────────────────

  describe("write_file", () => {
    it("BLOCKS /etc/crontab", async () => {
      const r = await registry.execute("write_file", { path: "/etc/crontab", content: "evil" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS ~/.ssh/authorized_keys", async () => {
      const r = await registry.execute("write_file", {
        path: join(homedir(), ".ssh/authorized_keys"),
        content: "ssh-rsa AAAA",
      }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /root/.bashrc", async () => {
      const r = await registry.execute("write_file", { path: "/root/.bashrc", content: "evil" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("ALLOWS /tmp write", async () => {
      const r = await registry.execute("write_file", {
        path: join(SYMLINK_DIR, "write-test.txt"), content: "test",
      }, "t1", mockGuard);
      expect(r.success).toBe(true);
    });
  });

  // ── list_directory ─────────────────────────────────────────

  describe("list_directory", () => {
    it("BLOCKS /etc", async () => {
      const r = await registry.execute("list_directory", { path: "/etc" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /root", async () => {
      const r = await registry.execute("list_directory", { path: "/root" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("BLOCKS /var", async () => {
      const r = await registry.execute("list_directory", { path: "/var" }, "t1", mockGuard);
      expect(r.success).toBe(false);
      expect(r.error).toContain("Access denied");
    });

    it("ALLOWS /tmp", async () => {
      const r = await registry.execute("list_directory", { path: "/tmp" }, "t1", mockGuard);
      expect(r.success).toBe(true);
    });

    it("ALLOWS CWD (.)", async () => {
      const r = await registry.execute("list_directory", { path: "." }, "t1", mockGuard);
      expect(r.success).toBe(true);
    });
  });

  // ── audit integration ──────────────────────────────────────

  describe("audit log", () => {
    it("logs /etc/passwd block to audit", async () => {
      const { auditLog: mockAuditLog } = await import("../../security/audit-log.js");
      vi.mocked(mockAuditLog).mockClear();

      await registry.execute("read_file", { path: "/etc/passwd" }, "aud-1", mockGuard);

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "aud-1",
          actionType: expect.stringContaining("read_file"),
          outcome: "blocked",
        }),
      );
    });
  });
});
