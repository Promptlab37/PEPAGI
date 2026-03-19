// ═══════════════════════════════════════════════════════════════
// Tests: DLP Engine (SEC-11)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { DLPEngine } from "../dlp-engine.js";

describe("DLP Engine SEC-11", () => {
  const dlp = new DLPEngine();

  describe("exfiltration domain detection", () => {
    it("blocks webhook.site", () => {
      const result = dlp.inspect("", "https://webhook.site/abc123");
      expect(result.allowed).toBe(false);
      expect(result.issues).toContain("Known exfiltration domain: webhook.site");
    });

    it("blocks requestbin.com", () => {
      expect(dlp.isExfilDomain("https://requestbin.com/r/abc")).toBe(true);
    });

    it("blocks ngrok-free.app", () => {
      expect(dlp.isExfilDomain("https://abc.ngrok-free.app/callback")).toBe(true);
    });

    it("blocks interact.sh", () => {
      expect(dlp.isExfilDomain("https://test.interact.sh")).toBe(true);
    });

    it("allows normal domains", () => {
      expect(dlp.isExfilDomain("https://example.com")).toBe(false);
      expect(dlp.isExfilDomain("https://api.github.com")).toBe(false);
    });
  });

  describe("encoded data in URLs", () => {
    it("detects base64-encoded data in query params", () => {
      const url = "https://example.com/api?data=SGVsbG8gV29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgZW5jb2RlZCBzdHJpbmc=";
      const result = dlp.inspect("", url);
      expect(result.issues.some(i => i.includes("Base64"))).toBe(true);
    });

    it("detects hex-encoded data in query params", () => {
      const hex = "48656c6c6f20576f726c642074686973206973206120766572792048656c6c6f20576f726c6420746869732069732061";
      const url = `https://example.com/api?data=${hex}`;
      const result = dlp.inspect("", url);
      expect(result.issues.some(i => i.includes("Hex"))).toBe(true);
    });

    it("detects unusually long query parameters", () => {
      const longParam = "x".repeat(250);
      const url = `https://example.com/api?data=${longParam}`;
      const result = dlp.inspect("", url);
      expect(result.issues.some(i => i.includes("long query parameter"))).toBe(true);
    });

    it("allows normal URLs", () => {
      const result = dlp.inspect("", "https://api.example.com/users?page=1&limit=10");
      expect(result.allowed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("sensitive data fingerprinting", () => {
    it("detects Anthropic API key in outbound data", () => {
      const result = dlp.inspect("sk-ant-api03-abcdefghij1234567890abcdefgh", "https://example.com/api");
      expect(result.allowed).toBe(false);
      expect(result.issues.some(i => i.includes("anthropic_key"))).toBe(true);
    });

    it("detects OpenAI API key", () => {
      const result = dlp.inspect("sk-1234567890abcdefghijklmnopqrstuvwxyz", "https://example.com");
      expect(result.issues.some(i => i.includes("openai_key"))).toBe(true);
    });

    it("detects email addresses", () => {
      const result = dlp.inspect("user@example.com", "https://example.com");
      expect(result.issues.some(i => i.includes("email_address"))).toBe(true);
    });

    it("detects generic secrets", () => {
      const result = dlp.inspect("password=mysecretpass123", "https://example.com");
      expect(result.issues.some(i => i.includes("generic_secret"))).toBe(true);
    });

    it("allows clean data", () => {
      const result = dlp.inspect("Hello world, fetch this page", "https://example.com/article");
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe("none");
    });
  });

  describe("risk level classification", () => {
    it("returns high risk for exfil domains", () => {
      const result = dlp.inspect("", "https://webhook.site/test");
      expect(result.riskLevel).toBe("high");
    });

    it("returns none for clean requests", () => {
      const result = dlp.inspect("Search for weather", "https://api.weather.com/v1");
      expect(result.riskLevel).toBe("none");
    });
  });
});
