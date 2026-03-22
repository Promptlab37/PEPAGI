// ═══════════════════════════════════════════════════════════════
// Tests: Kiro CLI Provider (ACP)
// Requirements: 2.1–2.5, 3.1–3.5, 4.1–4.5, 5.1–5.6, 6.1, 6.2,
//               9.1–9.3, 10.1–10.3, 11.1–11.3, 14.1–14.4
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import fc from "fast-check";

// ─── Shared mock state ───────────────────────────────────────

let activeScenario = "happy-path";
let spawnEnoent = false;

/** Captured stdin writes from the most recent kiro-cli spawn (for PBT) */
let capturedStdinWrites: string[] = [];

/** Captured spawn arguments from the most recent kiro-cli spawn (for PBT) */
let capturedSpawnArgs: string[] = [];

const SIMULATOR_PATH = resolve("dist/agents/__tests__/acp-simulator.js");

// ─── Mock child_process.spawn to intercept kiro-cli calls ────

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((...args: Parameters<typeof original.spawn>) => {
      const cmd = args[0] as string;
      if (cmd === "kiro-cli") {
        capturedSpawnArgs = (args[1] as string[] | undefined) ?? [];
        if (spawnEnoent) {
          return original.spawn("__nonexistent_binary_kiro_test__", [], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        }
        const env = { ...process.env, ACP_SCENARIO: activeScenario };
        const child = original.spawn("node", [SIMULATOR_PATH], {
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        // Intercept stdin writes for protocol ordering verification (PBT)
        if (child.stdin) {
          const origWrite = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((data: unknown, ...rest: unknown[]) => {
            if (typeof data === "string") capturedStdinWrites.push(data);
            else if (Buffer.isBuffer(data)) capturedStdinWrites.push(data.toString());
            return (origWrite as Function)(data, ...rest);
          }) as typeof child.stdin.write;
        }
        return child;
      }
      return original.spawn(...args);
    }),
  };
});

// ─── Mock loadConfig to return kiro-enabled config ───────────

let mockKiroConfig: Record<string, unknown> = {
  enabled: true,
  model: "auto",
  agent: "",
  timeout: 120,
  forwardMcpServers: [],
};

vi.mock("../../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/loader.js")>();
  return {
    ...original,
    loadConfig: vi.fn(async () => {
      const realConfig = await original.loadConfig();
      return {
        ...realConfig,
        agents: {
          ...realConfig.agents,
          kiro: { ...mockKiroConfig },
        },
      };
    }),
  };
});


// ─── Imports (after mocks) ───────────────────────────────────

import { LLMProvider, LLMProviderError, kiroCircuitBreaker, claudeCircuitBreaker, checkKiroHealth } from "../llm-provider.js";
import { AgentPool } from "../agent-pool.js";
import { loadConfig } from "../../config/loader.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeKiroOpts(overrides: Record<string, unknown> = {}) {
  return {
    provider: "kiro" as const,
    model: "auto",
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user" as const, content: "Hello" }],
    ...overrides,
  };
}

async function callKiro(scenario: string, opts?: Record<string, unknown>, configOverrides?: Record<string, unknown>) {
  activeScenario = scenario;
  spawnEnoent = false;
  if (configOverrides) {
    mockKiroConfig = { ...mockKiroConfig, ...configOverrides };
  }
  kiroCircuitBreaker.forceReset();
  const provider = new LLMProvider();
  return provider.call(makeKiroOpts(opts));
}

// ─── Tests ───────────────────────────────────────────────────

describe("Kiro Provider", () => {
  beforeEach(() => {
    activeScenario = "happy-path";
    spawnEnoent = false;
    capturedStdinWrites = [];
    capturedSpawnArgs = [];
    mockKiroConfig = {
      enabled: true,
      model: "auto",
      agent: "",
      timeout: 120,
      forwardMcpServers: [],
    };
    kiroCircuitBreaker.forceReset();
  });

  // ── Happy path ─────────────────────────────────────────────

  describe("happy-path scenario", () => {
    it("returns correct content from accumulated agent_message_chunks", async () => {
      const result = await callKiro("happy-path");
      expect(result.content).toBe("Hello, I am Kiro.");
    });

    it("returns correct toolCalls from tool_call notifications", async () => {
      const result = await callKiro("happy-path");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("read_file");
      expect(result.toolCalls[0].input).toEqual({ path: "/tmp/test.txt" });
    });

    it("returns usage data from ACP prompt response", async () => {
      const result = await callKiro("happy-path");
      expect(result.usage.inputTokens).toBe(200);
      expect(result.usage.outputTokens).toBe(150);
    });

    it("returns cost from usage_update notification", async () => {
      const result = await callKiro("happy-path");
      expect(result.cost).toBeCloseTo(0.0042);
    });

    it("returns model from opts", async () => {
      const result = await callKiro("happy-path", { model: "claude-sonnet-4-6" });
      expect(result.model).toBe("claude-sonnet-4-6");
    });

    it("returns positive latencyMs", async () => {
      const result = await callKiro("happy-path");
      expect(result.latencyMs).toBeGreaterThan(0);
    });
  });

  // ── Happy path without usage data ──────────────────────────

  describe("happy-no-usage scenario", () => {
    it("falls back to character-based estimation when no usage data", async () => {
      const result = await callKiro("happy-no-usage");
      expect(result.content).toBe("Response without usage data.");

      const promptChars = "You are a helpful assistant.".length + "Hello".length;
      const responseChars = "Response without usage data.".length;
      expect(result.usage.inputTokens).toBe(Math.ceil(promptChars / 4));
      expect(result.usage.outputTokens).toBe(Math.ceil(responseChars / 4));
    });

    it("returns cost=0 when no usage_update cost", async () => {
      const result = await callKiro("happy-no-usage");
      expect(result.cost).toBe(0);
    });
  });

  // ── Error scenarios ────────────────────────────────────────

  describe("error-on-session-new scenario", () => {
    it("throws LLMProviderError on session/new failure", async () => {
      await expect(callKiro("error-on-session-new"))
        .rejects.toThrow(/Session creation failed/);
    });
  });

  describe("error-on-prompt scenario", () => {
    it("throws LLMProviderError on session/prompt failure", async () => {
      await expect(callKiro("error-on-prompt"))
        .rejects.toThrow(/context window exceeded/);
    });
  });

  // ── Timeout scenarios ──────────────────────────────────────

  describe("hang-on-initialize scenario", () => {
    it("times out after 10s and cleans up subprocess", async () => {
      // Init timeout is 10s per attempt. withRetry retries 3x with 3s+10s delays.
      // Total: ~10s + 3s + 10s + 10s + 10s ≈ 43s
      await expect(callKiro("hang-on-initialize"))
        .rejects.toThrow(/timeout/i);
    }, 60_000);
  });

  // ── Crash scenario ─────────────────────────────────────────

  describe("crash-mid-stream scenario", () => {
    it("throws error when subprocess crashes mid-stream", async () => {
      // crash-mid-stream exits with code 1 (retryable), so withRetry will retry.
      // We need enough timeout for retries to exhaust.
      await expect(callKiro("crash-mid-stream"))
        .rejects.toThrow(/Kiro CLI error/);
    }, 60_000);
  });

  // ── Malformed JSON scenario ────────────────────────────────

  describe("malformed-json scenario", () => {
    it("extracts valid data despite malformed JSON lines", async () => {
      const result = await callKiro("malformed-json");
      expect(result.content).toBe("Valid chunk. More valid data.");
    });
  });

  // ── Partial lines scenario ─────────────────────────────────

  describe("partial-lines scenario", () => {
    it("reassembles split JSON lines correctly", async () => {
      const result = await callKiro("partial-lines");
      expect(result.content).toBe("Reassembled content.");
    });
  });

  // ── ENOENT (kiro-cli not found) ────────────────────────────

  describe("kiro-cli not found", () => {
    it("throws non-retryable LLMProviderError when kiro-cli binary is missing", async () => {
      spawnEnoent = true;
      kiroCircuitBreaker.forceReset();
      const provider = new LLMProvider();
      await expect(provider.call(makeKiroOpts()))
        .rejects.toThrow(/not installed|spawn failed/i);
    });
  });

  // ── Abort signal (sigterm-graceful) ────────────────────────

  describe("sigterm-graceful scenario", () => {
    it("handles abort signal and subprocess exits gracefully", async () => {
      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 1_000);

      const result = await callKiro("sigterm-graceful", {
        abortController,
        timeoutMs: 10_000,
      });
      expect(result.content).toContain("Working on it...");
    }, 10_000);
  });

  // ── SIGKILL escalation (sigterm-ignore) ────────────────────

  describe("sigterm-ignore scenario", () => {
    it("escalates to SIGKILL when subprocess ignores SIGTERM", async () => {
      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 500);

      await expect(callKiro("sigterm-ignore", {
        abortController,
        timeoutMs: 15_000,
      })).rejects.toThrow();
    }, 15_000);
  });

  // ── Health check ───────────────────────────────────────────

  describe("checkKiroHealth", () => {
    it("returns true when simulator responds to initialize", async () => {
      activeScenario = "happy-path";
      spawnEnoent = false;
      const healthy = await checkKiroHealth();
      expect(healthy).toBe(true);
    });

    it("returns false when kiro-cli binary is not found", async () => {
      spawnEnoent = true;
      const healthy = await checkKiroHealth();
      expect(healthy).toBe(false);
    });
  });

  // ── LLMProvider routing ────────────────────────────────────

  describe("LLMProvider routing", () => {
    it("routes provider=kiro to callKiro via LLMProvider.call()", async () => {
      const result = await callKiro("happy-path");
      expect(result.content).toBe("Hello, I am Kiro.");
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  // ── Circuit breaker separation ─────────────────────────────

  describe("circuit breaker", () => {
    it("kiroCircuitBreaker is a separate instance from claudeCircuitBreaker", () => {
      expect(kiroCircuitBreaker).not.toBe(claudeCircuitBreaker);
      expect(kiroCircuitBreaker.getState()).toBe("closed");
      expect(claudeCircuitBreaker.getState()).toBe("closed");
    });
  });

  // ── Agent pool availability ────────────────────────────────

  describe("agent pool availability", () => {
    it("includes kiro when enabled", async () => {
      const config = await loadConfig();
      const testConfig = {
        ...config,
        agents: {
          ...config.agents,
          kiro: { enabled: true, model: "auto", agent: "", timeout: 120, forwardMcpServers: [] },
        },
      };
      const pool = new AgentPool(testConfig as typeof config);
      const available = pool.getAvailableAgents();
      const kiroAgent = available.find(a => a.provider === "kiro");
      expect(kiroAgent).toBeDefined();
      expect(kiroAgent!.provider).toBe("kiro");
    });

    it("excludes kiro when disabled", async () => {
      const config = await loadConfig();
      const testConfig = {
        ...config,
        agents: {
          ...config.agents,
          kiro: { enabled: false, model: "auto", agent: "", timeout: 120, forwardMcpServers: [] },
        },
      };
      const pool = new AgentPool(testConfig as typeof config);
      const available = pool.getAvailableAgents();
      const kiroAgent = available.find(a => a.provider === "kiro");
      expect(kiroAgent).toBeUndefined();
    });
  });

  // ── Property 3: Prompt Construction Completeness (PBT) ──────

  describe("Property 3: Prompt Construction Completeness", () => {
    /**
     * Parse captured stdin writes and extract the session/prompt content blocks.
     */
    function extractPromptBlocks(writes: string[]): Array<{ type: string; text: string }> {
      for (const raw of writes) {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.method === "session/prompt" && msg.params?.prompt) {
              return msg.params.prompt as Array<{ type: string; text: string }>;
            }
          } catch { /* skip */ }
        }
      }
      return [];
    }

    // Feature: kiro-cli-support, Property 3: Prompt Construction Completeness
    it("prompt contains full systemPrompt and all message contents for random inputs", async () => {
      // Filter out strings with characters that break JSON round-trip
      const arbSafeString = (min: number, max: number) =>
        fc.string({ minLength: min, maxLength: max }).filter(s => !s.includes('"') && !s.includes("\\") && !s.includes("\n") && s.trim().length > 0);

      const arbSystemPrompt = arbSafeString(1, 300);
      const arbMessages = fc.array(
        fc.record({
          role: fc.constant("user" as const),
          content: arbSafeString(1, 200),
        }),
        { minLength: 1, maxLength: 5 },
      );

      await fc.assert(
        fc.asyncProperty(
          arbSystemPrompt, arbMessages,
          async (systemPrompt, messages) => {
            // Reset state
            activeScenario = "happy-path";
            spawnEnoent = false;
            capturedStdinWrites = [];
            mockKiroConfig = {
              enabled: true,
              model: "auto",
              agent: "",
              timeout: 120,
              forwardMcpServers: [],
            };
            kiroCircuitBreaker.forceReset();

            const provider = new LLMProvider();
            await provider.call({
              provider: "kiro" as const,
              model: "auto",
              systemPrompt,
              messages,
            });

            const blocks = extractPromptBlocks(capturedStdinWrites);

            // Invariant 1: Number of blocks = 1 (system prompt) + messages.length
            expect(blocks).toHaveLength(1 + messages.length);

            // Invariant 2: All blocks have type "text"
            for (const block of blocks) {
              expect(block.type).toBe("text");
            }

            // Invariant 3: First block is the full system prompt (exact match)
            expect(blocks[0].text).toBe(systemPrompt);

            // Invariant 4: Each subsequent block matches the corresponding message content exactly
            for (let i = 0; i < messages.length; i++) {
              expect(blocks[i + 1].text).toBe(messages[i].content);
            }
          },
        ),
        { numRuns: 100 },
      );
    }, 120_000);
  });

  // ── Property 1: ACP Protocol Message Ordering (PBT) ────────

  describe("Property 1: ACP Protocol Message Ordering", () => {
    /**
     * Parse captured stdin writes into JSON-RPC method sequence.
     * Each write is a JSON string terminated by \n. Multiple writes
     * may be concatenated in a single string.
     */
    function parseStdinMethods(writes: string[]): Array<{ method: string; params?: Record<string, unknown> }> {
      const methods: Array<{ method: string; params?: Record<string, unknown> }> = [];
      for (const raw of writes) {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.method) methods.push({ method: msg.method, params: msg.params });
          } catch { /* skip non-JSON */ }
        }
      }
      return methods;
    }

    // Feature: kiro-cli-support, Property 1: ACP Protocol Message Ordering
    it("sends initialize → session/new → (optional set_mode) → session/prompt for random configs", async () => {
      const arbModel = fc.oneof(
        fc.constant("auto"),
        fc.constantFrom("claude-opus-4.6", "claude-sonnet-4.5", "deepseek-3.2"),
      );
      const arbAgent = fc.oneof(
        fc.constant(""),
        fc.string({ minLength: 1, maxLength: 20, unit: "grapheme" }).map(s => s.replace(/[^a-zA-Z0-9_-]/g, "a")),
      );
      const arbSystemPrompt = fc.string({ minLength: 1, maxLength: 200 });
      const arbMessages = fc.array(
        fc.record({
          role: fc.constant("user" as const),
          content: fc.string({ minLength: 1, maxLength: 200 }),
        }),
        { minLength: 1, maxLength: 5 },
      );
      const arbAgenticMode = fc.boolean();

      await fc.assert(
        fc.asyncProperty(
          arbModel, arbAgent, arbSystemPrompt, arbMessages, arbAgenticMode,
          async (model, agent, systemPrompt, messages, agenticMode) => {
            // Reset state for each iteration
            activeScenario = "happy-path";
            spawnEnoent = false;
            capturedStdinWrites = [];
            mockKiroConfig = {
              enabled: true,
              model,
              agent,
              timeout: 120,
              forwardMcpServers: [],
            };
            kiroCircuitBreaker.forceReset();

            const provider = new LLMProvider();
            const result = await provider.call({
              provider: "kiro" as const,
              model,
              systemPrompt,
              messages,
              agenticMode,
            });

            // Parse the captured stdin writes into method sequence
            const methods = parseStdinMethods(capturedStdinWrites);
            const methodNames = methods.map(m => m.method);

            // Invariant 1: First request is always "initialize"
            expect(methodNames[0]).toBe("initialize");

            // Invariant 2: Second request is always "session/new"
            expect(methodNames[1]).toBe("session/new");

            // Invariant 3: session/new includes cwd parameter
            expect(methods[1].params).toHaveProperty("cwd");
            expect(typeof methods[1].params!.cwd).toBe("string");

            // Invariant 4: Last request is always "session/prompt"
            const lastMethod = methodNames[methodNames.length - 1];
            expect(lastMethod).toBe("session/prompt");

            // Invariant 5: session/prompt includes content blocks array
            const promptReq = methods[methodNames.length - 1];
            expect(promptReq.params).toHaveProperty("prompt");
            expect(Array.isArray(promptReq.params!.prompt)).toBe(true);
            const blocks = promptReq.params!.prompt as Array<{ type: string; text: string }>;
            expect(blocks.length).toBeGreaterThanOrEqual(1);
            // First block is system prompt
            expect(blocks[0].text).toBe(systemPrompt);

            // Invariant 6: If set_mode is present, it's between session/new and session/prompt
            const setModeIdx = methodNames.indexOf("session/set_mode");
            if (setModeIdx !== -1) {
              expect(setModeIdx).toBeGreaterThan(1); // after session/new
              expect(setModeIdx).toBeLessThan(methodNames.length - 1); // before session/prompt
            }

            // Invariant 7: No session/set_model method — model is via --model CLI flag
            expect(methodNames).not.toContain("session/set_model");

            // Invariant 8: Only expected methods appear
            for (const name of methodNames) {
              expect(["initialize", "session/new", "session/set_mode", "session/prompt"]).toContain(name);
            }

            // Invariant 9: Result is a valid LLMResponse
            expect(result.content).toBeTruthy();
            expect(result.model).toBe(model);
          },
        ),
        { numRuns: 50 },
      );
    }, 120_000);
  });

  // ── Property 12: Spawn Arguments from Agent Config (PBT) ───

  describe("Property 12: Spawn Arguments from Config", () => {
    // Feature: kiro-cli-support, Property 12: Spawn Arguments from Config
    it("spawn args include --agent and --model flags matching config for random inputs", async () => {
      // Generate safe agent names (alphanumeric + dash/underscore, or empty)
      const arbAgent = fc.oneof(
        fc.constant(""),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/),
      );
      const arbModel = fc.oneof(
        fc.constant("auto"),
        fc.constantFrom(
          "claude-opus-4.6", "claude-sonnet-4.5", "claude-sonnet-4.0",
          "claude-haiku-4.5", "deepseek-3.2", "minimax-2.5", "qwen3-coder-next",
        ),
      );

      await fc.assert(
        fc.asyncProperty(arbAgent, arbModel, async (agent, model) => {
          // Reset state
          activeScenario = "happy-path";
          spawnEnoent = false;
          capturedStdinWrites = [];
          capturedSpawnArgs = [];
          mockKiroConfig = {
            enabled: true,
            model,
            agent,
            timeout: 120,
            forwardMcpServers: [],
          };
          kiroCircuitBreaker.forceReset();

          const provider = new LLMProvider();
          await provider.call({
            provider: "kiro" as const,
            model,
            systemPrompt: "test",
            messages: [{ role: "user" as const, content: "hi" }],
          });

          // Invariant 1: First arg is always "acp"
          expect(capturedSpawnArgs[0]).toBe("acp");

          // Invariant 2: Non-empty agent → --agent <name> present
          if (agent) {
            const agentIdx = capturedSpawnArgs.indexOf("--agent");
            expect(agentIdx).toBeGreaterThan(0);
            expect(capturedSpawnArgs[agentIdx + 1]).toBe(agent);
          }

          // Invariant 3: Empty agent → no --agent flag
          if (!agent) {
            expect(capturedSpawnArgs).not.toContain("--agent");
          }

          // Invariant 4: Non-"auto" model → --model <model> present
          if (model !== "auto") {
            const modelIdx = capturedSpawnArgs.indexOf("--model");
            expect(modelIdx).toBeGreaterThan(0);
            expect(capturedSpawnArgs[modelIdx + 1]).toBe(model);
          }

          // Invariant 5: "auto" model → no --model flag
          if (model === "auto") {
            expect(capturedSpawnArgs).not.toContain("--model");
          }

          // Invariant 6: No unexpected flags (only acp, --agent, --model and their values)
          const expectedArgs: string[] = ["acp"];
          if (agent) expectedArgs.push("--agent", agent);
          if (model !== "auto") expectedArgs.push("--model", model);
          expect(capturedSpawnArgs).toEqual(expectedArgs);
        }),
        { numRuns: 100 },
      );
    }, 120_000);
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 2: Integration Smoke Test against Real Kiro CLI
// Requirements: 2.1, 2.2, 3.1, 3.2, 4.4, 5.1
// Gated behind KIRO_CLI_AVAILABLE=true — not run in CI
// ═══════════════════════════════════════════════════════════════

describe.skipIf(!process.env.KIRO_CLI_AVAILABLE)("Kiro CLI Integration (real binary)", () => {
  it("should complete a full ACP handshake and return non-empty content", async () => {
    // Use the real spawn, bypassing the vi.mock
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

    const result = await new Promise<{
      initializeOk: boolean;
      sessionCreated: boolean;
      promptResponseReceived: boolean;
      stopReason: string | null;
      content: string;
    }>((resolve, reject) => {
      const child = realSpawn("kiro-cli", ["acp"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const state = {
        initializeOk: false,
        sessionCreated: false,
        promptResponseReceived: false,
        stopReason: null as string | null,
        content: "",
      };

      let nextId = 1;
      let lineBuf = "";
      let initId = 0;
      let sessionNewId = 0;
      let promptId = 0;
      let sessionId = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { child.kill("SIGKILL"); } catch { /* */ }
          reject(new Error("Integration test timed out after 30s"));
        }
      }, 30_000);

      const send = (method: string, params: Record<string, unknown> = {}): number => {
        const id = nextId++;
        const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        child.stdin!.write(msg);
        return id;
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { child.kill("SIGTERM"); } catch { /* */ }
        resolve(state);
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;

          let msg: Record<string, unknown>;
          try { msg = JSON.parse(trimmed); } catch { continue; }

          // Response with id
          if (typeof msg.id === "number") {
            if (msg.id === initId && msg.result) {
              state.initializeOk = true;
              // Send session/new with read-only intent
              sessionNewId = send("session/new", { cwd: process.cwd() });
            } else if (msg.id === sessionNewId && msg.result) {
              state.sessionCreated = true;
              sessionId = ((msg.result as Record<string, unknown>).sessionId as string) ?? "";

              // Try to select a planner/readonly mode if available
              const modes = (msg.result as Record<string, unknown>).modes as {
                availableModes?: Array<{ id: string }>;
              } | undefined;
              if (modes?.availableModes) {
                const readonlyMode = modes.availableModes.find(
                  m => m.id.includes("planner") || m.id.includes("readonly"),
                );
                if (readonlyMode) {
                  send("session/set_mode", { sessionId, modeId: readonlyMode.id });
                }
              }

              // Send a trivial prompt
              promptId = send("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: "Reply with exactly: PEPAGI_SMOKE_OK" }],
              });
            } else if (msg.id === promptId && msg.result) {
              const res = msg.result as Record<string, unknown>;
              state.promptResponseReceived = true;
              state.stopReason = (res.stopReason as string) ?? null;
              finish();
              return;
            }
            continue;
          }

          // Notification — accumulate text chunks
          if (msg.method === "session/update" && msg.params) {
            const update = (msg.params as Record<string, unknown>).update as Record<string, unknown> | undefined;
            if (update?.sessionUpdate === "agent_message_chunk") {
              const text = ((update.content as Record<string, unknown>)?.text as string) ?? "";
              state.content += text;
            }
          }
        }
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`kiro-cli spawn failed: ${err.message} (code: ${err.code})`));
        }
      });

      child.on("close", () => {
        finish(); // resolve with whatever state we have
      });

      // Start ACP handshake
      initId = send("initialize", { protocolVersion: 1 });
    });

    // Verify: initialize response received
    expect(result.initializeOk).toBe(true);
    // Verify: session created
    expect(result.sessionCreated).toBe(true);
    // Verify: prompt response with stopReason received
    expect(result.promptResponseReceived).toBe(true);
    expect(result.stopReason).toBeTruthy();
    // Verify: LLMResponse has non-empty content
    expect(result.content.length).toBeGreaterThan(0);
  }, 60_000);
});
