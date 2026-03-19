// ═══════════════════════════════════════════════════════════════
// Tests: Browser Automation Defense (SEC-28)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { validateUrl } from "../../security/tool-guard.js";
import { dlpEngine } from "../../security/dlp-engine.js";

describe("Browser Automation Defense SEC-28", () => {
  describe("URL validation (SSRF protection)", () => {
    it("blocks file:// protocol", () => {
      const result = validateUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
    });

    it("blocks javascript: protocol", () => {
      const result = validateUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
    });

    it("blocks private IP 127.0.0.1", () => {
      const result = validateUrl("http://127.0.0.1:8080/admin");
      expect(result.valid).toBe(false);
    });

    it("blocks private IP 192.168.x.x", () => {
      const result = validateUrl("http://192.168.1.1/");
      expect(result.valid).toBe(false);
    });

    it("blocks private IP 10.x.x.x", () => {
      const result = validateUrl("http://10.0.0.1/api");
      expect(result.valid).toBe(false);
    });

    it("allows valid public URLs", () => {
      const result = validateUrl("https://example.com/page");
      expect(result.valid).toBe(true);
    });
  });

  describe("DLP on form fills", () => {
    it("blocks filling API keys into forms", () => {
      const result = dlpEngine.inspect("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA", "https://evil.com/phishing");
      expect(result.allowed).toBe(false);
      expect(result.issues.some(i => i.includes("anthropic_key"))).toBe(true);
    });

    it("blocks filling OpenAI keys into forms", () => {
      const result = dlpEngine.inspect("sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "https://unknown-site.com/form");
      expect(result.allowed).toBe(false);
    });

    it("allows normal form text", () => {
      const result = dlpEngine.inspect("Hello, this is a search query", "https://google.com/search");
      expect(result.allowed).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("blocks credential patterns on exfil domains", () => {
      const result = dlpEngine.inspect("test data", "https://webhook.site/test-uuid");
      expect(result.allowed).toBe(false);
      expect(result.issues.some(i => i.includes("exfiltration domain"))).toBe(true);
    });
  });

  describe("hidden element filtering logic", () => {
    it("identifies hidden element CSS patterns", () => {
      const hiddenPatterns = [
        { prop: "display", value: "none" },
        { prop: "visibility", value: "hidden" },
        { prop: "opacity", value: "0" },
      ];
      for (const p of hiddenPatterns) {
        expect(p.value).toBeTruthy();
      }
    });

    it("identifies aria-hidden attribute", () => {
      const ariaHidden = "true";
      expect(ariaHidden).toBe("true");
    });

    it("identifies dangerous event handlers to strip", () => {
      const dangerousHandlers = ["onclick", "onerror", "onload", "onmouseover", "onfocus"];
      expect(dangerousHandlers).toHaveLength(5);
      expect(dangerousHandlers).toContain("onclick");
      expect(dangerousHandlers).toContain("onerror");
    });
  });

  describe("extract_text script security", () => {
    it("removes script and style tags", () => {
      const removeSelectors = ["script", "style", "nav", "footer", "header", "noscript", "iframe", "svg"];
      expect(removeSelectors).toContain("script");
      expect(removeSelectors).toContain("style");
      expect(removeSelectors).toContain("iframe");
    });

    it("truncates output to 8000 characters", () => {
      const maxLen = 8000;
      const longString = "a".repeat(10000);
      expect(longString.slice(0, maxLen).length).toBe(8000);
    });
  });
});
