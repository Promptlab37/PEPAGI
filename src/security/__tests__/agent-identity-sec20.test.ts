// ═══════════════════════════════════════════════════════════════
// Tests: Agent Identity & NHI Governance (SEC-20)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { AgentAuthenticator } from "../agent-authenticator.js";

describe("Agent Identity SEC-20", () => {
  let auth: AgentAuthenticator;

  beforeEach(() => {
    auth = new AgentAuthenticator("test-secret-key");
  });

  describe("agent registration", () => {
    it("assigns UUID to registered agent", () => {
      const identity = auth.registerAgent("claude");
      expect(identity.agentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("generates unique IDs for different agents", () => {
      const id1 = auth.registerAgent("claude");
      const id2 = auth.registerAgent("gpt");
      expect(id1.agentId).not.toBe(id2.agentId);
    });

    it("generates session token on registration", () => {
      const identity = auth.registerAgent("gemini");
      expect(identity.sessionToken).toHaveLength(64); // 32 bytes hex
    });

    it("sets expiry time on token", () => {
      const identity = auth.registerAgent("claude");
      expect(identity.expiresAt).toBeGreaterThan(identity.issuedAt);
      // 15 minutes
      expect(identity.expiresAt - identity.issuedAt).toBe(15 * 60 * 1000);
    });
  });

  describe("session token validation", () => {
    it("validates correct token", () => {
      const identity = auth.registerAgent("claude");
      expect(auth.validateSessionToken(identity.agentId, identity.sessionToken)).toBe(true);
    });

    it("rejects wrong token", () => {
      const identity = auth.registerAgent("claude");
      expect(auth.validateSessionToken(identity.agentId, "wrong-token")).toBe(false);
    });

    it("rejects unknown agent", () => {
      expect(auth.validateSessionToken("unknown-uuid", "any-token")).toBe(false);
    });
  });

  describe("token rotation", () => {
    it("rotates token successfully", () => {
      const identity = auth.registerAgent("claude");
      const oldToken = identity.sessionToken;
      const rotated = auth.rotateToken(identity.agentId);
      expect(rotated).not.toBeNull();
      expect(rotated!.sessionToken).not.toBe(oldToken);
    });

    it("new token validates after rotation", () => {
      const identity = auth.registerAgent("gpt");
      const rotated = auth.rotateToken(identity.agentId)!;
      expect(auth.validateSessionToken(identity.agentId, rotated.sessionToken)).toBe(true);
    });

    it("old token invalid after rotation", () => {
      const identity = auth.registerAgent("claude");
      const oldToken = identity.sessionToken;
      auth.rotateToken(identity.agentId);
      expect(auth.validateSessionToken(identity.agentId, oldToken)).toBe(false);
    });

    it("returns null for unknown agent", () => {
      expect(auth.rotateToken("unknown-uuid")).toBeNull();
    });
  });

  describe("provider lookup", () => {
    it("finds identity by provider name", () => {
      const identity = auth.registerAgent("claude");
      const found = auth.getIdentityByProvider("claude");
      expect(found?.agentId).toBe(identity.agentId);
    });

    it("returns undefined for unknown provider", () => {
      expect(auth.getIdentityByProvider("unknown")).toBeUndefined();
    });
  });
});
