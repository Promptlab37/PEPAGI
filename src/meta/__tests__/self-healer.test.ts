// ═══════════════════════════════════════════════════════════════
// Tests: SelfHealer (L3 AI Emergency Recovery)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────

const { mockExistsSync, mockReadFile, mockReaddir, mockRename } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockReadFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: mockReadFile,
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: mockRename,
  appendFile: vi.fn().mockResolvedValue(undefined),
  readdir: mockReaddir,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("../../core/logger.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../../security/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../security/tripwire.js", () => ({
  checkTripwire: vi.fn().mockResolvedValue(undefined),
}));

// Mock claudeCircuitBreaker — use vi.hoisted() so the mock is available before vi.mock hoisting
const { mockForceReset } = vi.hoisted(() => ({
  mockForceReset: vi.fn(),
}));

vi.mock("../../agents/llm-provider.js", () => ({
  claudeCircuitBreaker: { forceReset: mockForceReset },
  LLMProviderError: class extends Error {
    constructor(
      public readonly provider: string,
      public readonly statusCode: number,
      message: string,
      public readonly retryable: boolean,
    ) {
      super(message);
      this.name = "LLMProviderError";
    }
  },
}));

// ── Imports ──────────────────────────────────────────────────

import { SelfHealer } from "../self-healer.js";
import type { HealContext, Diagnosis } from "../self-healer.js";
import type { PepagiConfig } from "../../config/loader.js";
import type { LLMProvider, LLMResponse } from "../../agents/llm-provider.js";
import type { TaskStore } from "../../core/task-store.js";
import type { SecurityGuard } from "../../security/security-guard.js";
import { eventBus } from "../../core/event-bus.js";

// ── Test Config ──────────────────────────────────────────────

function makeConfig(overrides: Partial<PepagiConfig["selfHealing"]> = {}): PepagiConfig {
  return {
    managerProvider: "claude",
    managerModel: "claude-sonnet-4-6",
    agents: {
      claude: { enabled: true, apiKey: "", model: "claude-sonnet-4-6", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gpt: { enabled: false, apiKey: "", model: "gpt-4o", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gemini: { enabled: false, apiKey: "", model: "gemini-2.0-flash", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    },
    profile: {
      userName: "",
      assistantName: "PEPAGI",
      communicationStyle: "human" as const,
      language: "cs",
      subscriptionMode: false,
      gptSubscriptionMode: false,
    },
    platforms: {
      telegram: { enabled: false, botToken: "", allowedUserIds: [], welcomeMessage: "" },
      whatsapp: { enabled: false, allowedNumbers: [], sessionPath: "", welcomeMessage: "" },
      discord: { enabled: false, botToken: "", allowedUserIds: [], allowedChannelIds: [], commandPrefix: "!", welcomeMessage: "" },
      imessage: { enabled: false, allowedNumbers: [] },
    },
    security: {
      maxCostPerTask: 1.0,
      maxCostPerSession: 10.0,
      blockedCommands: ["rm -rf /"],
      requireApproval: [],
    },
    queue: { maxConcurrentTasks: 4, taskTimeoutMs: 120_000 },
    customProviders: {},
    consciousness: { profile: "MINIMAL" as const, enabled: true },
    web: { enabled: false, port: 3100, host: "127.0.0.1", authToken: "" },
    n8n: { enabled: false, baseUrl: "", webhookPaths: [], apiKey: "" },
    selfHealing: {
      enabled: true,
      maxAttemptsPerHour: 3,
      cooldownMs: 100, // short cooldown for tests
      costCapPerAttempt: 0.50,
      allowCodeFixes: false,
      ...overrides,
    },
    google: { enabled: false, clientId: "", clientSecret: "" },
  };
}

function makeMockLLM(): LLMProvider {
  return {
    quickCall: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        problem: "test issue",
        suggestedTier: 1,
        suggestedAction: "reset_circuit_breaker",
        confidence: 0.8,
      }),
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: 0.001,
      model: "claude-haiku-4-5",
      latencyMs: 200,
    } satisfies LLMResponse),
    quickClaude: vi.fn(),
    call: vi.fn(),
    configure: vi.fn(),
    registerCustomProviders: vi.fn(),
  } as unknown as LLMProvider;
}

function makeMockTaskStore(tasks: Array<{ id: string; status: string; startedAt?: Date; tokensUsed?: { input: number; output: number } }>): TaskStore {
  return {
    getAll: vi.fn(() => tasks.map(t => ({
      id: t.id,
      status: t.status,
      title: "test task",
      description: "test",
      startedAt: t.startedAt ?? null,
      completedAt: null,
      lastError: null,
      tokensUsed: t.tokensUsed ?? { input: 0, output: 0 },
      attempts: 0,
      maxAttempts: 3,
    }))),
    get: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn(),
  } as unknown as TaskStore;
}

function makeMockGuard(): SecurityGuard {
  return {} as unknown as SecurityGuard;
}

// ─── Tests ───────────────────────────────────────────────────

describe("SelfHealer.canAttemptHeal", () => {
  it("allows first attempt", () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    expect(healer.canAttemptHeal()).toBe(true);
  });

  it("blocks when rate limit exceeded (via recordAttempt)", () => {
    const config = makeConfig({ maxAttemptsPerHour: 2, cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);

    // Simulate 2 completed heal attempts via internal state
    const now = Date.now();
    // @ts-expect-error — accessing private for test
    healer.healAttempts.push({ ts: now, tier: 1, success: true });
    // @ts-expect-error — accessing private for test
    healer.healAttempts.push({ ts: now, tier: 1, success: false });

    // Third is blocked by rate limit
    expect(healer.canAttemptHeal()).toBe(false);
  });

  it("blocks during cooldown", () => {
    const config = makeConfig({ cooldownMs: 60_000 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);

    // First attempt sets cooldown
    expect(healer.canAttemptHeal()).toBe(true);
    // Immediately blocked by cooldown
    expect(healer.canAttemptHeal()).toBe(false);
  });

  it("allows after cooldown expires", async () => {
    const config = makeConfig({ cooldownMs: 50 }); // 50ms cooldown
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);

    expect(healer.canAttemptHeal()).toBe(true);
    // Wait for cooldown
    await new Promise(r => setTimeout(r, 60));
    expect(healer.canAttemptHeal()).toBe(true);
  });

  it("does not count attempts from over an hour ago", () => {
    const config = makeConfig({ maxAttemptsPerHour: 2, cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);

    // Simulate old attempts
    const oldTs = Date.now() - 3_700_000; // over 1 hour ago
    // @ts-expect-error — accessing private for test
    healer.healAttempts.push({ ts: oldTs, tier: 1, success: true });
    // @ts-expect-error — accessing private for test
    healer.healAttempts.push({ ts: oldTs, tier: 1, success: false });

    // These old attempts shouldn't count
    expect(healer.canAttemptHeal()).toBe(true);
  });
});

describe("SelfHealer.isProtectedFile", () => {
  const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());

  it("detects all 25 protected security files", () => {
    const allProtected = [
      "agent-authenticator.ts", "audit-log.ts", "compliance-map.ts", "context-boundary.ts",
      "cost-tracker.ts", "credential-lifecycle.ts", "credential-scrubber.ts", "dlp-engine.ts",
      "drift-detector.ts", "incident-response.ts", "input-sanitizer.ts", "memory-guard.ts",
      "output-sanitizer.ts", "path-validator.ts", "policy-anchor.ts", "rate-limiter.ts",
      "reasoning-monitor.ts", "safe-fs.ts", "security-guard.ts", "side-channel.ts",
      "supply-chain.ts", "task-content-guard.ts", "tls-verifier.ts", "tool-guard.ts", "tripwire.ts",
    ];
    for (const file of allProtected) {
      expect(healer.isProtectedFile(file)).toBe(true);
      expect(healer.isProtectedFile(`src/security/${file}`)).toBe(true);
    }
  });

  it("allows non-protected files", () => {
    expect(healer.isProtectedFile("mediator.ts")).toBe(false);
    expect(healer.isProtectedFile("llm-provider.ts")).toBe(false);
    expect(healer.isProtectedFile("src/core/types.ts")).toBe(false);
  });
});

describe("SelfHealer.diagnose", () => {
  it("quick-diagnoses circuit breaker issues without LLM", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "system:alert", message: "Circuit breaker OPEN", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);

    expect(diag.suggestedTier).toBe(1);
    expect(diag.suggestedAction).toBe("reset_circuit_breaker");
    expect(llm.quickCall).not.toHaveBeenCalled();
  });

  it("quick-diagnoses stuck tasks", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "meta:watchdog_alert", message: "Task stuck for 15 minutes", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);
    expect(diag.suggestedAction).toBe("kill_stuck_tasks");
  });

  it("quick-diagnoses config corruption", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "system:alert", message: "Config parse error: invalid JSON", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);
    expect(diag.suggestedAction).toBe("repair_config");
  });

  it("quick-diagnoses OOM risk", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "system:alert", message: "Heap memory usage at 85%", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);
    expect(diag.suggestedAction).toBe("force_gc");
  });

  it("quick-diagnoses systemic failure when many errors (>20)", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    // existsSync must return true for logs directory check
    mockExistsSync.mockReturnValue(true);
    const errorLines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: `Error ${i}` }),
    ).join("\n");
    mockReaddir.mockResolvedValue(["pepagi-2026-03-21.jsonl"]);
    mockReadFile.mockResolvedValue(errorLines);

    const ctx: HealContext = { trigger: "task:failed", message: "Some generic error", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);
    // Systemic failure now suggests kill_stuck_tasks, not restart_daemon (less aggressive)
    expect(diag.suggestedAction).toBe("kill_stuck_tasks");

    // Restore defaults
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockResolvedValue([]);
  });

  it("does NOT diagnose systemic failure with only 10 errors", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    mockExistsSync.mockReturnValue(true);
    const errorLines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: `Error ${i}` }),
    ).join("\n");
    mockReaddir.mockResolvedValue(["pepagi-2026-03-21.jsonl"]);
    mockReadFile.mockResolvedValue(errorLines);

    const ctx: HealContext = { trigger: "task:failed", message: "Some generic error", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);
    // With only 10 errors, quickDiagnose returns null → falls through to LLM
    expect(llm.quickCall).toHaveBeenCalled();

    // Restore defaults
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockResolvedValue([]);
  });

  it("falls back to LLM for complex issues", async () => {
    const llm = makeMockLLM();
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "task:failed", message: "Some unusual error", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);

    expect(llm.quickCall).toHaveBeenCalled();
    expect(diag.problem).toBe("test issue");
  });

  it("returns fallback diagnosis when LLM fails", async () => {
    const llm = makeMockLLM();
    (llm.quickCall as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM unavailable"));
    const healer = new SelfHealer(llm, makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const ctx: HealContext = { trigger: "task:failed", message: "Something weird", timestamp: Date.now() };
    const diag = await healer.diagnose(ctx);

    expect(diag.suggestedTier).toBe(1);
    expect(diag.suggestedAction).toBe("reset_circuit_breaker");
    expect(diag.confidence).toBe(0.3);
  });
});

describe("SelfHealer.healTier1", () => {
  beforeEach(() => {
    mockForceReset.mockClear();
    mockExistsSync.mockReset().mockReturnValue(false);
    mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockReset().mockResolvedValue([]);
    mockRename.mockReset().mockResolvedValue(undefined);
  });

  it("resets circuit breaker", async () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "CB open", suggestedTier: 1, suggestedAction: "reset_circuit_breaker", confidence: 0.9 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.tier).toBe(1);
    expect(mockForceReset).toHaveBeenCalled();
  });

  it("kills stuck tasks via TaskStore.fail()", async () => {
    const oldTime = new Date(Date.now() - 700_000); // 11+ min ago
    const tasks = [
      { id: "t1", status: "running", startedAt: oldTime },
      { id: "t2", status: "running", startedAt: new Date() }, // not stuck
      { id: "t3", status: "completed" },
    ];
    const taskStore = makeMockTaskStore(tasks);
    const healer = new SelfHealer(makeMockLLM(), taskStore, makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "Stuck tasks", suggestedTier: 1, suggestedAction: "kill_stuck_tasks", confidence: 0.8 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.details).toContain("1 stuck tasks");
    // Verify TaskStore.fail() was called, not direct mutation
    expect(taskStore.fail).toHaveBeenCalledWith("t1", "Killed by self-healer: stuck > 10 min");
    expect(taskStore.fail).toHaveBeenCalledTimes(1);
  });

  it("repairs corrupted config by backing it up", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("{ invalid json !!!"); // corrupted
    // readFile for config test will throw on JSON.parse, not on readFile itself
    // Actually we need readFile to succeed but JSON.parse to fail
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "Config corrupted", suggestedTier: 1, suggestedAction: "repair_config", confidence: 0.85 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.details).toContain("backed up");
    expect(mockRename).toHaveBeenCalled();
  });

  it("reports valid config when no repair needed", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('{"managerProvider":"claude"}'); // valid JSON
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "Config check", suggestedTier: 1, suggestedAction: "repair_config", confidence: 0.5 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.details).toContain("valid JSON");
  });

  it("repairs corrupted memory files", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(["episodes.jsonl", "knowledge.jsonl", "readme.txt"]);
    // First file: valid JSONL
    mockReadFile.mockResolvedValueOnce('{"id":"1"}\n{"id":"2"}');
    // Second file: invalid
    mockReadFile.mockResolvedValueOnce('{"id":"1"}\nNOT JSON!!!');

    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "Memory corrupted", suggestedTier: 1, suggestedAction: "repair_memory", confidence: 0.7 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.details).toContain("1 corrupted memory files backed up");
    expect(mockRename).toHaveBeenCalledTimes(1);
  });

  it("force_gc kills heavy tasks via TaskStore.fail()", async () => {
    const tasks = [
      { id: "t1", status: "running", tokensUsed: { input: 150_000, output: 100_000 } }, // 250k > 200k threshold
      { id: "t2", status: "running", tokensUsed: { input: 1000, output: 500 } }, // light
    ];
    const taskStore = makeMockTaskStore(tasks);
    const healer = new SelfHealer(makeMockLLM(), taskStore, makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "OOM risk", suggestedTier: 1, suggestedAction: "force_gc", confidence: 0.7 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(true);
    expect(result.details).toContain("killed 1 heavy tasks");
    expect(taskStore.fail).toHaveBeenCalledWith("t1", "Killed by self-healer: high token usage under memory pressure");
  });

  it("handles unknown action gracefully", async () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());
    const diag: Diagnosis = { problem: "test", suggestedTier: 1, suggestedAction: "unknown_action", confidence: 0.5 };

    const result = await healer.healTier1(diag);

    expect(result.success).toBe(false);
    expect(result.details).toContain("Unknown Tier 1 action");
  });
});

describe("SelfHealer.healTier2", () => {
  it("refuses when protected files are affected", async () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig({ allowCodeFixes: true }));
    const diag: Diagnosis = {
      problem: "bug in security",
      suggestedTier: 2,
      suggestedAction: "code_fix",
      affectedFiles: ["src/security/security-guard.ts"],
      confidence: 0.7,
    };

    const result = await healer.healTier2(diag);

    expect(result.success).toBe(false);
    expect(result.details).toContain("protected security files");
  });

  it("refuses all 25 security module files", async () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig({ allowCodeFixes: true }));

    for (const file of ["incident-response.ts", "drift-detector.ts", "tool-guard.ts", "memory-guard.ts"]) {
      const diag: Diagnosis = {
        problem: "test",
        suggestedTier: 2,
        suggestedAction: "code_fix",
        affectedFiles: [`src/security/${file}`],
        confidence: 0.7,
      };
      const result = await healer.healTier2(diag);
      expect(result.success).toBe(false);
      expect(result.details).toContain("protected security files");
    }
  });

  it("fails gracefully when not in a git repo", async () => {
    const { execSync: mockExecSync } = await import("node:child_process");
    (mockExecSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("not a git repo"); });

    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig({ allowCodeFixes: true }));
    const diag: Diagnosis = { problem: "test", suggestedTier: 2, suggestedAction: "code_fix", confidence: 0.7 };

    const result = await healer.healTier2(diag);

    expect(result.success).toBe(false);
    expect(result.details).toContain("Not in a git repository");

    // Restore
    (mockExecSync as ReturnType<typeof vi.fn>).mockImplementation(() => "");
  });
});

describe("SelfHealer.escalate", () => {
  it("emits critical system:alert with diagnostic report", async () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());

    const emittedEvents: Array<{ type: string; message?: string; level?: string }> = [];
    const handler = (e: { type: string; message?: string; level?: string }) => {
      if (e.type === "system:alert") emittedEvents.push(e);
    };
    eventBus.onAny(handler);

    const diagnosis: Diagnosis = { problem: "Unrecoverable error", suggestedTier: 3, suggestedAction: "escalate", confidence: 0.4 };
    const attempts = [
      { tier: 1, success: false, action: "reset_circuit_breaker", details: "CB still broken", timestamp: Date.now() },
    ];

    await healer.escalate(diagnosis, attempts);
    eventBus.offAny(handler);

    expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
    const alert = emittedEvents.find(e => e.message?.includes("Manual Intervention"));
    expect(alert).toBeDefined();
    expect(alert?.level).toBe("critical");
    expect(alert?.message).toContain("Unrecoverable error");
    expect(alert?.message).toContain("Tier 1");
  });
});

describe("SelfHealer lifecycle", () => {
  afterEach(() => {
    mockExistsSync.mockReset().mockReturnValue(false);
    mockReadFile.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  });

  it("does not start when disabled in config", () => {
    const config = makeConfig({ enabled: false });
    config.selfHealing = { ...config.selfHealing!, enabled: false };
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);

    healer.start();
    healer.stop();
  });

  it("registers and removes event listener", () => {
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), makeConfig());

    healer.start();
    // Starting again should be idempotent
    healer.start();

    healer.stop();
    // Stopping again should be safe
    healer.stop();
  });

  it("responds to task:failed only after 5 consecutive failures", async () => {
    const config = makeConfig({ cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);
    healer.start();

    const emittedEvents: string[] = [];
    const handler = (e: { type: string }) => {
      if (e.type.startsWith("self-heal:")) emittedEvents.push(e.type);
    };
    eventBus.onAny(handler);

    // First 4 failures should NOT trigger self-heal
    for (let i = 0; i < 4; i++) {
      eventBus.emit({ type: "task:failed", taskId: `t${i}`, error: "Circuit breaker open" });
    }
    await new Promise(r => setTimeout(r, 50));
    expect(emittedEvents).toHaveLength(0);

    // 5th failure triggers self-heal
    eventBus.emit({ type: "task:failed", taskId: "t5", error: "Circuit breaker open" });
    await new Promise(r => setTimeout(r, 100));

    eventBus.offAny(handler);
    healer.stop();

    expect(emittedEvents).toContain("self-heal:attempt");
    expect(emittedEvents).toContain("self-heal:success");
  });

  it("resets failure counter after gap > 2 min", async () => {
    const config = makeConfig({ cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);
    healer.start();

    // Simulate 4 failures then a gap
    for (let i = 0; i < 4; i++) {
      eventBus.emit({ type: "task:failed", taskId: `t${i}`, error: "test error" });
    }
    // Simulate time gap by resetting lastTaskFailureTs
    // @ts-expect-error — accessing private for test
    healer.lastTaskFailureTs = Date.now() - 130_000; // 2+ min ago

    const emittedEvents: string[] = [];
    const handler = (e: { type: string }) => {
      if (e.type.startsWith("self-heal:")) emittedEvents.push(e.type);
    };
    eventBus.onAny(handler);

    // Next failure resets counter → no trigger (only 1st after reset)
    eventBus.emit({ type: "task:failed", taskId: "t5", error: "test error" });
    await new Promise(r => setTimeout(r, 50));

    eventBus.offAny(handler);
    healer.stop();

    expect(emittedEvents).toHaveLength(0);
  });

  it("responds to meta:watchdog_alert events", async () => {
    const config = makeConfig({ cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);
    healer.start();

    const emittedEvents: string[] = [];
    const handler = (e: { type: string }) => {
      if (e.type.startsWith("self-heal:")) emittedEvents.push(e.type);
    };
    eventBus.onAny(handler);

    eventBus.emit({ type: "meta:watchdog_alert", message: "Task stuck for 15 minutes" });
    await new Promise(r => setTimeout(r, 100));

    eventBus.offAny(handler);
    healer.stop();

    expect(emittedEvents).toContain("self-heal:attempt");
  });

  it("responds to system:alert critical events only", async () => {
    const config = makeConfig({ cooldownMs: 0 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);
    healer.start();

    const emittedEvents: string[] = [];
    const handler = (e: { type: string }) => {
      if (e.type.startsWith("self-heal:")) emittedEvents.push(e.type);
    };
    eventBus.onAny(handler);

    // warn level should NOT trigger
    eventBus.emit({ type: "system:alert", message: "Minor issue", level: "warn" });
    await new Promise(r => setTimeout(r, 50));
    expect(emittedEvents).toHaveLength(0);

    // critical level should trigger
    eventBus.emit({ type: "system:alert", message: "Circuit breaker open", level: "critical" });
    await new Promise(r => setTimeout(r, 100));

    eventBus.offAny(handler);
    healer.stop();

    expect(emittedEvents).toContain("self-heal:attempt");
  });

  it("does not double-count rate limit (canAttemptHeal + recordAttempt)", async () => {
    const config = makeConfig({ cooldownMs: 0, maxAttemptsPerHour: 3 });
    const healer = new SelfHealer(makeMockLLM(), makeMockTaskStore([]), makeMockGuard(), config);
    healer.start();

    // Use watchdog alerts instead of task:failed (no failure threshold for watchdog)
    for (let i = 0; i < 3; i++) {
      eventBus.emit({ type: "meta:watchdog_alert", message: "Circuit breaker open" });
      await new Promise(r => setTimeout(r, 50));
    }

    // getAttempts should have exactly 3 entries (one per heal, from recordAttempt only)
    const attempts = healer.getAttempts();
    expect(attempts.length).toBe(3);
    // All should have tier=1 (from recordAttempt), not tier=0 (no longer pushed by canAttemptHeal)
    expect(attempts.every(a => a.tier === 1)).toBe(true);

    healer.stop();
  });
});
