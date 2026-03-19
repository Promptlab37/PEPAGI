// ═══════════════════════════════════════════════════════════════
// Tests: LLM Provider
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateCost, PRICING } from "../pricing.js";

// Mock the claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    yield { result: '{"action":"complete","reasoning":"Test","confidence":0.9,"result":"done"}' };
  }),
}));

describe("Pricing", () => {
  it("calculates cost for claude-opus-4-6", () => {
    const cost = calculateCost("claude-opus-4-6", 1_000_000, 1_000_000);
    expect(cost).toBe(30); // $5 input + $25 output
  });

  it("calculates cost for gpt-4o", () => {
    const cost = calculateCost("gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5); // $2.5 + $10
  });

  it("returns 0 for unknown model", () => {
    const cost = calculateCost("unknown-model", 1_000, 1_000);
    expect(cost).toBe(0);
  });

  it("calculates proportional cost for partial usage", () => {
    const cost = calculateCost("claude-haiku-4-5", 100_000, 100_000);
    expect(cost).toBeCloseTo(0.48); // (0.8 + 4.0) * 0.1
  });
});

describe("Pricing table", () => {
  it("has required models", () => {
    const modelIds = PRICING.map(p => p.model);
    expect(modelIds).toContain("claude-opus-4-6");
    expect(modelIds).toContain("claude-haiku-4-5");
    expect(modelIds).toContain("gpt-4o");
    expect(modelIds).toContain("gemini-2.0-flash");
  });

  it("has positive pricing for all models", () => {
    for (const p of PRICING) {
      expect(p.inputCostPer1M).toBeGreaterThanOrEqual(0);
      expect(p.outputCostPer1M).toBeGreaterThanOrEqual(0);
    }
  });

  it("has valid context windows", () => {
    for (const p of PRICING) {
      expect(p.contextWindow).toBeGreaterThan(0);
    }
  });
});
