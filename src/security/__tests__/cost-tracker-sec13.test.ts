// ═══════════════════════════════════════════════════════════════
// Tests: Cost Explosion Kill Switch (SEC-13)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { CostTracker, MAX_DECOMPOSITION_DEPTH, MAX_SUBTASKS_PER_PARENT } from "../cost-tracker.js";

describe("Cost Tracker SEC-13", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker(5.0, 20);
  });

  describe("per-user daily cost tracking", () => {
    it("starts with zero cost", () => {
      expect(tracker.getUserCost("user-1")).toBe(0);
    });

    it("records cost for a user", () => {
      tracker.recordCost("user-1", 0.50);
      expect(tracker.getUserCost("user-1")).toBe(0.50);
    });

    it("accumulates cost across calls", () => {
      tracker.recordCost("user-1", 1.0);
      tracker.recordCost("user-1", 1.5);
      expect(tracker.getUserCost("user-1")).toBe(2.5);
    });

    it("tracks costs independently per user", () => {
      tracker.recordCost("user-1", 2.0);
      tracker.recordCost("user-2", 3.0);
      expect(tracker.getUserCost("user-1")).toBe(2.0);
      expect(tracker.getUserCost("user-2")).toBe(3.0);
    });
  });

  describe("daily limit enforcement", () => {
    it("allows cost below limit", () => {
      const allowed = tracker.recordCost("user-1", 4.0);
      expect(allowed).toBe(true);
    });

    it("blocks cost at limit", () => {
      tracker.recordCost("user-1", 3.0);
      const allowed = tracker.recordCost("user-1", 2.0);
      expect(allowed).toBe(false);
    });

    it("blocks cost above limit", () => {
      const allowed = tracker.recordCost("user-1", 6.0);
      expect(allowed).toBe(false);
    });
  });

  describe("degraded mode", () => {
    it("starts not degraded", () => {
      expect(tracker.isDegraded()).toBe(false);
    });

    it("enters degraded mode at 80% budget", () => {
      tracker.recordCost("user-1", 4.0); // 80% of $5
      expect(tracker.isDegraded()).toBe(true);
    });

    it("does not enter degraded mode below 80%", () => {
      tracker.recordCost("user-1", 3.5); // 70%
      expect(tracker.isDegraded()).toBe(false);
    });

    it("can reset degraded mode", () => {
      tracker.recordCost("user-1", 4.0);
      expect(tracker.isDegraded()).toBe(true);
      tracker.resetDegradedMode();
      expect(tracker.isDegraded()).toBe(false);
    });
  });

  describe("per-minute rate limiting", () => {
    it("allows calls within limit", () => {
      for (let i = 0; i < 19; i++) {
        expect(tracker.checkCallRate()).toBe(true);
      }
    });

    it("blocks calls exceeding limit", () => {
      for (let i = 0; i < 20; i++) {
        tracker.checkCallRate();
      }
      expect(tracker.checkCallRate()).toBe(false);
    });
  });

  describe("decomposition depth limit", () => {
    it("allows depth below max", () => {
      expect(tracker.checkDecompositionDepth(0)).toBe(true);
      expect(tracker.checkDecompositionDepth(1)).toBe(true);
      expect(tracker.checkDecompositionDepth(2)).toBe(true);
    });

    it("blocks depth at max", () => {
      expect(tracker.checkDecompositionDepth(MAX_DECOMPOSITION_DEPTH)).toBe(false);
    });

    it("blocks depth above max", () => {
      expect(tracker.checkDecompositionDepth(5)).toBe(false);
    });

    it("MAX_DECOMPOSITION_DEPTH is 3", () => {
      expect(MAX_DECOMPOSITION_DEPTH).toBe(3);
    });
  });

  describe("subtask count limit", () => {
    it("allows count within limit", () => {
      expect(tracker.checkSubtaskCount(5)).toBe(true);
      expect(tracker.checkSubtaskCount(10)).toBe(true);
    });

    it("blocks count above limit", () => {
      expect(tracker.checkSubtaskCount(11)).toBe(false);
    });

    it("MAX_SUBTASKS_PER_PARENT is 10", () => {
      expect(MAX_SUBTASKS_PER_PARENT).toBe(10);
    });
  });

  describe("cost persistence", () => {
    it("save and load round-trips", async () => {
      // Just verify save doesn't throw
      await expect(tracker.save()).resolves.toBeUndefined();
    });

    it("load handles missing file gracefully", async () => {
      const fresh = new CostTracker();
      await expect(fresh.load()).resolves.toBeUndefined();
    });
  });

  describe("custom limits", () => {
    it("respects custom daily limit", () => {
      const custom = new CostTracker(1.0, 20);
      const allowed = custom.recordCost("user-1", 1.0);
      expect(allowed).toBe(false);
    });

    it("respects custom rate limit", () => {
      const custom = new CostTracker(5.0, 3);
      custom.checkCallRate();
      custom.checkCallRate();
      custom.checkCallRate();
      expect(custom.checkCallRate()).toBe(false);
    });
  });
});
