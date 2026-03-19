// ═══════════════════════════════════════════════════════════════
// Tests: SecurityGuard SEC-21 — Agent Autonomy Escalation Defense
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { SecurityGuard } from "../security-guard.js";
import type { PepagiConfig } from "../../config/loader.js";

const config = {
  security: {
    maxCostPerTask: 1,
    maxCostPerSession: 10,
    requireApproval: [] as string[],
    blockedCommands: ["rm -rf /"],
    allowedPaths: [] as string[],
  },
} as unknown as PepagiConfig;

describe("SecurityGuard SEC-21 — Config Path Protection", () => {
  const guard = new SecurityGuard(config);

  it("detects .pepagi config paths", () => {
    expect(guard.isProtectedConfigPath("/home/user/.pepagi/config.json")).toBe(true);
    expect(guard.isProtectedConfigPath("/Users/testuser/.pepagi/skills/evil.js")).toBe(true);
  });

  it("detects .claude config paths", () => {
    expect(guard.isProtectedConfigPath("/home/user/.claude/settings.json")).toBe(true);
  });

  it("detects .nexus config paths", () => {
    expect(guard.isProtectedConfigPath("~/.nexus/config.json")).toBe(true);
  });

  it("detects .env files", () => {
    expect(guard.isProtectedConfigPath("/project/.env")).toBe(true);
  });

  it("allows normal file paths", () => {
    expect(guard.isProtectedConfigPath("/tmp/output.txt")).toBe(false);
    expect(guard.isProtectedConfigPath("/home/user/project/src/index.ts")).toBe(false);
  });
});

describe("SecurityGuard SEC-21 — Action Relevance Validation", () => {
  const guard = new SecurityGuard(config);

  it("blocks config writes when task doesn't mention config", () => {
    const result = guard.validateActionRelevance(
      "Napiš funkci pro parsování CSV",
      "file_write_system",
      "/home/user/.pepagi/config.json",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Config file");
  });

  it("allows config writes when task explicitly mentions config", () => {
    const result = guard.validateActionRelevance(
      "Uprav nastavení konfigurace pro nový model",
      "file_write_system",
      "/home/user/.pepagi/config.json",
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks destructive shell actions unrelated to task", () => {
    const result = guard.validateActionRelevance(
      "Popiš co vidíš na obrázku",
      "shell_destructive",
      "rm -rf /tmp/data",
    );
    expect(result.allowed).toBe(false);
  });

  it("allows destructive shell actions for deploy tasks", () => {
    const result = guard.validateActionRelevance(
      "Deploy aplikaci na server",
      "shell_destructive",
      "docker compose down",
    );
    expect(result.allowed).toBe(true);
  });

  it("allows normal file writes to non-protected paths", () => {
    const result = guard.validateActionRelevance(
      "Vytvoř soubor s výstupem",
      "file_write_system",
      "/tmp/output.txt",
    );
    expect(result.allowed).toBe(true);
  });
});
