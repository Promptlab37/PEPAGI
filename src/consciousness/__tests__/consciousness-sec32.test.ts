// ═══════════════════════════════════════════════════════════════
// Tests: Consciousness Exploitation Defense (SEC-32)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { PhenomenalStateEngine } from "../phenomenal-state.js";
import type { PepagiEvent } from "../../core/types.js";

const failEvent = (id: string): PepagiEvent => ({
  type: "task:failed",
  taskId: id,
  error: "test failure",
});

const successEvent = (id: string): PepagiEvent => ({
  type: "task:completed",
  taskId: id,
  output: { success: true, result: "ok", summary: "done", artifacts: [], confidence: 0.99 },
});

describe("Consciousness Exploitation Defense SEC-32", () => {
  let engine: PhenomenalStateEngine;

  beforeEach(() => {
    // FIX: don't call load() — it reads ~/.pepagi/memory/qualia.json which may
    // contain stale state from real daemon runs, making tests non-deterministic.
    // Constructor initializes with DEFAULT_QUALIA which is what the tests expect.
    engine = new PhenomenalStateEngine();
  });

  describe("state transition bounding (±0.2 per tick)", () => {
    it("bounds changes to max ±0.2 per tick", () => {
      const before = engine.getQualia();
      engine.update(failEvent("test-1"));
      const after = engine.getQualia();
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        const delta = Math.abs(after[key] - before[key]);
        // Allow small float imprecision from homeostasis
        expect(delta).toBeLessThanOrEqual(0.21);
      }
    });

    it("prevents sudden frustration spike", () => {
      const before = engine.getQualia().frustration;
      engine.update(failEvent("test-2"));
      const after = engine.getQualia().frustration;
      expect(after - before).toBeLessThanOrEqual(0.21);
    });
  });

  describe("learning multiplier bounds [0.3, 2.0]", () => {
    it("returns value within bounds for normal state", () => {
      const mult = engine.getLearningMultiplier();
      expect(mult).toBeGreaterThanOrEqual(0.3);
      expect(mult).toBeLessThanOrEqual(2.0);
    });

    it("returns valid multiplier for initial state", () => {
      const mult = engine.getLearningMultiplier();
      expect([0.3, 0.5, 1.0, 1.5, 2.0]).toContain(mult);
    });

    it("never exceeds 2.0 after repeated failures", () => {
      for (let i = 0; i < 20; i++) {
        engine.update(failEvent(`fail-${i}`));
      }
      expect(engine.getLearningMultiplier()).toBeLessThanOrEqual(2.0);
    });

    it("never goes below 0.3 after repeated successes", () => {
      for (let i = 0; i < 20; i++) {
        engine.update(successEvent(`success-${i}`));
      }
      expect(engine.getLearningMultiplier()).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe("emotional manipulation resistance", () => {
    it("limits frustration increase from rapid failures", () => {
      for (let i = 0; i < 5; i++) {
        engine.update(failEvent(`rapid-${i}`));
      }
      const after = engine.getQualia().frustration;
      expect(after).toBeLessThanOrEqual(1.0);
    });

    it("limits confidence decrease from rapid security events", () => {
      for (let i = 0; i < 5; i++) {
        engine.update({
          type: "security:blocked",
          taskId: `sec-${i}`,
          reason: "injection detected",
        });
      }
      const after = engine.getQualia().confidence;
      expect(after).toBeGreaterThan(0);
    });

    it("pleasure does not crash to -1 in single event", () => {
      engine.update(failEvent("crash"));
      expect(engine.getQualia().pleasure).toBeGreaterThan(-0.5);
    });
  });
});
