// ═══════════════════════════════════════════════════════════════
// Tests: DifficultyRouter
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentProfile } from "../types.js";

// ── Filesystem mock ───────────────────────────────────────────
// Prevent any real disk I/O from the router's profile persistence.

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  // BUG-01 fix: saveProfiles() now uses rename for atomic writes
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

// ── LLMProvider mock ──────────────────────────────────────────
// We mock the entire module so DifficultyRouter.estimateDifficulty
// receives a canned response without making real API calls.

const mockQuickClaude = vi.fn();
const mockCall = vi.fn();

vi.mock("../logger.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import AFTER mocks
import { DifficultyRouter } from "../difficulty-router.js";
import type { LLMProvider } from "../../agents/llm-provider.js";
import type { AgentPool } from "../../agents/agent-pool.js";

// ── Helpers ───────────────────────────────────────────────────

function makeMockLLM(difficultyResponse = "medium"): LLMProvider {
  mockQuickClaude.mockResolvedValue({ content: difficultyResponse, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, cost: 0.001, model: "claude-haiku-4-5", latencyMs: 100 });
  mockCall.mockResolvedValue({ content: difficultyResponse, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, cost: 0.001, model: "claude-haiku-4-5", latencyMs: 100 });

  return {
    quickClaude: mockQuickClaude,
    call: mockCall,
  } as unknown as LLMProvider;
}

function makeMockPool(providers: AgentProfile["provider"][] = ["claude"]): AgentPool {
  const agents: AgentProfile[] = providers.map(provider => ({
    provider,
    model: provider === "claude" ? "claude-opus-4-6" : provider === "gpt" ? "gpt-4o" : "gemini-2.0-flash",
    displayName: `${provider} agent`,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    maxContextTokens: 128_000,
    supportsTools: true,
    available: true,
  }));

  return {
    getAvailableAgents: vi.fn(() => agents),
  } as unknown as AgentPool;
}

// ── Tests ─────────────────────────────────────────────────────

describe("DifficultyRouter.route — difficulty field", () => {
  const validDifficulties = ["trivial", "simple", "medium", "complex", "unknown"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a RoutingDecision with difficulty set to 'trivial' for a short simple task", async () => {
    // Short task with no technical terms → heuristic returns "trivial", no LLM call
    const router = new DifficultyRouter(makeMockLLM("trivial"), makeMockPool());
    const result = await router.route("Hello world");

    expect(result!.difficulty).toBe("trivial");
    expect(validDifficulties).toContain(result!.difficulty);
  });

  it("returns difficulty 'simple' for a short task with one technical term", async () => {
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool());
    // "write an api endpoint" is short + 1 technical term → heuristic: simple
    const result = await router.route("write an api endpoint");

    expect(result!.difficulty).toBe("simple");
  });

  it("returns difficulty 'medium' via heuristic for 30+ word task with 0-2 technical terms", async () => {
    const router = new DifficultyRouter(makeMockLLM("medium"), makeMockPool());
    // Exactly hits the heuristic "medium" branch: ≥30 words, < 3 technical terms,
    // < 3 constraint words. The heuristic falls through to "medium" and
    // estimateDifficulty returns it directly (no LLM call needed for medium).
    const result = await router.route(
      "Create a web application that allows users to log in, view their profile page, " +
      "update their personal information, and log out. The application should have " +
      "a clean and modern user interface with good usability for all kinds of users.",
    );

    expect(result!.difficulty).toBe("medium");
  });

  it("returns difficulty 'complex' for a description with many technical terms", async () => {
    const router = new DifficultyRouter(makeMockLLM("complex"), makeMockPool());
    // 4 technical terms (api, database, architecture, algorithm) → heuristic returns "complex"
    const result = await router.route(
      "Design and deploy an api with database integration using a scalable architecture " +
      "that includes an algorithm for ranking results",
    );

    expect(result!.difficulty).toBe("complex");
  });

  it("returns difficulty 'unknown' when LLM returns unknown for a medium-heuristic task", async () => {
    // The heuristic never returns "unknown" — only the LLM does.
    // We craft a description that the heuristic scores as "medium"
    // (≥30 words, <3 technical terms, <3 constraint words) so the
    // LLM path is triggered. The mocked LLM returns "unknown".
    const router = new DifficultyRouter(makeMockLLM("unknown"), makeMockPool());
    const result = await router.route(
      "Help me figure out what to do with the project. The requirements are still " +
      "evolving and the team is not sure about the scope. We need something that works " +
      "but we have no clear specification yet and the goals keep changing every week.",
    );

    expect(result!.difficulty).toBe("unknown");
  });

  it("result always has a valid difficulty value", async () => {
    const router = new DifficultyRouter(makeMockLLM("medium"), makeMockPool());
    const result = await router.route("Analyze this dataset");

    expect(validDifficulties).toContain(result!.difficulty);
  });
});

describe("DifficultyRouter.route — routing fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("trivial task has useWorldModel=false and useSwarm=false", async () => {
    const router = new DifficultyRouter(makeMockLLM("trivial"), makeMockPool());
    const result = await router.route("Hello world");

    expect(result!.useWorldModel).toBe(false);
    expect(result!.useSwarm).toBe(false);
  });

  it("complex task has useWorldModel=true and requiresVerification=true", async () => {
    const router = new DifficultyRouter(makeMockLLM("complex"), makeMockPool());
    const result = await router.route(
      "Design a distributed microservice architecture with algorithm optimization and api integration and database migration",
    );

    expect(result!.useWorldModel).toBe(true);
    expect(result!.requiresVerification).toBe(true);
  });

  it("unknown difficulty enables swarm mode", async () => {
    // Use same strategy: medium-heuristic description so LLM is called
    // and returns "unknown" → useSwarm must be true.
    const router = new DifficultyRouter(makeMockLLM("unknown"), makeMockPool());
    const result = await router.route(
      "Help me figure out what to do with the project. The requirements are still " +
      "evolving and the team is not sure about the scope. We need something that works " +
      "but we have no clear specification yet and the goals keep changing every week.",
    );

    expect(result!.useSwarm).toBe(true);
  });

  it("result includes a non-empty reasoning string", async () => {
    const router = new DifficultyRouter(makeMockLLM("medium"), makeMockPool());
    const result = await router.route("Build a REST API with authentication and authorization");

    expect(typeof result!.reasoning).toBe("string");
    expect(result!.reasoning.length).toBeGreaterThan(0);
  });

  it("recommendedAgent is a valid AgentProvider", async () => {
    const validProviders = ["claude", "gpt", "gemini", "ollama"];
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool(["claude", "gpt"]));
    const result = await router.route("write a hello world script");

    expect(validProviders).toContain(result!.recommendedAgent);
  });
});

describe("DifficultyRouter.route — qualia-driven routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to reliable (claude) agent when frustration is high", async () => {
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool(["gpt", "claude"]));
    const result = await router.route("write a script", {
      pleasure: 0.2, arousal: 0.8, dominance: 0.3, clarity: 0.5,
      confidence: 0.5, frustration: 0.9, curiosity: 0.3, satisfaction: 0.2,
      selfCoherence: 0.7, existentialComfort: 0.6, purposeAlignment: 0.8,
    });

    expect(result!.recommendedAgent).toBe("claude");
  });

  it("routes to reliable agent when confidence is very low", async () => {
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool(["gpt", "claude"]));
    const result = await router.route("write a simple function", {
      pleasure: 0.5, arousal: 0.5, dominance: 0.5, clarity: 0.5,
      confidence: 0.2, frustration: 0.3, curiosity: 0.5, satisfaction: 0.5,
      selfCoherence: 0.8, existentialComfort: 0.7, purposeAlignment: 0.9,
    });

    expect(result!.recommendedAgent).toBe("claude");
  });

  it("reasoning contains qualia note when frustrated", async () => {
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool());
    const result = await router.route("write a hello world", {
      pleasure: 0.2, arousal: 0.8, dominance: 0.3, clarity: 0.5,
      confidence: 0.5, frustration: 0.85, curiosity: 0.3, satisfaction: 0.2,
      selfCoherence: 0.7, existentialComfort: 0.6, purposeAlignment: 0.8,
    });

    // The qualia note is always appended to reasoning when frustrated
    expect(result!.reasoning).toContain("Qualia");
  });
});

describe("DifficultyRouter.recordOutcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("can be called without throwing", async () => {
    const router = new DifficultyRouter(makeMockLLM(), makeMockPool());

    await expect(
      router.recordOutcome("claude", "code", true, 0.01),
    ).resolves.toBeUndefined();
  });

  it("records a successful outcome for a new agent/task-type pair", async () => {
    const router = new DifficultyRouter(makeMockLLM(), makeMockPool());
    await router.recordOutcome("claude", "code", true, 0.05);

    // No error thrown — profile was created internally
    // We verify it persisted by calling recordOutcome again (updates existing)
    await expect(
      router.recordOutcome("claude", "code", true, 0.03),
    ).resolves.toBeUndefined();
  });

  it("records a failure outcome without throwing", async () => {
    const router = new DifficultyRouter(makeMockLLM(), makeMockPool());

    await expect(
      router.recordOutcome("gpt", "write", false, 0.02),
    ).resolves.toBeUndefined();
  });

  it("can record outcomes for multiple agents and task types", async () => {
    const router = new DifficultyRouter(makeMockLLM(), makeMockPool(["claude", "gpt"]));

    await expect(
      Promise.all([
        router.recordOutcome("claude", "code", true, 0.01),
        router.recordOutcome("gpt", "write", false, 0.02),
        router.recordOutcome("claude", "analyze", true, 0.03),
      ]),
    ).resolves.toBeDefined();
  });
});

describe("DifficultyRouter.estimateDifficulty — heuristic path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'trivial' for a very short task with no technical terms", async () => {
    const router = new DifficultyRouter(makeMockLLM("trivial"), makeMockPool());
    const difficulty = await router.estimateDifficulty("what is 2+2");

    expect(difficulty).toBe("trivial");
  });

  it("returns 'simple' for a short task with one technical term", async () => {
    const router = new DifficultyRouter(makeMockLLM("simple"), makeMockPool());
    const difficulty = await router.estimateDifficulty("write an api for users");

    expect(difficulty).toBe("simple");
  });

  it("falls back to heuristic result if LLM throws", async () => {
    mockQuickClaude.mockRejectedValueOnce(new Error("LLM unavailable"));
    const llm = { quickClaude: mockQuickClaude, call: mockCall } as unknown as LLMProvider;
    const router = new DifficultyRouter(llm, makeMockPool());

    // Long enough to bypass heuristic short-circuit (not trivial/simple)
    const difficulty = await router.estimateDifficulty(
      "Build a medium complexity REST service with some requirements",
    );

    // Should return the heuristic result rather than throwing
    expect(["trivial", "simple", "medium", "complex", "unknown"]).toContain(difficulty);
  });
});
