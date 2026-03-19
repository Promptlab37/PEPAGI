// ═══════════════════════════════════════════════════════════════
// Tests: Kiro Agent Config Schema
// Feature: kiro-cli-support, Property 8: Config Schema Validation Round-Trip
// Validates: Requirements 7.1, 7.2
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

// ── Filesystem mock ───────────────────────────────────────────
// Prevent real disk I/O — loadConfig reads config.json and creates dirs.

let mockConfigContent = "{}";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockImplementation(async (path: string) => {
    if (String(path).endsWith("config.json")) return mockConfigContent;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => String(path).endsWith("config.json")),
}));

// Suppress console noise from config loader
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Fresh-import loadConfig to bypass the module-level cachedConfig.
 * Each call gets a clean module with no cached state.
 */
async function freshLoadConfig() {
  const mod = await import("../loader.js");
  return mod.loadConfig();
}

// ─── Schema Validation Tests ──────────────────────────────────

describe("KiroAgentConfigSchema", () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfigContent = "{}";
    delete process.env.KIRO_CLI_ENABLED;
  });

  afterEach(() => {
    delete process.env.KIRO_CLI_ENABLED;
  });

  // ── Default values ──────────────────────────────────────────

  it("provides correct defaults (enabled=false, model='auto', timeout=120)", async () => {
    mockConfigContent = JSON.stringify({});
    const config = await freshLoadConfig();
    const kiro = config.agents.kiro!;

    expect(kiro.enabled).toBe(false);
    expect(kiro.model).toBe("auto");
    expect(kiro.agent).toBe("");
    expect(kiro.timeout).toBe(120);
    expect(kiro.forwardMcpServers).toEqual([]);
  });

  // ── Schema rejects apiKey ───────────────────────────────────

  it("strips apiKey field (not part of Kiro schema)", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          model: "auto",
          apiKey: "sk-secret-key-should-be-stripped",
        },
      },
    });
    const config = await freshLoadConfig();
    const kiro = config.agents.kiro as Record<string, unknown>;

    // Zod strips unknown keys — apiKey should not survive parsing
    expect(kiro).not.toHaveProperty("apiKey");
  });

  it("strips temperature, maxOutputTokens, and maxAgenticTurns", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          temperature: 0.7,
          maxOutputTokens: 8192,
          maxAgenticTurns: 5,
        },
      },
    });
    const config = await freshLoadConfig();
    const kiro = config.agents.kiro as Record<string, unknown>;

    expect(kiro).not.toHaveProperty("temperature");
    expect(kiro).not.toHaveProperty("maxOutputTokens");
    expect(kiro).not.toHaveProperty("maxAgenticTurns");
  });

  // ── KIRO_CLI_ENABLED env var overlay ────────────────────────

  it("enables Kiro via KIRO_CLI_ENABLED=true env var", async () => {
    mockConfigContent = JSON.stringify({});
    process.env.KIRO_CLI_ENABLED = "true";
    const config = await freshLoadConfig();

    expect(config.agents.kiro!.enabled).toBe(true);
  });

  it("does not enable Kiro when KIRO_CLI_ENABLED is absent", async () => {
    mockConfigContent = JSON.stringify({});
    delete process.env.KIRO_CLI_ENABLED;
    const config = await freshLoadConfig();

    expect(config.agents.kiro!.enabled).toBe(false);
  });

  it("KIRO_CLI_ENABLED preserves other kiro config fields", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: false,
          model: "claude-sonnet-4.5",
          agent: "security-auditor",
          timeout: 60,
        },
      },
    });
    process.env.KIRO_CLI_ENABLED = "true";
    const config = await freshLoadConfig();
    const kiro = config.agents.kiro!;

    expect(kiro.enabled).toBe(true);
    expect(kiro.model).toBe("claude-sonnet-4.5");
    expect(kiro.agent).toBe("security-auditor");
    expect(kiro.timeout).toBe(60);
  });

  // ── forwardMcpServers validation ────────────────────────────

  it("accepts valid forwardMcpServers config", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          forwardMcpServers: [
            {
              name: "pepagi-mcp",
              command: "node",
              args: ["dist/mcp/index.js"],
              env: [{ name: "PORT", value: "3099" }],
            },
          ],
        },
      },
    });
    const config = await freshLoadConfig();
    const servers = config.agents.kiro!.forwardMcpServers;

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("pepagi-mcp");
    expect(servers[0].command).toBe("node");
    expect(servers[0].args).toEqual(["dist/mcp/index.js"]);
    expect(servers[0].env).toEqual([{ name: "PORT", value: "3099" }]);
  });

  it("defaults forwardMcpServers args and env to empty arrays", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          forwardMcpServers: [
            { name: "simple-server", command: "npx" },
          ],
        },
      },
    });
    const config = await freshLoadConfig();
    const server = config.agents.kiro!.forwardMcpServers[0];

    expect(server.args).toEqual([]);
    expect(server.env).toEqual([]);
  });

  it("accepts multiple MCP servers", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          forwardMcpServers: [
            { name: "server-a", command: "node", args: ["a.js"] },
            { name: "server-b", command: "python", args: ["-m", "b"] },
          ],
        },
      },
    });
    const config = await freshLoadConfig();

    expect(config.agents.kiro!.forwardMcpServers).toHaveLength(2);
  });

  // ── Custom field values ─────────────────────────────────────

  it("accepts custom model, agent, and timeout values", async () => {
    mockConfigContent = JSON.stringify({
      agents: {
        kiro: {
          enabled: true,
          model: "claude-opus-4.6",
          agent: "code-reviewer",
          timeout: 300,
        },
      },
    });
    const config = await freshLoadConfig();
    const kiro = config.agents.kiro!;

    expect(kiro.model).toBe("claude-opus-4.6");
    expect(kiro.agent).toBe("code-reviewer");
    expect(kiro.timeout).toBe(300);
  });
});

// ─── Property 8: Config Schema Validation Round-Trip ──────────

describe("Property 8: Config Schema Validation Round-Trip", () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfigContent = "{}";
    delete process.env.KIRO_CLI_ENABLED;
  });

  afterEach(() => {
    delete process.env.KIRO_CLI_ENABLED;
  });

  /** Arbitrary generator for valid MCP server configs */
  const arbMcpServer = fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('"') && !s.includes("\\")),
    command: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('"') && !s.includes("\\")),
    args: fc.array(fc.string({ maxLength: 30 }).filter(s => !s.includes('"') && !s.includes("\\")), { maxLength: 5 }),
    env: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('"') && !s.includes("\\")),
        value: fc.string({ maxLength: 100 }).filter(s => !s.includes('"') && !s.includes("\\")),
      }),
      { maxLength: 5 },
    ),
  });

  /** Arbitrary generator for valid KiroAgentConfig objects */
  const arbKiroConfig = fc.record({
    enabled: fc.boolean(),
    model: fc.oneof(
      fc.constant("auto"),
      fc.constant("claude-opus-4.6"),
      fc.constant("claude-sonnet-4.5"),
      fc.constant("deepseek-3.2"),
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('"') && !s.includes("\\")),
    ),
    agent: fc.oneof(
      fc.constant(""),
      fc.string({ maxLength: 30 }).filter(s => !s.includes('"') && !s.includes("\\")),
    ),
    timeout: fc.integer({ min: 1, max: 3600 }),
    forwardMcpServers: fc.array(arbMcpServer, { maxLength: 3 }),
  });

  it("any valid KiroAgentConfig survives parse round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(arbKiroConfig, async (kiroInput) => {
        vi.resetModules();
        mockConfigContent = JSON.stringify({ agents: { kiro: kiroInput } });

        const config = await freshLoadConfig();
        const kiro = config.agents.kiro!;

        // All fields must survive the round-trip through Zod
        expect(kiro.enabled).toBe(kiroInput.enabled);
        expect(kiro.model).toBe(kiroInput.model);
        expect(kiro.agent).toBe(kiroInput.agent);
        expect(kiro.timeout).toBe(kiroInput.timeout);
        expect(kiro.forwardMcpServers).toHaveLength(kiroInput.forwardMcpServers.length);

        for (let i = 0; i < kiroInput.forwardMcpServers.length; i++) {
          const input = kiroInput.forwardMcpServers[i];
          const output = kiro.forwardMcpServers[i];
          expect(output.name).toBe(input.name);
          expect(output.command).toBe(input.command);
          expect(output.args).toEqual(input.args);
          expect(output.env).toEqual(input.env);
        }

        // Verify no extra fields leaked through
        const kiroKeys = Object.keys(kiro);
        expect(kiroKeys).not.toContain("apiKey");
        expect(kiroKeys).not.toContain("temperature");
        expect(kiroKeys).not.toContain("maxOutputTokens");
        expect(kiroKeys).not.toContain("maxAgenticTurns");
      }),
      { numRuns: 100 },
    );
  });
});
