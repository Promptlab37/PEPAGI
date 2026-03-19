// ═══════════════════════════════════════════════════════════════
// Tests: Context Window DoS Defense (SEC-22)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Watchdog } from "../watchdog.js";

// Minimal TaskStore mock
const mockTaskStore = {
  getAll: () => [],
  get: () => undefined,
  create: vi.fn(),
  update: vi.fn(),
} as any;

describe("Context Window DoS Defense SEC-22", () => {
  let watchdog: Watchdog;

  beforeEach(() => {
    watchdog = new Watchdog(mockTaskStore);
  });

  describe("semantic loop detection", () => {
    it("returns false with no history", () => {
      expect(watchdog.detectSemanticLoop("task-1")).toBe(false);
    });

    it("returns false with single output", () => {
      watchdog.recordOutput("task-1", "First output about building a React app");
      expect(watchdog.detectSemanticLoop("task-1")).toBe(false);
    });

    it("detects identical repeated outputs", () => {
      watchdog.recordOutput("task-1", "The React application component renders a form with validation logic");
      watchdog.recordOutput("task-1", "The React application component renders a form with validation logic");
      expect(watchdog.detectSemanticLoop("task-1")).toBe(true);
    });

    it("detects semantically similar outputs", () => {
      watchdog.recordOutput("task-1", "The React application component renders a form with validation logic and error handling");
      watchdog.recordOutput("task-1", "The React application component renders a form with validation logic and error messages");
      expect(watchdog.detectSemanticLoop("task-1")).toBe(true);
    });

    it("returns false for different outputs", () => {
      watchdog.recordOutput("task-1", "Created database schema with users table");
      watchdog.recordOutput("task-1", "Deployed application to production server");
      expect(watchdog.detectSemanticLoop("task-1")).toBe(false);
    });
  });

  describe("per-agent resource quotas", () => {
    it("allows usage within quota", () => {
      expect(watchdog.trackAgentUsage("task-1", "claude", 1000, 2)).toBe(true);
    });

    it("tracks cumulative token usage", () => {
      watchdog.trackAgentUsage("task-1", "claude", 100_000, 1);
      watchdog.trackAgentUsage("task-1", "claude", 100_000, 1);
      const quota = watchdog.getAgentQuota("task-1", "claude");
      expect(quota.tokens).toBe(200_000);
      expect(quota.toolCalls).toBe(2);
    });

    it("blocks when token quota exceeded", () => {
      watchdog.trackAgentUsage("task-1", "claude", 400_000, 0);
      expect(watchdog.trackAgentUsage("task-1", "claude", 200_000, 0)).toBe(false);
    });

    it("blocks when tool call quota exceeded", () => {
      watchdog.trackAgentUsage("task-1", "gpt", 0, 45);
      expect(watchdog.trackAgentUsage("task-1", "gpt", 0, 10)).toBe(false);
    });

    it("tracks quotas per agent independently", () => {
      watchdog.trackAgentUsage("task-1", "claude", 400_000, 0);
      expect(watchdog.trackAgentUsage("task-1", "gpt", 100_000, 1)).toBe(true);
    });

    it("returns empty quota for unknown agent", () => {
      const quota = watchdog.getAgentQuota("task-x", "unknown");
      expect(quota.tokens).toBe(0);
      expect(quota.toolCalls).toBe(0);
    });
  });

  describe("approval rate limiter", () => {
    it("allows first approval request", () => {
      expect(watchdog.checkApprovalRate()).toBe(true);
    });

    it("allows up to 3 requests per minute", () => {
      expect(watchdog.checkApprovalRate()).toBe(true);
      expect(watchdog.checkApprovalRate()).toBe(true);
      expect(watchdog.checkApprovalRate()).toBe(true);
    });

    it("blocks 4th request within one minute", () => {
      watchdog.checkApprovalRate();
      watchdog.checkApprovalRate();
      watchdog.checkApprovalRate();
      expect(watchdog.checkApprovalRate()).toBe(false);
    });
  });
});
