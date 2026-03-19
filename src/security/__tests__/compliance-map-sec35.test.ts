// ═══════════════════════════════════════════════════════════════
// Tests: Security Framework Compliance (SEC-35)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  COMPLIANCE_MAP,
  generateAIBOM,
  getOWASPMapping,
  getMITREMapping,
  getCoverageSummary,
} from "../compliance-map.js";

describe("Security Framework Compliance SEC-35", () => {
  describe("compliance map completeness", () => {
    it("covers all 35 SEC categories", () => {
      expect(COMPLIANCE_MAP).toHaveLength(35);
    });

    it("every entry has OWASP ASI mapping", () => {
      for (const entry of COMPLIANCE_MAP) {
        expect(entry.owaspAsi.length).toBeGreaterThan(0);
        for (const code of entry.owaspAsi) {
          expect(code).toMatch(/^ASI-\d{2}$/);
        }
      }
    });

    it("every entry has MITRE ATLAS mapping", () => {
      for (const entry of COMPLIANCE_MAP) {
        expect(entry.mitreAtlas.length).toBeGreaterThan(0);
        for (const code of entry.mitreAtlas) {
          expect(code).toMatch(/^AML\.T\d{4}$/);
        }
      }
    });

    it("every entry has NIST AI mapping", () => {
      for (const entry of COMPLIANCE_MAP) {
        expect(entry.nistAi.length).toBeGreaterThan(0);
      }
    });

    it("SEC IDs are sequential from 01 to 35", () => {
      for (let i = 0; i < 35; i++) {
        const expected = `SEC-${String(i + 1).padStart(2, "0")}`;
        expect(COMPLIANCE_MAP[i].secId).toBe(expected);
      }
    });
  });

  describe("OWASP mapping lookup", () => {
    it("returns ASI-01 for SEC-01 (Prompt Injection)", () => {
      const codes = getOWASPMapping("SEC-01");
      expect(codes).toContain("ASI-01");
    });

    it("returns empty for unknown SEC", () => {
      const codes = getOWASPMapping("SEC-99");
      expect(codes).toHaveLength(0);
    });
  });

  describe("MITRE mapping lookup", () => {
    it("returns ATLAS technique for SEC-01", () => {
      const codes = getMITREMapping("SEC-01");
      expect(codes.length).toBeGreaterThan(0);
      expect(codes[0]).toMatch(/^AML\.T/);
    });
  });

  describe("AIBOM generation", () => {
    it("includes models", () => {
      const aibom = generateAIBOM();
      const models = aibom.filter(e => e.type === "model");
      expect(models.length).toBeGreaterThanOrEqual(6);
    });

    it("includes memory systems", () => {
      const aibom = generateAIBOM();
      const memories = aibom.filter(e => e.type === "memory");
      expect(memories.length).toBe(5); // 5 memory levels
    });

    it("includes tools", () => {
      const aibom = generateAIBOM();
      const tools = aibom.filter(e => e.type === "tool");
      expect(tools.length).toBeGreaterThanOrEqual(4);
    });

    it("includes frameworks", () => {
      const aibom = generateAIBOM();
      const frameworks = aibom.filter(e => e.type === "framework");
      expect(frameworks.length).toBeGreaterThanOrEqual(2);
    });

    it("every entry has required fields", () => {
      const aibom = generateAIBOM();
      for (const entry of aibom) {
        expect(entry.component).toBeTruthy();
        expect(entry.type).toBeTruthy();
        expect(entry.provider).toBeTruthy();
        expect(entry.version).toBeTruthy();
        expect(entry.description).toBeTruthy();
      }
    });
  });

  describe("coverage summary", () => {
    it("reports all 35 categories", () => {
      const summary = getCoverageSummary();
      expect(summary.totalCategories).toBe(35);
    });

    it("covers OWASP ASI codes", () => {
      const summary = getCoverageSummary();
      expect(summary.owaspCovered).toBeGreaterThanOrEqual(8); // ASI-01 through ASI-10
    });

    it("covers MITRE ATLAS techniques", () => {
      const summary = getCoverageSummary();
      expect(summary.mitreCovered).toBeGreaterThanOrEqual(4);
    });

    it("covers NIST AI sections", () => {
      const summary = getCoverageSummary();
      expect(summary.nistCovered).toBeGreaterThanOrEqual(8);
    });
  });
});
