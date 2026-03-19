// ═══════════════════════════════════════════════════════════════
// Tests: Causal Chain
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CausalChain } from "../causal-chain.js";

// ─── Mock filesystem ─────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("[]"),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// ─── Tests ───────────────────────────────────────────────────

describe("CausalChain.addNode()", () => {
  let chain: CausalChain;

  beforeEach(() => {
    chain = new CausalChain();
  });

  it("creates a node with correct required fields", () => {
    const node = chain.addNode({
      taskId: "task-1",
      action: "decomposed",
      reason: "Task is complex",
    });

    expect(node.taskId).toBe("task-1");
    expect(node.action).toBe("decomposed");
    expect(node.reason).toBe("Task is complex");
    expect(node.outcome).toBe("pending");
    expect(node.parentNodeId).toBeNull();
    expect(typeof node.id).toBe("string");
    expect(node.id.length).toBeGreaterThan(0);
    expect(node.timestamp).toBeInstanceOf(Date);
  });

  it("stores parentNodeId when provided", () => {
    const parent = chain.addNode({ taskId: "task-1", action: "root", reason: "Start" });
    const child = chain.addNode({
      taskId: "task-1",
      action: "assigned_to_claude",
      reason: "Best for coding",
      parentNodeId: parent.id,
    });

    expect(child.parentNodeId).toBe(parent.id);
  });

  it("stores optional counterfactual when provided", () => {
    const node = chain.addNode({
      taskId: "task-1",
      action: "assigned_to_claude",
      reason: "Best fit",
      counterfactual: "Could have used GPT instead",
    });

    expect(node.counterfactual).toBe("Could have used GPT instead");
  });

  it("counterfactual is undefined when not provided", () => {
    const node = chain.addNode({ taskId: "task-1", action: "assigned_to_gpt", reason: "Fallback" });
    expect(node.counterfactual).toBeUndefined();
  });

  it("generates unique IDs for each node", () => {
    const n1 = chain.addNode({ taskId: "task-1", action: "a1", reason: "r1" });
    const n2 = chain.addNode({ taskId: "task-1", action: "a2", reason: "r2" });
    expect(n1.id).not.toBe(n2.id);
  });
});

describe("CausalChain.updateOutcome()", () => {
  let chain: CausalChain;

  beforeEach(() => {
    chain = new CausalChain();
  });

  it("updates a node's outcome to 'success'", () => {
    const node = chain.addNode({ taskId: "task-1", action: "executed", reason: "Running" });
    expect(node.outcome).toBe("pending");

    chain.updateOutcome(node.id, "task-1", "success");

    const updatedChain = chain.getChain("task-1");
    const updated = updatedChain.find(n => n.id === node.id);
    expect(updated?.outcome).toBe("success");
  });

  it("updates a node's outcome to 'failure'", () => {
    const node = chain.addNode({ taskId: "task-2", action: "executed", reason: "Running" });
    chain.updateOutcome(node.id, "task-2", "failure");

    const updatedChain = chain.getChain("task-2");
    const updated = updatedChain.find(n => n.id === node.id);
    expect(updated?.outcome).toBe("failure");
  });

  it("does nothing for an unknown nodeId", () => {
    chain.addNode({ taskId: "task-1", action: "executed", reason: "Running" });
    // Should not throw
    expect(() => chain.updateOutcome("nonexistent-id", "task-1", "success")).not.toThrow();
  });

  it("does nothing when the taskId does not exist", () => {
    expect(() => chain.updateOutcome("any-id", "no-such-task", "success")).not.toThrow();
  });
});

describe("CausalChain.getChain()", () => {
  let chain: CausalChain;

  beforeEach(() => {
    chain = new CausalChain();
  });

  it("returns an empty array for an unknown taskId", () => {
    expect(chain.getChain("does-not-exist")).toEqual([]);
  });

  it("returns only nodes belonging to the specified taskId", () => {
    chain.addNode({ taskId: "task-A", action: "step1", reason: "reason A1" });
    chain.addNode({ taskId: "task-A", action: "step2", reason: "reason A2" });
    chain.addNode({ taskId: "task-B", action: "step1", reason: "reason B1" });

    const chainA = chain.getChain("task-A");
    expect(chainA).toHaveLength(2);
    expect(chainA.every(n => n.taskId === "task-A")).toBe(true);
  });

  it("returns all nodes for a task in insertion order", () => {
    chain.addNode({ taskId: "task-1", action: "first", reason: "r1" });
    chain.addNode({ taskId: "task-1", action: "second", reason: "r2" });
    chain.addNode({ taskId: "task-1", action: "third", reason: "r3" });

    const result = chain.getChain("task-1");
    expect(result).toHaveLength(3);
    expect(result[0]!.action).toBe("first");
    expect(result[1]!.action).toBe("second");
    expect(result[2]!.action).toBe("third");
  });

  it("returns empty array after no nodes were added for that task", () => {
    chain.addNode({ taskId: "task-X", action: "only", reason: "reason" });
    expect(chain.getChain("task-Y")).toEqual([]);
  });
});

describe("CausalChain.persist()", () => {
  it("calls writeFile with the task chain serialized as JSON", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const chain = new CausalChain();
    chain.addNode({ taskId: "task-1", action: "decomposed", reason: "complex task" });

    await chain.persist("task-1");

    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();

    const [, content] = (writeFile as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const parsed = JSON.parse(content as string) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("does not call writeFile when the chain is empty", async () => {
    const { writeFile } = await import("node:fs/promises");
    const writeMock = writeFile as ReturnType<typeof vi.fn>;
    writeMock.mockClear();

    const chain = new CausalChain();
    await chain.persist("task-empty");

    expect(writeMock).not.toHaveBeenCalled();
  });
});
