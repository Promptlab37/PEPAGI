// ═══════════════════════════════════════════════════════════════
// Tests: Uncertainty Engine
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { UncertaintyEngine } from "../uncertainty-engine.js";
import type { Task, TaskOutput } from "../../core/types.js";
import type { TaskStore } from "../../core/task-store.js";

// ─── Minimal TaskStore mock ───────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  const base: Task = {
    id: overrides.id,
    parentId: null,
    title: "Test Task",
    description: "A test task",
    status: "pending",
    priority: "medium",
    difficulty: "simple",
    assignedTo: null,
    assignmentReason: null,
    input: {},
    output: null,
    subtaskIds: [],
    dependsOn: [],
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    tokensUsed: { input: 0, output: 0 },
    estimatedCost: 0,
    confidence: 0.9,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    tags: [],
  };
  return { ...base, ...overrides };
}

function makeTaskStore(tasks: Task[]): TaskStore {
  const map = new Map<string, Task>(tasks.map(t => [t.id, t]));
  return {
    get: (id: string) => map.get(id),
  } as unknown as TaskStore;
}

// ─── Tests ───────────────────────────────────────────────────

describe("UncertaintyEngine.getTaskConfidence()", () => {
  it("returns 0 for an unknown taskId", () => {
    const store = makeTaskStore([]);
    const engine = new UncertaintyEngine(store);
    expect(engine.getTaskConfidence("does-not-exist")).toBe(0);
  });

  it("returns the task's own confidence when it has no subtasks", () => {
    const task = makeTask({ id: "t1", confidence: 0.85, subtaskIds: [] });
    const store = makeTaskStore([task]);
    const engine = new UncertaintyEngine(store);
    expect(engine.getTaskConfidence("t1")).toBe(0.85);
  });

  it("returns 0 for a leaf task with confidence 0", () => {
    const task = makeTask({ id: "t1", confidence: 0, subtaskIds: [] });
    const store = makeTaskStore([task]);
    const engine = new UncertaintyEngine(store);
    expect(engine.getTaskConfidence("t1")).toBe(0);
  });

  it("propagates confidence from subtasks: min(subtask confidences) × 0.9", () => {
    const child1 = makeTask({ id: "c1", confidence: 0.8, subtaskIds: [] });
    const child2 = makeTask({ id: "c2", confidence: 0.6, subtaskIds: [] });
    const parent = makeTask({ id: "p1", confidence: 1.0, subtaskIds: ["c1", "c2"] });
    const store = makeTaskStore([parent, child1, child2]);
    const engine = new UncertaintyEngine(store);

    // min(0.8, 0.6) × 0.9 = 0.54, which is less than parent confidence 1.0
    expect(engine.getTaskConfidence("p1")).toBeCloseTo(0.54);
  });

  it("propagates confidence and caps at parent's own confidence when parent is lower", () => {
    const child1 = makeTask({ id: "c1", confidence: 0.9, subtaskIds: [] });
    const child2 = makeTask({ id: "c2", confidence: 0.95, subtaskIds: [] });
    const parent = makeTask({ id: "p1", confidence: 0.5, subtaskIds: ["c1", "c2"] });
    const store = makeTaskStore([parent, child1, child2]);
    const engine = new UncertaintyEngine(store);

    // min(0.9, 0.95) × 0.9 = 0.81, but parent.confidence = 0.5, so result = 0.5
    expect(engine.getTaskConfidence("p1")).toBeCloseTo(0.5);
  });

  it("ignores subtasks with zero confidence when computing propagated value", () => {
    // child with confidence=0 is filtered out; only non-zero used
    const child1 = makeTask({ id: "c1", confidence: 0.7, subtaskIds: [] });
    const child2 = makeTask({ id: "c2", confidence: 0, subtaskIds: [] }); // filtered
    const parent = makeTask({ id: "p1", confidence: 1.0, subtaskIds: ["c1", "c2"] });
    const store = makeTaskStore([parent, child1, child2]);
    const engine = new UncertaintyEngine(store);

    // Only c1 survives the filter: min([0.7]) × 0.9 = 0.63
    expect(engine.getTaskConfidence("p1")).toBeCloseTo(0.63);
  });

  it("falls back to task's own confidence when all subtasks have zero confidence", () => {
    const child1 = makeTask({ id: "c1", confidence: 0, subtaskIds: [] });
    const parent = makeTask({ id: "p1", confidence: 0.55, subtaskIds: ["c1"] });
    const store = makeTaskStore([parent, child1]);
    const engine = new UncertaintyEngine(store);

    // subtaskConfidences after filter is empty → falls back to task.confidence = 0.55
    expect(engine.getTaskConfidence("p1")).toBe(0.55);
  });

  it("handles nested subtask trees recursively", () => {
    // grandchild → child → parent
    const grandchild = makeTask({ id: "gc1", confidence: 0.8, subtaskIds: [] });
    const child = makeTask({ id: "c1", confidence: 1.0, subtaskIds: ["gc1"] });
    const parent = makeTask({ id: "p1", confidence: 1.0, subtaskIds: ["c1"] });
    const store = makeTaskStore([parent, child, grandchild]);
    const engine = new UncertaintyEngine(store);

    // child confidence = min([0.8]) × 0.9 = 0.72 (propagated from grandchild)
    // parent confidence = min([0.72]) × 0.9 = 0.648
    expect(engine.getTaskConfidence("p1")).toBeCloseTo(0.648);
  });
});

describe("UncertaintyEngine.recommendAction()", () => {
  let engine: UncertaintyEngine;

  beforeEach(() => {
    const store = makeTaskStore([]);
    engine = new UncertaintyEngine(store);
  });

  it("returns 'proceed' when confidence >= 0.8", () => {
    expect(engine.recommendAction(0.8, 0, 3)).toBe("proceed");
    expect(engine.recommendAction(0.95, 1, 3)).toBe("proceed");
    expect(engine.recommendAction(1.0, 2, 3)).toBe("proceed");
  });

  it("returns 'verify' when confidence is between 0.6 and 0.8 (exclusive)", () => {
    expect(engine.recommendAction(0.6, 0, 3)).toBe("verify");
    expect(engine.recommendAction(0.7, 1, 3)).toBe("verify");
    expect(engine.recommendAction(0.79, 0, 3)).toBe("verify");
  });

  it("returns 'verify' when confidence < 0.6 but attempts remain", () => {
    expect(engine.recommendAction(0.5, 0, 3)).toBe("verify");
    expect(engine.recommendAction(0.4, 1, 3)).toBe("verify");
  });

  it("returns 'ask_user' when confidence is 0.3–0.59 and max attempts exhausted", () => {
    expect(engine.recommendAction(0.5, 3, 3)).toBe("ask_user");
    expect(engine.recommendAction(0.3, 3, 3)).toBe("ask_user");
  });

  it("returns 'abort' when confidence < 0.3 and max attempts exhausted", () => {
    expect(engine.recommendAction(0.29, 3, 3)).toBe("abort");
    expect(engine.recommendAction(0.0, 3, 3)).toBe("abort");
  });
});

describe("UncertaintyEngine.propagateUp()", () => {
  it("applies propagation decay to output confidence", () => {
    const store = makeTaskStore([]);
    const engine = new UncertaintyEngine(store);
    const output: TaskOutput = { success: true, result: null, summary: "", artifacts: [], confidence: 0.8 };
    const parent = makeTask({ id: "p1", confidence: 0.9 });
    expect(engine.propagateUp(output, parent)).toBeCloseTo(0.72); // 0.8 × 0.9
  });
});

describe("UncertaintyEngine.combineConfidences()", () => {
  it("returns 0 for empty array", () => {
    const store = makeTaskStore([]);
    const engine = new UncertaintyEngine(store);
    expect(engine.combineConfidences([])).toBe(0);
  });

  it("returns the single value directly for one element", () => {
    const store = makeTaskStore([]);
    const engine = new UncertaintyEngine(store);
    expect(engine.combineConfidences([0.7])).toBe(0.7);
  });

  it("returns harmonic mean × decay for multiple values", () => {
    const store = makeTaskStore([]);
    const engine = new UncertaintyEngine(store);
    // harmonic mean of [0.8, 0.8] = 0.8, × 0.9 = 0.72
    expect(engine.combineConfidences([0.8, 0.8])).toBeCloseTo(0.72);
  });
});
