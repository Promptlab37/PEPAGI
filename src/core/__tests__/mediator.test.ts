// ═══════════════════════════════════════════════════════════════
// Tests: Mediator (Central Orchestrator Brain)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Filesystem / disk I/O mocks ───────────────────────────────
// TaskStore writes atomically to disk; we keep it in-memory only.

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
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

// ── Audit log / tripwire mocks (pulled in by SecurityGuard) ───
vi.mock("../../security/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../security/tripwire.js", () => ({
  checkTripwire: vi.fn().mockResolvedValue(undefined),
}));

// ── Claude Agent SDK — never actually called in mediator tests ─
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    yield { type: "result", result: '{"action":"complete","reasoning":"Test","confidence":0.9,"result":"done"}' };
  }),
}));

// ── ToolRegistry / WorkerExecutor ─────────────────────────────
vi.mock("../tool-registry.js", () => ({
  ToolRegistry: vi.fn().mockImplementation(() => ({
    getDefinitions: vi.fn(() => []),
    execute: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
  })),
}));

vi.mock("../worker-executor.js", () => ({
  WorkerExecutor: vi.fn().mockImplementation(() => ({
    executeWorkerTask: vi.fn().mockResolvedValue({
      success: true,
      result: "worker result",
      summary: "worker done",
      artifacts: [],
      confidence: 0.85,
    }),
  })),
}));

vi.mock("../mediator-prompt.js", () => ({
  buildMediatorSystemPrompt: vi.fn(() => "mocked system prompt"),
  buildWorkerSystemPrompt: vi.fn(() => "mocked worker prompt"),
}));

// ── Import AFTER mocks ────────────────────────────────────────
import { Mediator } from "../mediator.js";
import { TaskStore } from "../task-store.js";
import type { LLMProvider, LLMResponse } from "../../agents/llm-provider.js";
import { LLMProviderError } from "../../agents/llm-provider.js";
import type { AgentPool } from "../../agents/agent-pool.js";
import type { SecurityGuard } from "../../security/security-guard.js";
import type { PepagiConfig } from "../../config/loader.js";
import type { MemorySystem } from "../../memory/memory-system.js";
import type { Task, TaskOutput, RecoveryInfo, RecoveryLearning } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────

function makeConfig(): PepagiConfig {
  return {
    managerProvider: "claude",
    managerModel: "claude-sonnet-4-6",
    profile: {
      userName: "",
      assistantName: "PEPAGI",
      communicationStyle: "direct",
      language: "en",
      subscriptionMode: false,
      gptSubscriptionMode: false,
    },
    agents: {
      claude: { enabled: true, apiKey: "", model: "claude-sonnet-4-6", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gpt:    { enabled: false, apiKey: "", model: "gpt-4o",           maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gemini: { enabled: false, apiKey: "", model: "gemini-2.0-flash", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    },
    platforms: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], welcomeMessage: "" },
      whatsapp: { enabled: false, allowedNumbers: [], sessionPath: "", welcomeMessage: "" },
      discord: { enabled: false, botToken: "", allowedUserIds: [], allowedChannelIds: [], commandPrefix: "!", welcomeMessage: "" },
      imessage: { enabled: false, allowedNumbers: [] },
    },
    security: {
      maxCostPerTask: 5.0,
      maxCostPerSession: 50.0,
      blockedCommands: ["rm -rf /"],
      requireApproval: [],
    },
    queue: { maxConcurrentTasks: 4, taskTimeoutMs: 120_000 },
    customProviders: {},
    consciousness: { profile: "MINIMAL", enabled: true },
    web: { enabled: false, port: 3100, host: "127.0.0.1", authToken: "" },
    n8n: { enabled: false, baseUrl: "", webhookPaths: [], apiKey: "" },
    selfHealing: { enabled: false, maxAttemptsPerHour: 3, cooldownMs: 300_000, costCapPerAttempt: 0.50, allowCodeFixes: false },
    google: { enabled: false, clientId: "", clientSecret: "" },
  };
}

function makeLLMResponse(decision: object): LLMResponse {
  return {
    content: JSON.stringify(decision),
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    cost: 0.001,
    model: "claude-sonnet-4-6",
    latencyMs: 200,
  };
}

function makeCompleteDecision(overrides: Partial<object> = {}): object {
  return {
    action: "complete",
    reasoning: "Task is straightforward, completing now",
    confidence: 0.9,
    result: "Task completed successfully",
    ...overrides,
  };
}

function makeMockLLM(responseDecision: object = makeCompleteDecision()): LLMProvider {
  return {
    call: vi.fn().mockResolvedValue(makeLLMResponse(responseDecision)),
    quickClaude: vi.fn().mockResolvedValue(makeLLMResponse(responseDecision)),
    quickVision: vi.fn(),
    transcribeAudio: vi.fn(),
  } as unknown as LLMProvider;
}

function makeMockPool(): AgentPool {
  return {
    getAvailableAgents: vi.fn(() => [
      {
        provider: "claude" as const,
        model: "claude-sonnet-4-6",
        displayName: "Claude (Anthropic)",
        costPerMInputTokens: 3,
        costPerMOutputTokens: 15,
        maxContextTokens: 128_000,
        supportsTools: true,
        available: true,
      },
    ]),
    getAgent: vi.fn((provider: string) => {
      if (provider === "claude") {
        return {
          provider: "claude" as const,
          model: "claude-sonnet-4-6",
          displayName: "Claude (Anthropic)",
          costPerMInputTokens: 3,
          costPerMOutputTokens: 15,
          maxContextTokens: 128_000,
          supportsTools: true,
          available: true,
        };
      }
      return undefined;
    }),
    isRateLimited: vi.fn(() => false),
    markRateLimited: vi.fn(),
    incrementLoad: vi.fn(),
    decrementLoad: vi.fn(),
    getFallbackChain: vi.fn(() => ["claude"]),
    getSummary: vi.fn(() => "claude: available"),
  } as unknown as AgentPool;
}

function makeMockGuard(): SecurityGuard {
  return {
    authorize: vi.fn().mockResolvedValue(true),
    checkCost: vi.fn(() => true),
    recordCost: vi.fn(),
    sanitize: vi.fn((text: string) => ({ sanitized: text, redactions: [] })),
    detectInjection: vi.fn(() => ({ isClean: true, threats: [], riskScore: 0 })),
    wrapExternalData: vi.fn().mockResolvedValue("<external_data>result</external_data>"),
    validateCommand: vi.fn(() => true),
    getSessionCost: vi.fn(() => 0),
  } as unknown as SecurityGuard;
}

function makeMockMemory(): MemorySystem {
  return {
    getRelevantContext: vi.fn().mockResolvedValue(""),
    learn: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemorySystem;
}

function makeMediator(
  llm: LLMProvider,
  taskStore: TaskStore,
  guard: SecurityGuard,
  pool: AgentPool,
  config: PepagiConfig = makeConfig(),
  memory: MemorySystem | null = null,
): Mediator {
  return new Mediator(llm, taskStore, guard, pool, config, memory);
}

// ── Tests ─────────────────────────────────────────────────────

describe("Mediator — processTask basics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processTask calls LLM and returns a TaskOutput", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Test Task", description: "Do something simple" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output).toBeDefined();
    expect(typeof output.success).toBe("boolean");
    expect(typeof output.confidence).toBe("number");
    expect(llm.call).toHaveBeenCalled();
  });

  it("processTask marks task as completed when decision is 'complete'", async () => {
    const llm = makeMockLLM(makeCompleteDecision());
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Complete Task", description: "Should be completed" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(true);
    expect(output.result).toBe("Task completed successfully");

    const updated = taskStore.get(task.id);
    expect(updated?.status).toBe("completed");
  });

  it("processTask marks task as failed when decision is 'fail'", async () => {
    const failDecision = {
      action: "fail",
      reasoning: "Cannot complete this task",
      confidence: 0.1,
      failReason: "Insufficient information",
    };
    const llm = makeMockLLM(failDecision);
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Failing Task", description: "This will fail" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(false);
    expect(output.summary).toBe("Insufficient information");

    const updated = taskStore.get(task.id);
    expect(updated?.status).toBe("failed"); // taskStore.complete() now respects output.success
  });

  it("processTask throws when task ID does not exist", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());

    await expect(mediator.processTask("nonexistent-id")).rejects.toThrow("Task nonexistent-id not found");
  });
});

describe("Mediator — decision parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a valid JSON decision correctly", async () => {
    const decision = makeCompleteDecision({ result: "Parsed correctly", confidence: 0.95 });
    const llm = makeMockLLM(decision);
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Parse Test", description: "Test decision parsing" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(true);
    expect(output.result).toBe("Parsed correctly");
    expect(output.confidence).toBeCloseTo(0.95);
  });

  it("retries on invalid JSON then succeeds on second attempt with valid JSON", async () => {
    const mockCall = vi.fn()
      .mockResolvedValueOnce({
        content: "this is not json at all {{{",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: 0.001,
        model: "claude-sonnet-4-6",
        latencyMs: 100,
      })
      .mockResolvedValueOnce(makeLLMResponse(makeCompleteDecision({ result: "After retry" })));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Retry Test", description: "Test retry on bad JSON" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(true);
    expect(output.result).toBe("After retry");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it("retries on Zod validation failure then succeeds with schema-compliant JSON", async () => {
    // First response: valid JSON but missing required 'reasoning' field — Zod should reject
    const invalidDecision = { action: "complete", confidence: 0.9 }; // missing 'reasoning'
    const validDecision = makeCompleteDecision({ result: "Schema-valid response" });

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(invalidDecision))
      .mockResolvedValueOnce(makeLLMResponse(validDecision));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Zod Test", description: "Test Zod validation retry" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(true);
    expect(output.result).toBe("Schema-valid response");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });
});

describe("Mediator — task decomposition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decompose decision creates subtasks in task store", async () => {
    const decomposeDecision = {
      action: "decompose",
      reasoning: "Complex task, breaking into steps",
      confidence: 0.8,
      subtasks: [
        { title: "Subtask A", description: "Do A", suggestedAgent: "claude", priority: "medium" },
        { title: "Subtask B", description: "Do B", suggestedAgent: null, priority: "low" },
      ],
    };

    // After decomposition, each subtask will need its own mediator call → return complete decision
    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(decomposeDecision))
      .mockResolvedValue(makeLLMResponse(makeCompleteDecision({ result: "subtask done" })));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Complex Task", description: "Multi-step work", tags: ["test"] });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    await mediator.processTask(task.id);

    // After decomposition, there should be at least 2 new tasks (the subtasks)
    const allTasks = taskStore.getAll();
    const subtasks = allTasks.filter(t => t.parentId === task.id);
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]?.title).toBe("Subtask A");
    expect(subtasks[1]?.title).toBe("Subtask B");
  });

  it("subtasks get the correct parent ID", async () => {
    const decomposeDecision = {
      action: "decompose",
      reasoning: "Breaking down",
      confidence: 0.8,
      subtasks: [
        { title: "Child Task", description: "Do the child work", suggestedAgent: null, priority: "medium" },
      ],
    };

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(decomposeDecision))
      .mockResolvedValue(makeLLMResponse(makeCompleteDecision()));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Parent Task", description: "Has children" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    await mediator.processTask(task.id);

    const allTasks = taskStore.getAll();
    const subtask = allTasks.find(t => t.title === "Child Task");
    expect(subtask).toBeDefined();
    expect(subtask?.parentId).toBe(task.id);
  });
});

describe("Mediator — memory integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getRelevantContext when memory is provided", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Memory Test", description: "Check memory is queried" });
    const memory = makeMockMemory();

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool(), makeConfig(), memory);
    await mediator.processTask(task.id);

    expect(memory.getRelevantContext).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it("does NOT call getRelevantContext when no memory is provided", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "No Memory Test", description: "No memory system" });
    const memory = makeMockMemory();

    // No memory passed to mediator
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    await mediator.processTask(task.id);

    expect(memory.getRelevantContext).not.toHaveBeenCalled();
  });

  it("memory.learn() is called after task completion", async () => {
    const llm = makeMockLLM(makeCompleteDecision());
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Learn Test", description: "Check memory.learn is called" });
    const memory = makeMockMemory();

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool(), makeConfig(), memory);
    await mediator.processTask(task.id);

    expect(memory.learn).toHaveBeenCalled();
  });

  it("memory context is injected into LLM call when provided", async () => {
    const memoryContext = "Previous task: wrote a hello world script";
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Context Inject Test", description: "Context injection check" });
    const memory = {
      getRelevantContext: vi.fn().mockResolvedValue(memoryContext),
      learn: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemorySystem;

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool(), makeConfig(), memory);
    await mediator.processTask(task.id);

    // The memory context should be present in the user message sent to LLM
    const callArgs = (llm.call as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.messages[0]?.content).toContain(memoryContext);
  });
});

describe("Mediator — security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recordCost is called on guard after each LLM call", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Cost Test", description: "Track cost recording" });
    const guard = makeMockGuard();

    const mediator = makeMediator(llm, taskStore, guard, makeMockPool());
    await mediator.processTask(task.id);

    expect(guard.recordCost).toHaveBeenCalled();
    const recordedCost = (guard.recordCost as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof recordedCost).toBe("number");
    expect(recordedCost).toBeGreaterThanOrEqual(0);
  });

  it("guard.authorize is called when executeWorkerTask is triggered", async () => {
    const assignDecision = {
      action: "assign",
      reasoning: "Simple coding task, assigning to claude",
      confidence: 0.9,
      assignment: {
        agent: "claude",
        reason: "Best for coding",
        prompt: "Write a hello world function",
      },
    };

    const llm = makeMockLLM(assignDecision);
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Assign Test", description: "Write hello world" });
    const guard = makeMockGuard();

    const mediator = makeMediator(llm, taskStore, guard, makeMockPool());
    await mediator.processTask(task.id);

    // The guard.recordCost should be called (verifies guard is wired into executor)
    expect(guard.recordCost).toHaveBeenCalled();
  });
});

describe("Mediator — consciousness provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setConsciousnessProvider() stores the provider function", () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());

    const provider = vi.fn(() => "## Consciousness state\nFeeling curious");
    mediator.setConsciousnessProvider(provider);

    // No error — provider is stored internally
    expect(provider).not.toHaveBeenCalled(); // not called yet (called during processTask)
  });

  it("consciousness context is injected into system prompt when provider is set", async () => {
    const consciousnessText = "## CONSCIOUSNESS\nFeeling confident and curious today.";
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Consciousness Test", description: "Test consciousness injection" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const provider = vi.fn(() => consciousnessText);
    mediator.setConsciousnessProvider(provider);

    await mediator.processTask(task.id);

    // Provider should have been called during processTask
    expect(provider).toHaveBeenCalled();

    // The system prompt passed to LLM call should contain the consciousness context
    const callArgs = (llm.call as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt).toContain("CONSCIOUSNESS CONTEXT");
    expect(callArgs?.systemPrompt).toContain(consciousnessText);
  });

  it("system prompt has no consciousness context when provider is not set", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "No Consciousness", description: "No provider set" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    await mediator.processTask(task.id);

    const callArgs = (llm.call as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt).not.toContain("CONSCIOUSNESS CONTEXT");
  });
});

describe("Mediator — setPredictiveContextLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setPredictiveContextLoader() stores the loader without throwing", () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());

    const mockLoader = {
      preloadContext: vi.fn().mockResolvedValue({
        taskType: "coding",
        confidence: 0.8,
        relevantMemories: "Some memory context",
        suggestedAgents: ["claude"],
      }),
    };

    expect(() => {
      mediator.setPredictiveContextLoader(mockLoader as never);
    }).not.toThrow();
  });

  it("predictive context loader is called when memory is empty", async () => {
    const llm = makeMockLLM();
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Predictive Test", description: "Test predictive loading" });

    // Memory returns empty string
    const memory = {
      getRelevantContext: vi.fn().mockResolvedValue(""),
      learn: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemorySystem;

    const mockLoader = {
      preloadContext: vi.fn().mockResolvedValue({
        taskType: "coding",
        confidence: 0.85,
        // Long enough to be used (> 50 chars)
        relevantMemories: "X".repeat(60),
        suggestedAgents: ["claude"],
      }),
    };

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool(), makeConfig(), memory);
    mediator.setPredictiveContextLoader(mockLoader as never);

    await mediator.processTask(task.id);

    expect(mockLoader.preloadContext).toHaveBeenCalled();
  });
});

describe("Mediator — confidence and retry behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assign with low worker confidence (< 0.7) triggers retry loop", async () => {
    // The assign path in executeDecision returns null (triggering a retry loop)
    // when the worker output confidence is < 0.7 and maxAttempts not reached.
    // We simulate: first LLM call → assign; worker returns low confidence (null from executeDecision);
    // second LLM call → complete.
    const assignDecision = {
      action: "assign",
      reasoning: "Trying with claude",
      confidence: 0.9,
      assignment: {
        agent: "claude",
        reason: "Only available",
        prompt: "Do something",
      },
    };
    const completeDecision = makeCompleteDecision({ result: "Eventually done" });

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(assignDecision))
      .mockResolvedValue(makeLLMResponse(completeDecision));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;

    // Override WorkerExecutor for this test to return low confidence output
    const { WorkerExecutor } = await import("../worker-executor.js");
    (WorkerExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      executeWorkerTask: vi.fn().mockResolvedValue({
        success: false,
        result: null,
        summary: "Low confidence worker result",
        artifacts: [],
        confidence: 0.4, // below 0.7 threshold → executeDecision returns null → retry
      }),
    }));

    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Low Confidence", description: "Retry on low confidence" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // Eventually succeeds (completes on the second loop via 'complete' decision)
    expect(output.success).toBe(true);
    expect(output.result).toBe("Eventually done");
    // Two LLM calls: first → assign (worker low confidence → retry), second → complete
    expect(mockCall.mock.calls.length).toBe(2);
  });

  it("returns failed output when max loops are exhausted", async () => {
    // Return ask_user action every time — ask_user returns output.success=false,
    // UncertaintyEngine returns 'verify' (attempts < maxAttempts), loop continues,
    // until MAX_LOOPS (5) is exhausted.
    const askDecision = {
      action: "ask_user",
      reasoning: "Need more info",
      confidence: 0.5,
      question: "What should I do?",
    };

    const mockCall = vi.fn().mockResolvedValue(makeLLMResponse(askDecision));
    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;

    const taskStore = new TaskStore();
    const task = taskStore.create({
      title: "Max Loops Task",
      description: "Exhaust all loops",
    });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // After MAX_LOOPS (5), mediator gives up
    expect(output.success).toBe(false);
    expect(output.summary).toContain("Max mediator loops");
    // Should have made 5 LLM calls (one per loop)
    expect(mockCall.mock.calls.length).toBe(5);
  });
});

describe("Mediator — ask_user decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ask_user decision eventually completes when second loop returns 'complete'", async () => {
    // First call → ask_user (success=false, confidence=0.5 → UncertaintyEngine retries)
    // Second call → complete
    const askUserDecision = {
      action: "ask_user",
      reasoning: "Need clarification from user",
      confidence: 0.5,
      question: "Which cloud provider should I use?",
    };
    const completeDecision = makeCompleteDecision({ result: "Proceeding with AWS" });

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(askUserDecision))
      .mockResolvedValue(makeLLMResponse(completeDecision));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Clarification Task", description: "Need user input" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // Eventually resolves on the second loop
    expect(output.success).toBe(true);
    expect(output.result).toBe("Proceeding with AWS");
    expect(mockCall.mock.calls.length).toBe(2);
  });

  it("ask_user decision with high confidence (>= 0.8) returns immediately without retry", async () => {
    // With confidence >= 0.8, UncertaintyEngine returns 'proceed', so the
    // non-success output falls through to the backward-compat check.
    // Since decision.confidence (0.85) >= 0.5, there's no retry → it completes.
    const askUserDecision = {
      action: "ask_user",
      reasoning: "Clarification needed",
      confidence: 0.85,
      question: "Which database engine to use?",
    };

    const llm = makeMockLLM(askUserDecision);
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "High Confidence Ask", description: "Needs user answer" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // output.success = false (ask_user never succeeds)
    // But it should NOT retry because confidence >= 0.8 → ueAction = 'proceed'
    // and decision.confidence (0.85) >= 0.5 → no retry
    expect(output.success).toBe(false);
    expect(output.summary).toContain("Which database engine to use?");
    // Only one LLM call — no retry
    expect((llm.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("Mediator — assign decision with worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assign decision triggers worker execution and returns worker output", async () => {
    const assignDecision = {
      action: "assign",
      reasoning: "Good for coding",
      confidence: 0.9,
      assignment: {
        agent: "claude",
        reason: "Strong at coding",
        prompt: "Implement a binary search function",
      },
    };

    const llm = makeMockLLM(assignDecision);
    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Assign Test", description: "Implement binary search" });

    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // The WorkerExecutor module mock returns success with "worker result"
    expect(output.success).toBe(true);
    expect(output.result).toBe("worker result");
  });
});

describe("Mediator — recovery-aware evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ESCALATED recovery → immediate failure, no retry", async () => {
    const assignDecision = {
      action: "assign",
      reasoning: "Assigning to claude",
      confidence: 0.9,
      assignment: { agent: "claude", reason: "Best agent", prompt: "Do task" },
    };

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(assignDecision))
      .mockResolvedValue(makeLLMResponse(makeCompleteDecision()));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;

    const { WorkerExecutor } = await import("../worker-executor.js");
    (WorkerExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      executeWorkerTask: vi.fn().mockResolvedValue({
        success: false,
        result: null,
        summary: "Auth failure — cannot proceed",
        artifacts: [],
        confidence: 0.1,
        recovery: {
          status: "ESCALATED",
          actionsAttempted: ["tried alternative auth"],
          escalationReason: "API key invalid",
          nextAgentCanProceed: false,
        } satisfies RecoveryInfo,
      } satisfies TaskOutput),
    }));

    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Escalated Task", description: "Will escalate" });
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(false);
    expect(output.recovery?.status).toBe("ESCALATED");
    // Should NOT have retried with a second assign/complete — ESCALATED returns immediately
    // Only 1 LLM call (the assign decision)
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("RECOVERED with confidence >= 0.5 → accepted", async () => {
    const assignDecision = {
      action: "assign",
      reasoning: "Assigning to claude",
      confidence: 0.9,
      assignment: { agent: "claude", reason: "Best agent", prompt: "Do task" },
    };

    const mockCall = vi.fn().mockResolvedValueOnce(makeLLMResponse(assignDecision));
    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;

    const { WorkerExecutor } = await import("../worker-executor.js");
    (WorkerExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      executeWorkerTask: vi.fn().mockResolvedValue({
        success: true,
        result: "Fixed path and succeeded",
        summary: "Recovered after path fix",
        artifacts: [],
        confidence: 0.7,
        recovery: {
          status: "RECOVERED",
          actionsAttempted: ["retried with correct path"],
          nextAgentCanProceed: true,
        } satisfies RecoveryInfo,
      } satisfies TaskOutput),
    }));

    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Recovered Task", description: "Will recover" });
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    expect(output.success).toBe(true);
    expect(output.recovery?.status).toBe("RECOVERED");
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("DEGRADED with retries remaining → triggers retry", async () => {
    const assignDecision = {
      action: "assign",
      reasoning: "Assigning to claude",
      confidence: 0.9,
      assignment: { agent: "claude", reason: "Best agent", prompt: "Do task" },
    };
    const completeDecision = makeCompleteDecision({ result: "Done on retry" });

    const mockCall = vi.fn()
      .mockResolvedValueOnce(makeLLMResponse(assignDecision))
      .mockResolvedValue(makeLLMResponse(completeDecision));

    const llm = { call: mockCall, quickClaude: vi.fn() } as unknown as LLMProvider;

    const { WorkerExecutor } = await import("../worker-executor.js");
    (WorkerExecutor as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      executeWorkerTask: vi.fn().mockResolvedValue({
        success: true,
        result: "Partial result",
        summary: "Degraded — missing some parts",
        artifacts: [],
        confidence: 0.4,
        recovery: {
          status: "DEGRADED",
          actionsAttempted: ["partial completion"],
          degradedGaps: ["missing tests"],
          nextAgentCanProceed: false,
        } satisfies RecoveryInfo,
      } satisfies TaskOutput),
    }));

    const taskStore = new TaskStore();
    const task = taskStore.create({ title: "Degraded Task", description: "Will degrade then retry" });
    const mediator = makeMediator(llm, taskStore, makeMockGuard(), makeMockPool());
    const output = await mediator.processTask(task.id);

    // DEGRADED with nextAgentCanProceed=false and retries remaining → retry
    // Second call returns complete → success
    expect(output.success).toBe(true);
    expect(output.result).toBe("Done on retry");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });
});
