// ═══════════════════════════════════════════════════════════════
// Tests: GoalManager
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Filesystem mocks ──────────────────────────────────────────
// vi.mock factories are hoisted before all variable declarations,
// so mock functions must be created inline (no top-level variable refs).

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

// ── Logger mock ───────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// ── EventBus mock ─────────────────────────────────────────────

vi.mock("../event-bus.js", () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// ── Import after all mocks ────────────────────────────────────

import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import { GoalManager } from "../goal-manager.js";
import type { Goal } from "../goal-manager.js";
import type { TaskStore } from "../task-store.js";
import type { Mediator } from "../mediator.js";

// Typed references to the mocked functions (resolved after import)
const mockReadFile  = vi.mocked(fsp.readFile);
const mockWriteFile = vi.mocked(fsp.writeFile);
const mockExistsSync = vi.mocked(fsSync.existsSync);

// ── Helpers ───────────────────────────────────────────────────

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    name: "test-goal",
    description: "A test goal",
    schedule: "every 1h",
    prompt: "Do something useful",
    enabled: true,
    ...overrides,
  };
}

function makeMockTaskStore(): TaskStore {
  return {
    create: vi.fn().mockReturnValue({
      id: "task-123",
      title: "[Goal] test-goal",
      description: "Do something useful",
      status: "pending",
      priority: "low",
    }),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getReady: vi.fn().mockReturnValue([]),
    assign: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    getStats: vi.fn().mockReturnValue({ total: 0, pending: 0, running: 0, completed: 0, failed: 0, totalCost: 0 }),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

function makeMockMediator(): Mediator {
  return {
    processTask: vi.fn().mockResolvedValue({
      success: true,
      result: "Goal completed successfully",
      summary: "Goal ran and produced output",
      artifacts: [],
      confidence: 0.9,
    }),
  } as unknown as Mediator;
}

function makeGoalsJson(goals: Goal[]): string {
  return JSON.stringify(goals);
}

// ── Tests ─────────────────────────────────────────────────────

describe("GoalManager — goal loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("start() calls loadGoals which reads the goals file", async () => {
    const goals = [makeGoal({ enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    expect(mockReadFile).toHaveBeenCalledOnce();

    manager.stop();
  });

  it("goals with enabled=false are not scheduled", async () => {
    const goals = [
      makeGoal({ name: "disabled-goal", enabled: false, schedule: "every 1h" }),
    ];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.enabled).toBe(false);

    manager.stop();
  });

  it("goals with enabled=true are scheduled (appear in listGoals)", async () => {
    const goals = [
      makeGoal({ name: "active-goal", enabled: true, schedule: "every 2h" }),
    ];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("active-goal");
    expect(listed[0]!.enabled).toBe(true);

    manager.stop();
  });

  it("loads multiple goals and only lists enabled ones as enabled", async () => {
    const goals = [
      makeGoal({ name: "goal-a", enabled: true }),
      makeGoal({ name: "goal-b", enabled: false }),
      makeGoal({ name: "goal-c", enabled: true }),
    ];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    expect(listed).toHaveLength(3);
    expect(listed.filter(g => g.enabled)).toHaveLength(2);

    manager.stop();
  });

  it("handles corrupt goals.json gracefully (falls back to empty goals)", async () => {
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue("{ INVALID JSON {{");

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await expect(manager.start()).resolves.not.toThrow();

    const listed = manager.listGoals();
    expect(listed).toHaveLength(0);

    manager.stop();
  });

  it("creates default goals.json when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    // After writeDefaultGoals writes defaults, loadGoals reads back the result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(JSON.stringify([]));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    // writeFile should have been called to write default goals
    expect(mockWriteFile).toHaveBeenCalled();

    manager.stop();
  });
});

describe("GoalManager — goal triggering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggerGoal() creates a task in TaskStore", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();

    const goals = [makeGoal({ name: "startup-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();

    // Flush the startup timer (delay=0)
    await vi.runAllTimersAsync();

    expect(taskStore.create).toHaveBeenCalledWith(expect.objectContaining({
      title: "[Goal] startup-goal",
      description: "Do something useful",
      priority: "low",
    }));

    manager.stop();
  });

  it("triggerGoal() calls mediator.processTask() with the task id", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();

    const goals = [makeGoal({ name: "startup-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();

    await vi.runAllTimersAsync();

    expect(mediator.processTask).toHaveBeenCalledWith("task-123");

    manager.stop();
  });

  it("failed triggerGoal() does not crash the process", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();
    (mediator.processTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM unavailable"));

    const goals = [makeGoal({ name: "failing-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();

    // Should resolve without throwing
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();

    manager.stop();
  });

  it("triggerGoal() updates lastTriggered and triggerCount on the goal", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();

    const goals = [makeGoal({ name: "startup-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();
    await vi.runAllTimersAsync();

    const listed = manager.listGoals();
    expect(listed[0]!.lastTriggered).toBeDefined();
    expect(listed[0]!.triggerCount).toBe(1);

    manager.stop();
  });
});

describe("GoalManager — cron evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goal with 'startup' schedule has nextTriggerMs = 0 (triggers immediately)", async () => {
    const goals = [makeGoal({ name: "startup-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    // "startup" triggers immediately (0ms delay), so nextTriggerMs should be 0
    expect(listed[0]!.nextTriggerMs).toBe(0);

    manager.stop();
  });

  it("goal with 'every 1h' schedule has nextTriggerMs equal to 3,600,000ms", async () => {
    const goals = [makeGoal({ name: "hourly-goal", schedule: "every 1h", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    // "every 1h" is parsed as exactly 3,600,000ms
    expect(listed[0]!.nextTriggerMs).toBe(3_600_000);

    manager.stop();
  });

  it("goal with 'every 30m' schedule has nextTriggerMs equal to 1,800,000ms", async () => {
    const goals = [makeGoal({ name: "half-hour-goal", schedule: "every 30m", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const listed = manager.listGoals();
    expect(listed[0]!.nextTriggerMs).toBe(1_800_000);

    manager.stop();
  });

  it("goal with 'startup' schedule (runOnce) does not reschedule after trigger", async () => {
    vi.useFakeTimers();
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();

    const goals = [makeGoal({ name: "once-goal", schedule: "startup", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();

    await vi.runAllTimersAsync();

    // processTask should have been called exactly once (startup is one-shot)
    expect(mediator.processTask).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    manager.stop();
  });
});

describe("GoalManager — stop()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop() prevents tasks from being created after it is called", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();

    const goals = [makeGoal({ name: "slow-goal", schedule: "every 1h", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(taskStore, mediator);
    await manager.start();

    // Stop before the timer fires
    manager.stop();

    // Advance timers past 1 hour
    await vi.advanceTimersByTimeAsync(3_700_000);

    // No task should have been created
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it("stop() can be called multiple times without throwing", async () => {
    const goals = [makeGoal({ enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    expect(() => {
      manager.stop();
      manager.stop();
    }).not.toThrow();
  });
});

describe("GoalManager — addGoal() / toggleGoal()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("addGoal() saves to file (calls writeFile)", async () => {
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(JSON.stringify([]));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const newGoal = makeGoal({ name: "new-goal", enabled: false });
    await manager.addGoal(newGoal);

    // saveGoals calls writeFile
    expect(mockWriteFile).toHaveBeenCalled();

    manager.stop();
  });

  it("addGoal() makes the goal visible in listGoals()", async () => {
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(JSON.stringify([]));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const newGoal = makeGoal({ name: "brand-new-goal", enabled: false });
    await manager.addGoal(newGoal);

    const listed = manager.listGoals();
    expect(listed.some(g => g.name === "brand-new-goal")).toBe(true);

    manager.stop();
  });

  it("addGoal() replaces an existing goal with the same name (upsert)", async () => {
    const existing = makeGoal({ name: "my-goal", description: "Old description", enabled: false });
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson([existing]));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const updated = makeGoal({ name: "my-goal", description: "Updated description", enabled: true });
    await manager.addGoal(updated);

    const listed = manager.listGoals();
    const found = listed.find(g => g.name === "my-goal");
    expect(found?.description).toBe("Updated description");
    // Must not have duplicates
    expect(listed.filter(g => g.name === "my-goal")).toHaveLength(1);

    manager.stop();
  });

  it("toggleGoal() disables an enabled goal and persists", async () => {
    const goals = [makeGoal({ name: "toggle-me", enabled: true })];
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(makeGoalsJson(goals));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const result = await manager.toggleGoal("toggle-me", false);
    expect(result).toBe(true);

    const listed = manager.listGoals();
    expect(listed.find(g => g.name === "toggle-me")?.enabled).toBe(false);
    expect(mockWriteFile).toHaveBeenCalled();

    manager.stop();
  });

  it("toggleGoal() returns false for a non-existent goal name", async () => {
    mockExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockReadFile as any).mockResolvedValue(JSON.stringify([]));

    const manager = new GoalManager(makeMockTaskStore(), makeMockMediator());
    await manager.start();

    const result = await manager.toggleGoal("does-not-exist", true);
    expect(result).toBe(false);

    manager.stop();
  });
});
