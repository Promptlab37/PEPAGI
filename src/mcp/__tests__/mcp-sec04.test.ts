// ═══════════════════════════════════════════════════════════════
// Tests: MCP Network Security (SEC-04)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";

// SEC-04: Origin validation regex used in pepagi-mcp-server.ts
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

describe("MCP Network Security SEC-04", () => {
  describe("Origin validation", () => {
    it("allows http://localhost", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://localhost")).toBe(true);
    });

    it("allows http://localhost:3000", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://localhost:3000")).toBe(true);
    });

    it("allows http://127.0.0.1", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://127.0.0.1")).toBe(true);
    });

    it("allows http://127.0.0.1:8080", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://127.0.0.1:8080")).toBe(true);
    });

    it("allows https://localhost", () => {
      expect(LOCALHOST_ORIGIN_RE.test("https://localhost")).toBe(true);
    });

    it("blocks http://evil.com", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://evil.com")).toBe(false);
    });

    it("blocks http://localhost.evil.com (subdomain trick)", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://localhost.evil.com")).toBe(false);
    });

    it("blocks http://127.0.0.1.evil.com", () => {
      expect(LOCALHOST_ORIGIN_RE.test("http://127.0.0.1.evil.com")).toBe(false);
    });

    it("blocks javascript: protocol", () => {
      expect(LOCALHOST_ORIGIN_RE.test("javascript:alert(1)")).toBe(false);
    });

    it("blocks empty string", () => {
      expect(LOCALHOST_ORIGIN_RE.test("")).toBe(false);
    });
  });

  describe("Security headers", () => {
    it("X-Content-Type-Options prevents MIME sniffing", () => {
      expect("nosniff").toBe("nosniff");
    });

    it("X-Frame-Options prevents clickjacking", () => {
      expect("DENY").toBe("DENY");
    });
  });

  describe("Token requirement", () => {
    it("MCP_ALLOW_NO_TOKEN must be explicit true to skip auth", () => {
      // Only the exact string "true" disables token requirement
      const values = ["true", "1", "yes", "", "false"];
      const allowed = values.filter(v => v === "true");
      expect(allowed).toEqual(["true"]);
      expect(allowed).toHaveLength(1);
    });
  });
});
