// ═══════════════════════════════════════════════════════════════
// PEPAGI — Enhanced GitHub Tool Tests
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../core/logger.js", () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
    debug() {}
  },
}));

vi.mock("../../core/event-bus.js", () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../security/tool-guard.js", () => ({
  sanitizeToolOutput: vi.fn((output: string) => output),
  validateUrl: vi.fn(() => ({ valid: true })),
  logToolCall: vi.fn(),
  withTimeout: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../../security/dlp-engine.js", () => ({
  dlpEngine: { inspect: vi.fn(() => ({ allowed: true, issues: [] })) },
}));

vi.mock("../../security/path-validator.js", () => ({
  validatePath: vi.fn(async (p: string) => p),
  PathSecurityError: class extends Error {},
}));

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(async () => ({ n8n: { enabled: false } })),
}));

// Mock all external tool modules
vi.mock("../web-search.js", () => ({ duckduckgoSearch: vi.fn(async () => []) }));
vi.mock("../home-assistant.js", () => ({ homeAssistantTool: { name: "home_assistant", description: "HA", execute: vi.fn() } }));
vi.mock("../spotify.js", () => ({ spotifyTool: { name: "spotify", description: "SP", execute: vi.fn() } }));
vi.mock("../youtube.js", () => ({ youtubeTool: { name: "youtube", description: "YT", execute: vi.fn() } }));
vi.mock("../browser.js", () => ({ browserTool: { name: "browser", description: "BR", execute: vi.fn() } }));
vi.mock("../calendar.js", () => ({ calendarTool: { name: "calendar", description: "CAL", execute: vi.fn() } }));
vi.mock("../weather.js", () => ({ weatherTool: { name: "weather", description: "W", execute: vi.fn() } }));
vi.mock("../notion.js", () => ({ notionTool: { name: "notion", description: "NOT", execute: vi.fn() } }));
vi.mock("../docker.js", () => ({ dockerTool: { name: "docker", description: "DOCK", execute: vi.fn() } }));
vi.mock("../pdf.js", () => ({ pdfTool: { name: "pdf", description: "PDF", execute: vi.fn() } }));
vi.mock("../n8n-webhook.js", () => ({ executeN8nWebhook: vi.fn() }));
vi.mock("../gmail.js", () => ({ gmailTool: { name: "gmail", description: "Gmail", execute: vi.fn(async () => ({ success: true, output: "ok" })) } }));
vi.mock("../google-drive.js", () => ({ googleDriveTool: { name: "google_drive", description: "Drive", execute: vi.fn(async () => ({ success: true, output: "ok" })) } }));

// Must mock security-guard, input-sanitizer to import tool-registry
vi.mock("../../security/input-sanitizer.js", () => ({
  InputSanitizer: class { async sanitize() { return { riskScore: 0, sanitized: "", threats: [] }; } },
}));

import { ToolRegistry } from "../tool-registry.js";

describe("Enhanced GitHub Tool (via ToolRegistry)", () => {
  let registry: ToolRegistry;

  const mockGuard = {
    authorize: vi.fn(async () => true),
    validateCommand: vi.fn(() => true),
    sanitize: vi.fn(() => ({ sanitized: "", redactions: [] })),
    detectInjection: vi.fn(() => ({ isClean: true, threats: [], riskScore: 0 })),
    wrapExternalData: vi.fn((data: string) => data),
    checkCost: vi.fn(() => true),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
  });

  it("github tool is registered", () => {
    const tool = registry.get("github");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("github");
  });

  it("github tool description includes new actions", () => {
    const tool = registry.get("github");
    expect(tool!.description).toContain("create_repo");
    expect(tool!.description).toContain("create_issue");
    expect(tool!.description).toContain("create_pr");
    expect(tool!.description).toContain("search_code");
    expect(tool!.description).toContain("clone");
  });

  it("gmail tool is registered (replacing gmail_check)", () => {
    const tool = registry.get("gmail");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("gmail");

    // Old gmail_check should not exist
    const oldTool = registry.get("gmail_check");
    expect(oldTool).toBeUndefined();
  });

  it("google_drive tool is registered", () => {
    const tool = registry.get("google_drive");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("google_drive");
  });

  it("create_repo requires name parameter", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "create_repo" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("name parameter required");
  });

  it("create_issue requires title parameter", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "create_issue" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("title parameter required");
  });

  it("create_pr requires title parameter", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "create_pr" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("title parameter required");
  });

  it("search_code requires query parameter", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "search_code" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("query parameter required");
  });

  it("clone requires repo parameter", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "clone" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("repo parameter required");
  });

  it("create_pr requires git_push authorization", async () => {
    mockGuard.authorize.mockResolvedValueOnce(false);
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "create_pr", title: "Test PR" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
    expect(mockGuard.authorize).toHaveBeenCalledWith("task-1", "git_push", "github:create_pr");
  });

  it("create_repo requires git_push authorization", async () => {
    mockGuard.authorize.mockResolvedValueOnce(false);
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "create_repo", name: "test-repo" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("unknown action returns error", async () => {
    const tool = registry.get("github")!;
    const result = await tool.execute(
      { action: "nonexistent" },
      "task-1",
      mockGuard as never,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown github action");
  });

  it("sanitizes shell arguments in repo name", async () => {
    const tool = registry.get("github")!;
    // This should sanitize the dangerous chars
    const result = await tool.execute(
      { action: "repo_status", repo: "owner/repo; rm -rf /" },
      "task-1",
      mockGuard as never,
    );
    // Command should execute with sanitized repo name (no semicolons)
    // The actual gh command will fail because gh isn't available in test,
    // but the key point is no injection occurred
    expect(result.error).not.toContain("rm -rf");
  });

  it("getDescriptions includes gmail and google_drive", () => {
    const desc = registry.getDescriptions();
    expect(desc).toContain("gmail");
    expect(desc).toContain("google_drive");
    expect(desc).not.toContain("gmail_check");
  });
});
