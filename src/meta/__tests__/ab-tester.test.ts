// ═══════════════════════════════════════════════════════════════
// Tests: A/B Tester
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ABTester } from "../ab-tester.js";
import type { ExperimentResult } from "../ab-tester.js";

// ─── Mock filesystem ─────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  // BUG-01 fix: save() now uses rename for atomic writes
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// ─── Mock logger to suppress output during tests ─────────────

vi.mock("../../core/logger.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ─── Tests ───────────────────────────────────────────────────

// The experimentFrequency constant is 20 (private field in ABTester).
const EXPERIMENT_FREQUENCY = 20;

describe("ABTester.tick()", () => {
  let tester: ABTester;

  beforeEach(() => {
    tester = new ABTester();
  });

  it("returns false for the first call", () => {
    expect(tester.tick()).toBe(false);
  });

  it("returns false for the first N-1 calls", () => {
    for (let i = 1; i < EXPERIMENT_FREQUENCY; i++) {
      expect(tester.tick()).toBe(false);
    }
  });

  it(`returns true at the ${EXPERIMENT_FREQUENCY}th call`, () => {
    for (let i = 1; i < EXPERIMENT_FREQUENCY; i++) {
      tester.tick();
    }
    expect(tester.tick()).toBe(true);
  });

  it("returns false again after the threshold call", () => {
    for (let i = 0; i < EXPERIMENT_FREQUENCY; i++) {
      tester.tick();
    }
    // 21st call should be false
    expect(tester.tick()).toBe(false);
  });

  it(`returns true again at the ${EXPERIMENT_FREQUENCY * 2}th call`, () => {
    for (let i = 0; i < EXPERIMENT_FREQUENCY * 2 - 1; i++) {
      tester.tick();
    }
    expect(tester.tick()).toBe(true);
  });
});

describe("ABTester.createExperiment()", () => {
  let tester: ABTester;

  beforeEach(() => {
    tester = new ABTester();
  });

  it("creates an experiment with correct fields", async () => {
    const exp = await tester.createExperiment({
      name: "Routing experiment",
      hypothesis: "Gemini is faster for short tasks",
      controlStrategy: "Use Claude Sonnet",
      treatmentStrategy: "Use Gemini Flash",
    });

    expect(exp.name).toBe("Routing experiment");
    expect(exp.hypothesis).toBe("Gemini is faster for short tasks");
    expect(exp.controlStrategy).toBe("Use Claude Sonnet");
    expect(exp.treatmentStrategy).toBe("Use Gemini Flash");
    expect(typeof exp.id).toBe("string");
    expect(exp.id.length).toBeGreaterThan(0);
    expect(exp.winner).toBeNull();
    expect(exp.controlResults).toEqual([]);
    expect(exp.treatmentResults).toEqual([]);
    expect(typeof exp.createdAt).toBe("string");
  });

  it("generates unique IDs for different experiments", async () => {
    const e1 = await tester.createExperiment({ name: "e1", hypothesis: "h1", controlStrategy: "c1", treatmentStrategy: "t1" });
    const e2 = await tester.createExperiment({ name: "e2", hypothesis: "h2", controlStrategy: "c2", treatmentStrategy: "t2" });
    expect(e1.id).not.toBe(e2.id);
  });

  it("sets createdAt as a valid ISO date string", async () => {
    const exp = await tester.createExperiment({ name: "test", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });
    expect(() => new Date(exp.createdAt)).not.toThrow();
    expect(new Date(exp.createdAt).getTime()).not.toBeNaN();
  });
});

describe("ABTester.recordResult()", () => {
  let tester: ABTester;

  beforeEach(() => {
    tester = new ABTester();
  });

  const makeResult = (overrides: Partial<ExperimentResult> = {}): ExperimentResult => ({
    success: true,
    cost: 0.01,
    latencyMs: 200,
    confidence: 0.9,
    ...overrides,
  });

  it("adds a result to control results", async () => {
    const exp = await tester.createExperiment({ name: "e1", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });
    await tester.recordResult(exp.id, "control", makeResult());

    const active = await tester.getActive();
    const found = active.find(e => e.id === exp.id);
    expect(found?.controlResults).toHaveLength(1);
    expect(found?.treatmentResults).toHaveLength(0);
  });

  it("adds a result to treatment results", async () => {
    const exp = await tester.createExperiment({ name: "e1", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });
    await tester.recordResult(exp.id, "treatment", makeResult());

    const active = await tester.getActive();
    const found = active.find(e => e.id === exp.id);
    expect(found?.treatmentResults).toHaveLength(1);
    expect(found?.controlResults).toHaveLength(0);
  });

  it("does nothing for an unknown experimentId", async () => {
    await expect(tester.recordResult("nonexistent", "control", makeResult())).resolves.not.toThrow();
  });

  it("concludes the experiment after 5 results per variant", async () => {
    const exp = await tester.createExperiment({ name: "e1", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });

    for (let i = 0; i < 5; i++) {
      await tester.recordResult(exp.id, "control", makeResult({ success: true, confidence: 0.9 }));
      await tester.recordResult(exp.id, "treatment", makeResult({ success: true, confidence: 0.9 }));
    }

    // After 5 per side, the experiment should be concluded (winner set)
    const active = await tester.getActive();
    const stillActive = active.find(e => e.id === exp.id);
    // Experiment with winner is no longer active
    expect(stillActive).toBeUndefined();
  });
});

describe("ABTester.getActive()", () => {
  let tester: ABTester;

  beforeEach(() => {
    tester = new ABTester();
  });

  it("returns empty array when no experiments exist", async () => {
    const active = await tester.getActive();
    expect(active).toEqual([]);
  });

  it("returns active (not yet concluded) experiments", async () => {
    const exp = await tester.createExperiment({ name: "e1", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });

    const active = await tester.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(exp.id);
  });

  it("returns multiple active experiments", async () => {
    await tester.createExperiment({ name: "e1", hypothesis: "h1", controlStrategy: "c1", treatmentStrategy: "t1" });
    await tester.createExperiment({ name: "e2", hypothesis: "h2", controlStrategy: "c2", treatmentStrategy: "t2" });

    const active = await tester.getActive();
    expect(active).toHaveLength(2);
  });

  it("excludes concluded experiments from active list", async () => {
    const makeResult = (): ExperimentResult => ({ success: true, cost: 0.01, latencyMs: 100, confidence: 0.9 });
    const exp = await tester.createExperiment({ name: "e1", hypothesis: "h", controlStrategy: "c", treatmentStrategy: "t" });

    for (let i = 0; i < 5; i++) {
      await tester.recordResult(exp.id, "control", makeResult());
      await tester.recordResult(exp.id, "treatment", makeResult());
    }

    const active = await tester.getActive();
    expect(active.find(e => e.id === exp.id)).toBeUndefined();
  });
});

describe("ABTester.getWinners()", () => {
  it("returns winning strategies for concluded experiments", async () => {
    const tester = new ABTester();
    const makeControlResult = (): ExperimentResult => ({ success: false, cost: 0.05, latencyMs: 500, confidence: 0.3 });
    const makeTreatmentResult = (): ExperimentResult => ({ success: true, cost: 0.01, latencyMs: 100, confidence: 0.95 });

    const exp = await tester.createExperiment({
      name: "Strategy Test",
      hypothesis: "Treatment is better",
      controlStrategy: "slow strategy",
      treatmentStrategy: "fast strategy",
    });

    for (let i = 0; i < 5; i++) {
      await tester.recordResult(exp.id, "control", makeControlResult());
      await tester.recordResult(exp.id, "treatment", makeTreatmentResult());
    }

    const winners = await tester.getWinners();
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const winner = winners.find(w => w.name === "Strategy Test");
    expect(winner).toBeDefined();
    // Treatment should win given significantly better results
    expect(winner?.winner).toBe("treatment");
    expect(winner?.strategy).toBe("fast strategy");
  });

  it("returns empty array when no experiments are concluded", async () => {
    const tester = new ABTester();
    const winners = await tester.getWinners();
    expect(winners).toEqual([]);
  });
});
