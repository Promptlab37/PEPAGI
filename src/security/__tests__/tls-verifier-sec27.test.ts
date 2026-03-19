// ═══════════════════════════════════════════════════════════════
// Tests: Hardware & Inference Infrastructure (SEC-27)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from "vitest";
import {
  validateEndpoint,
  checkTLSEnvironment,
  guardOutboundRequest,
} from "../tls-verifier.js";

describe("TLS & Infrastructure Security SEC-27", () => {
  describe("endpoint validation", () => {
    it("allows Anthropic API over HTTPS", () => {
      const result = validateEndpoint("https://api.anthropic.com/v1/messages");
      expect(result.valid).toBe(true);
      expect(result.useTLS).toBe(true);
      expect(result.isLocal).toBe(false);
    });

    it("allows OpenAI API over HTTPS", () => {
      const result = validateEndpoint("https://api.openai.com/v1/chat/completions");
      expect(result.valid).toBe(true);
    });

    it("allows Google AI API over HTTPS", () => {
      const result = validateEndpoint("https://generativelanguage.googleapis.com/v1beta/models");
      expect(result.valid).toBe(true);
    });

    it("allows localhost (Ollama)", () => {
      const result = validateEndpoint("http://localhost:11434/api/generate");
      expect(result.valid).toBe(true);
      expect(result.isLocal).toBe(true);
    });

    it("allows 127.0.0.1 (LM Studio)", () => {
      const result = validateEndpoint("http://127.0.0.1:1234/v1/chat/completions");
      expect(result.valid).toBe(true);
      expect(result.isLocal).toBe(true);
    });

    it("blocks unknown cloud host", () => {
      const result = validateEndpoint("https://evil-api.example.com/v1/chat");
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.includes("Unknown API host"))).toBe(true);
    });

    it("blocks cloud API without TLS", () => {
      const result = validateEndpoint("http://api.anthropic.com/v1/messages");
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.includes("not using TLS"))).toBe(true);
    });

    it("handles invalid URL", () => {
      const result = validateEndpoint("not-a-url");
      expect(result.valid).toBe(false);
    });

    it("warns on non-standard local port", () => {
      const result = validateEndpoint("http://localhost:9999/api");
      expect(result.valid).toBe(true); // still valid (localhost), but warns
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("TLS environment check", () => {
    const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
      }
    });

    it("reports secure when TLS validation is enabled", () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      const result = checkTLSEnvironment();
      expect(result.secure).toBe(true);
    });

    it("reports insecure when TLS validation is disabled", () => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      const result = checkTLSEnvironment();
      expect(result.secure).toBe(false);
      expect(result.warning).toBeTruthy();
    });
  });

  describe("outbound request guard", () => {
    it("allows valid cloud API call", () => {
      expect(guardOutboundRequest("https://api.anthropic.com/v1/messages")).toBe(true);
    });

    it("blocks unknown host", () => {
      expect(guardOutboundRequest("https://malicious.com/steal-data")).toBe(false);
    });

    it("blocks cloud without TLS", () => {
      expect(guardOutboundRequest("http://api.openai.com/v1/chat")).toBe(false);
    });

    it("allows local Ollama", () => {
      expect(guardOutboundRequest("http://localhost:11434/api/generate")).toBe(true);
    });
  });
});
