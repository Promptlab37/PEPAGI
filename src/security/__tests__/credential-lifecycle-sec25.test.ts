// ═══════════════════════════════════════════════════════════════
// Tests: OAuth & Credential Delegation (SEC-25)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { CredentialLifecycleManager } from "../credential-lifecycle.js";

describe("Credential Lifecycle SEC-25", () => {
  let mgr: CredentialLifecycleManager;

  beforeEach(() => {
    mgr = new CredentialLifecycleManager();
  });

  describe("PKCE challenge generation", () => {
    it("generates valid PKCE pair", () => {
      const pkce = mgr.generatePKCE();
      expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(32);
      expect(pkce.codeChallenge.length).toBeGreaterThan(0);
      expect(pkce.method).toBe("S256");
    });

    it("verifier passes verification", () => {
      const pkce = mgr.generatePKCE();
      expect(mgr.verifyPKCE(pkce.codeVerifier, pkce.codeChallenge)).toBe(true);
    });

    it("wrong verifier fails verification", () => {
      const pkce = mgr.generatePKCE();
      expect(mgr.verifyPKCE("wrong-verifier", pkce.codeChallenge)).toBe(false);
    });

    it("generates unique pairs each time", () => {
      const a = mgr.generatePKCE();
      const b = mgr.generatePKCE();
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });
  });

  describe("task-scoped token issuance", () => {
    it("issues token with correct properties", () => {
      const token = mgr.issueTaskToken("task-1", "claude");
      expect(token.tokenId).toMatch(/^tok-/);
      expect(token.taskId).toBe("task-1");
      expect(token.provider).toBe("claude");
      expect(token.revoked).toBe(false);
      expect(token.expiresAt).toBeGreaterThan(token.issuedAt);
    });

    it("validates issued token", () => {
      const token = mgr.issueTaskToken("task-1", "claude");
      expect(mgr.validateToken(token.tokenId, "task-1")).toBe(true);
    });

    it("rejects token for wrong task", () => {
      const token = mgr.issueTaskToken("task-1", "claude");
      expect(mgr.validateToken(token.tokenId, "task-2")).toBe(false);
    });

    it("rejects unknown token", () => {
      expect(mgr.validateToken("tok-nonexistent", "task-1")).toBe(false);
    });

    it("enforces max lifetime cap", () => {
      // Request 1 hour, should be capped to 30 minutes
      const token = mgr.issueTaskToken("task-1", "claude", 60 * 60 * 1000);
      const lifetime = token.expiresAt - token.issuedAt;
      expect(lifetime).toBeLessThanOrEqual(30 * 60 * 1000);
    });
  });

  describe("token revocation", () => {
    it("revokes specific token", () => {
      const token = mgr.issueTaskToken("task-1", "claude");
      expect(mgr.revokeToken(token.tokenId)).toBe(true);
      expect(mgr.validateToken(token.tokenId, "task-1")).toBe(false);
    });

    it("returns false for unknown token", () => {
      expect(mgr.revokeToken("tok-nonexistent")).toBe(false);
    });

    it("revokes all tokens for a task", () => {
      const t1 = mgr.issueTaskToken("task-1", "claude");
      const t2 = mgr.issueTaskToken("task-1", "gpt");
      const revoked = mgr.revokeTaskTokens("task-1");
      expect(revoked).toBe(2);
      expect(mgr.validateToken(t1.tokenId, "task-1")).toBe(false);
      expect(mgr.validateToken(t2.tokenId, "task-1")).toBe(false);
    });

    it("returns 0 for task with no tokens", () => {
      expect(mgr.revokeTaskTokens("task-unknown")).toBe(0);
    });
  });

  describe("token expiration", () => {
    it("rejects expired token", async () => {
      // Issue with 1ms lifetime → expires immediately
      const token = mgr.issueTaskToken("task-1", "claude", 1);
      await new Promise(r => setTimeout(r, 5));
      expect(mgr.validateToken(token.tokenId, "task-1")).toBe(false);
    });
  });

  describe("active token tracking", () => {
    it("counts active tokens", () => {
      mgr.issueTaskToken("task-1", "claude");
      mgr.issueTaskToken("task-2", "gpt");
      expect(mgr.getActiveTokenCount()).toBe(2);
    });

    it("excludes revoked tokens from count", () => {
      const t = mgr.issueTaskToken("task-1", "claude");
      mgr.issueTaskToken("task-2", "gpt");
      mgr.revokeToken(t.tokenId);
      expect(mgr.getActiveTokenCount()).toBe(1);
    });

    it("checks if task has active tokens", () => {
      mgr.issueTaskToken("task-1", "claude");
      expect(mgr.hasActiveTokens("task-1")).toBe(true);
      expect(mgr.hasActiveTokens("task-2")).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes expired tokens", async () => {
      mgr.issueTaskToken("task-1", "claude", 1); // expires in 1ms
      mgr.issueTaskToken("task-2", "gpt");       // active
      await new Promise(r => setTimeout(r, 5));
      const cleaned = mgr.cleanup();
      expect(cleaned).toBe(1);
      expect(mgr.getActiveTokenCount()).toBe(1);
    });

    it("removes revoked tokens", () => {
      const t = mgr.issueTaskToken("task-1", "claude");
      mgr.revokeToken(t.tokenId);
      const cleaned = mgr.cleanup();
      expect(cleaned).toBe(1);
    });
  });
});
