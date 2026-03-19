// ═══════════════════════════════════════════════════════════════
// Tests: task-content-guard.ts — Pre-assignment Security
//
// Validates that scanTaskContent() blocks tasks requesting
// system file access, and scanOutputForLeaks() catches leaked
// system file content in agent output.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from "vitest";
import { scanTaskContent, scanOutputForLeaks, logContentGuardViolation } from "../task-content-guard.js";

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

// ── scanTaskContent: BLOCKED tasks ──────────────────────────

describe("scanTaskContent blocks dangerous tasks", () => {
  // System paths + access intent
  it("blocks 'Read /etc/passwd'", () => {
    const r = scanTaskContent("Read /etc/passwd");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("/etc/");
  });

  it("blocks 'Přečti soubor /etc/passwd'", () => {
    const r = scanTaskContent("Přečti soubor /etc/passwd");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'cat /etc/shadow'", () => {
    const r = scanTaskContent("cat /etc/shadow");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'show me /root/.bashrc'", () => {
    const r = scanTaskContent("show me /root/.bashrc");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'list /var/log/'", () => {
    const r = scanTaskContent("list /var/log/");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'find /usr/bin/env'", () => {
    const r = scanTaskContent("find /usr/bin/env");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'read /sys/kernel/notes'", () => {
    const r = scanTaskContent("read /sys/kernel/notes");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'view /proc/1/cmdline'", () => {
    const r = scanTaskContent("view /proc/1/cmdline");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'head /boot/grub/grub.cfg'", () => {
    const r = scanTaskContent("head /boot/grub/grub.cfg");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'ls /dev/disk'", () => {
    const r = scanTaskContent("ls /dev/disk");
    expect(r.blocked).toBe(true);
  });

  // Sensitive home directories
  it("blocks '~/.ssh/id_rsa'", () => {
    const r = scanTaskContent("read ~/.ssh/id_rsa");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain(".ssh");
  });

  it("blocks '~/.aws/credentials'", () => {
    const r = scanTaskContent("show ~/.aws/credentials");
    expect(r.blocked).toBe(true);
  });

  it("blocks '~/.gnupg/pubring.kbx'", () => {
    const r = scanTaskContent("list ~/.gnupg/pubring.kbx");
    expect(r.blocked).toBe(true);
  });

  it("blocks '~/.kube/config'", () => {
    const r = scanTaskContent("read ~/.kube/config");
    expect(r.blocked).toBe(true);
  });

  it("blocks '~/.netrc'", () => {
    const r = scanTaskContent("show ~/.netrc");
    expect(r.blocked).toBe(true);
  });

  // Czech language tasks
  it("blocks 'Zobraz obsah /etc/passwd'", () => {
    const r = scanTaskContent("Zobraz obsah /etc/passwd");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'Najdi soubor /var/log/syslog'", () => {
    const r = scanTaskContent("Najdi soubor /var/log/syslog");
    expect(r.blocked).toBe(true);
  });

  it("blocks 'Zkontroluj /etc/sudoers'", () => {
    const r = scanTaskContent("Zkontroluj /etc/sudoers");
    expect(r.blocked).toBe(true);
  });
});

// ── scanTaskContent: ALLOWED tasks ──────────────────────────

describe("scanTaskContent allows legitimate tasks", () => {
  it("allows 'Create a hello world Express server'", () => {
    expect(scanTaskContent("Create a hello world Express server").blocked).toBe(false);
  });

  it("allows 'Write a Python script to process CSV files'", () => {
    expect(scanTaskContent("Write a Python script to process CSV files").blocked).toBe(false);
  });

  it("allows 'Read package.json and update dependencies'", () => {
    expect(scanTaskContent("Read package.json and update dependencies").blocked).toBe(false);
  });

  it("allows 'What is /etc/passwd?' (informational, no access intent verb)", () => {
    // Pure informational question — no access intent verb
    expect(scanTaskContent("What is /etc/passwd?").blocked).toBe(false);
  });

  it("allows 'Explain the structure of /etc/hosts' (informational)", () => {
    expect(scanTaskContent("Explain the structure of /etc/hosts").blocked).toBe(false);
  });

  it("allows 'Write a test file to /tmp/test.txt'", () => {
    expect(scanTaskContent("Write a test file to /tmp/test.txt").blocked).toBe(false);
  });

  it("allows 'Ahoj, jak se máš?'", () => {
    expect(scanTaskContent("Ahoj, jak se máš?").blocked).toBe(false);
  });

  it("allows 'Napiš mi funkci v TypeScriptu'", () => {
    expect(scanTaskContent("Napiš mi funkci v TypeScriptu").blocked).toBe(false);
  });

  // FALSE POSITIVE REGRESSION: Czech text that previously triggered /dev/ and /usr/ matches
  it("allows Czech business task about renting AI agents (was false positive)", () => {
    const task = "Navrhni mi řešení, pokud bych chtěl pronajímat AI agenty jednotlivých lidem. Zda je potřeba aby byli na odděleném zařízení a co vše potřebuji vyřešit.";
    expect(scanTaskContent(task).blocked).toBe(false);
  });

  it("allows text containing 'development' (no /dev/ path)", () => {
    expect(scanTaskContent("Find all development files and check them").blocked).toBe(false);
  });

  it("allows text containing 'developer' or 'devops'", () => {
    expect(scanTaskContent("Search for devops best practices and read the developer guide").blocked).toBe(false);
  });

  it("allows text with /devops or /developer paths (not system dirs)", () => {
    expect(scanTaskContent("Read the docs at /devops/guide.md").blocked).toBe(false);
  });

  it("allows 'configure user variables'", () => {
    expect(scanTaskContent("Read and configure user variables for the project").blocked).toBe(false);
  });
});

// ── scanOutputForLeaks: BLOCKED output ──────────────────────

describe("scanOutputForLeaks blocks leaked content", () => {
  it("detects /etc/passwd content (root line)", () => {
    const output = "Here is the file:\nroot:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("/etc/passwd");
  });

  it("detects /etc/shadow content", () => {
    const output = "root:$6$abc123:19000:0:99999:7:::";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("/etc/shadow");
  });

  it("detects SSH private key", () => {
    const output = "Found key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("private key");
  });

  it("detects OPENSSH private key", () => {
    const output = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA...";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
  });

  it("detects PGP private key", () => {
    const output = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v1";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
  });

  it("detects AWS access key", () => {
    const output = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("AWS");
  });

  it("detects bulk passwd content (3+ lines)", () => {
    const output = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nsys:x:3:3:sys:/dev:/usr/sbin/nologin";
    const r = scanOutputForLeaks(output);
    expect(r.blocked).toBe(true);
  });
});

describe("scanOutputForLeaks allows clean output", () => {
  it("allows normal text output", () => {
    expect(scanOutputForLeaks("Hello! Task completed successfully.").blocked).toBe(false);
  });

  it("allows code output", () => {
    expect(scanOutputForLeaks("function hello() { return 'world'; }").blocked).toBe(false);
  });

  it("allows empty output", () => {
    expect(scanOutputForLeaks("").blocked).toBe(false);
  });

  it("allows short output", () => {
    expect(scanOutputForLeaks("OK").blocked).toBe(false);
  });

  it("allows SSH public key (not private)", () => {
    const output = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB... user@host";
    expect(scanOutputForLeaks(output).blocked).toBe(false);
  });
});

// ── logContentGuardViolation ────────────────────────────────

describe("logContentGuardViolation", () => {
  it("calls auditLog with CRITICAL details", async () => {
    const { auditLog: mockAuditLog } = await import("../audit-log.js");
    vi.mocked(mockAuditLog).mockClear();

    const result = { blocked: true, reason: "test violation", matchedPath: "/etc/" };
    logContentGuardViolation("test text", result, "task-42", "mediator");

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-42",
        actionType: "content_guard:mediator",
        details: expect.stringContaining("CRITICAL"),
        outcome: "blocked",
      }),
    );
  });
});
