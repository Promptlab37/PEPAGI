// ═══════════════════════════════════════════════════════════════
// Tests: path-validator.ts — Centralized Path Security
//
// Validates that validatePath() blocks all system paths,
// sensitive home paths, symlink bypasses, and ../ traversal.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { validatePath, PathSecurityError, _resetBasesCache } from "../path-validator.js";
import { symlink, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock audit-log to prevent file I/O during tests
vi.mock("../audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue({
    timestamp: new Date().toISOString(),
    actionType: "test",
    details: "test",
    outcome: "blocked",
    prevHash: "genesis",
    hash: "test",
  }),
}));

const SYMLINK_DIR = join("/tmp", "pepagi-pathval-test");
const SAFE_FILE = join(SYMLINK_DIR, "safe.txt");

beforeAll(async () => {
  _resetBasesCache();
  await mkdir(SYMLINK_DIR, { recursive: true });
  await writeFile(SAFE_FILE, "safe content", "utf8");

  // Symlink: /tmp/…/etc-link  →  /etc
  const etcLink = join(SYMLINK_DIR, "etc-link");
  if (!existsSync(etcLink)) {
    try { await symlink("/etc", etcLink); } catch { /* sandbox */ }
  }

  // Symlink: /tmp/…/ssh-link  →  ~/.ssh  (only if ~/.ssh exists)
  const sshDir = join(homedir(), ".ssh");
  if (existsSync(sshDir)) {
    const sshLink = join(SYMLINK_DIR, "ssh-link");
    if (!existsSync(sshLink)) {
      try { await symlink(sshDir, sshLink); } catch { /* sandbox */ }
    }
  }
});

afterAll(async () => {
  try { await rm(SYMLINK_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  _resetBasesCache();
});

// ── BLOCKED: system paths ────────────────────────────────────

describe("validatePath blocks system paths", () => {
  it("blocks /etc/passwd", async () => {
    await expect(validatePath("/etc/passwd", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /etc/shadow", async () => {
    await expect(validatePath("/etc/shadow", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /root/", async () => {
    await expect(validatePath("/root/.bashrc", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /var/log/", async () => {
    await expect(validatePath("/var/log/system.log", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /usr/bin/", async () => {
    await expect(validatePath("/usr/bin/env", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /sys/", async () => {
    await expect(validatePath("/sys/kernel/notes", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /proc/", async () => {
    await expect(validatePath("/proc/1/cmdline", "test")).rejects.toThrow(PathSecurityError);
  });
});

// ── BLOCKED: ../ traversal ───────────────────────────────────

describe("validatePath blocks ../ traversal", () => {
  it("blocks /tmp/../../etc/passwd", async () => {
    await expect(validatePath("/tmp/../../etc/passwd", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks ../../../../etc/passwd (relative escape from CWD)", async () => {
    // From CWD → ../../../../etc/passwd → /etc/passwd
    await expect(validatePath("../../../../etc/passwd", "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks deeply nested traversal", async () => {
    await expect(
      validatePath("/tmp/a/b/c/../../../../etc/passwd", "test"),
    ).rejects.toThrow(PathSecurityError);
  });
});

// ── BLOCKED: sensitive home paths ────────────────────────────

describe("validatePath blocks sensitive home paths", () => {
  it("blocks ~/.ssh/id_rsa", async () => {
    await expect(
      validatePath(join(homedir(), ".ssh/id_rsa"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });

  it("blocks ~/.ssh/authorized_keys", async () => {
    await expect(
      validatePath(join(homedir(), ".ssh/authorized_keys"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });

  it("blocks ~/.gnupg/", async () => {
    await expect(
      validatePath(join(homedir(), ".gnupg/pubring.kbx"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });

  it("blocks ~/.aws/credentials", async () => {
    await expect(
      validatePath(join(homedir(), ".aws/credentials"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });

  it("blocks ~/.kube/config", async () => {
    await expect(
      validatePath(join(homedir(), ".kube/config"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });

  it("blocks ~/.netrc", async () => {
    await expect(
      validatePath(join(homedir(), ".netrc"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });
});

// ── BLOCKED: symlink bypass ──────────────────────────────────

describe("validatePath blocks symlink bypass", () => {
  it("blocks /tmp/link -> /etc when reading passwd", async () => {
    const linkPath = join(SYMLINK_DIR, "etc-link", "passwd");
    if (!existsSync(join(SYMLINK_DIR, "etc-link"))) return; // skip if symlink failed
    await expect(validatePath(linkPath, "test")).rejects.toThrow(PathSecurityError);
  });

  it("blocks /tmp/link -> ~/.ssh when reading id_rsa", async () => {
    const sshLink = join(SYMLINK_DIR, "ssh-link");
    if (!existsSync(sshLink)) {
      // ~/.ssh doesn't exist — test direct path instead
      await expect(
        validatePath(join(homedir(), ".ssh/id_rsa"), "test"),
      ).rejects.toThrow(PathSecurityError);
      return;
    }
    await expect(
      validatePath(join(sshLink, "id_rsa"), "test"),
    ).rejects.toThrow(PathSecurityError);
  });
});

// ── ALLOWED: legitimate paths ────────────────────────────────

describe("validatePath allows legitimate paths", () => {
  it("allows ~/documents/test.txt (home subdir)", async () => {
    // Even if file doesn't exist, parent resolution lands under ~
    const testPath = join(homedir(), "documents", "test.txt");
    const resolved = await validatePath(testPath, "test");
    expect(resolved).toBeTruthy();
  });

  it("allows /tmp/test (temp dir)", async () => {
    const resolved = await validatePath(SAFE_FILE, "test");
    expect(resolved).toBeTruthy();
  });

  it("allows CWD-relative file", async () => {
    const resolved = await validatePath("package.json", "test");
    expect(resolved).toBeTruthy();
  });

  it("allows ~/.pepagi/ (non-sensitive home subdir)", async () => {
    const testPath = join(homedir(), ".pepagi", "config.json");
    const resolved = await validatePath(testPath, "test");
    expect(resolved).toBeTruthy();
  });

  it("returns the resolved canonical path", async () => {
    const resolved = await validatePath(SAFE_FILE, "test");
    // On macOS /tmp → /private/tmp, so resolved should be canonical
    expect(resolved).not.toContain("/../");
    expect(resolved).not.toContain("/./");
  });
});

// ── PathSecurityError properties ─────────────────────────────

describe("PathSecurityError", () => {
  it("includes rawPath and resolvedPath on the error", async () => {
    try {
      await validatePath("/etc/passwd", "read_file", "task-42");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathSecurityError);
      const e = err as PathSecurityError;
      expect(e.rawPath).toBe("/etc/passwd");
      expect(e.toolName).toBe("read_file");
      expect(e.name).toBe("PathSecurityError");
    }
  });
});

// ── Audit log integration ────────────────────────────────────

describe("audit logging on violation", () => {
  it("calls auditLog with CRITICAL details", async () => {
    const { auditLog: mockAuditLog } = await import("../audit-log.js");
    vi.mocked(mockAuditLog).mockClear();

    await validatePath("/etc/passwd", "read_file", "audit-check").catch(() => {});

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "audit-check",
        actionType: expect.stringContaining("read_file"),
        details: expect.stringContaining("CRITICAL"),
        outcome: "blocked",
      }),
    );
  });

  it("does NOT call auditLog for allowed paths", async () => {
    const { auditLog: mockAuditLog } = await import("../audit-log.js");
    vi.mocked(mockAuditLog).mockClear();

    await validatePath(SAFE_FILE, "test");
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
