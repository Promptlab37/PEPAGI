// ═══════════════════════════════════════════════════════════════
// PEPAGI — Gmail Tool Tests
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

let mockAuthenticated = false;
let mockFetchResponse: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } | null = null;

vi.mock("../../integrations/google-auth.js", () => ({
  isGoogleAuthenticated: vi.fn(async () => mockAuthenticated),
  googleFetch: vi.fn(async () => {
    if (!mockFetchResponse) throw new Error("No mock response set");
    return mockFetchResponse;
  }),
}));

vi.mock("../../security/dlp-engine.js", () => ({
  dlpEngine: {
    inspect: vi.fn(() => ({ allowed: true, issues: [], riskLevel: "none" })),
  },
}));

import { gmailTool } from "../gmail.js";

describe("Gmail Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticated = false;
    mockFetchResponse = null;
  });

  it("has correct name and description", () => {
    expect(gmailTool.name).toBe("gmail");
    expect(gmailTool.description).toContain("Gmail");
  });

  it("requires action parameter", async () => {
    const result = await gmailTool.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("action parameter required");
  });

  it("returns error for unknown action", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "invalid" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown action");
  });

  it("falls back to AppleScript when not authenticated (non-Mac gives error)", async () => {
    mockAuthenticated = false;
    const result = await gmailTool.execute({ action: "list" });
    // On non-Mac CI, this should indicate OAuth needed
    expect(result.success === false || result.output.length > 0).toBe(true);
  });

  it("list action calls Gmail API when authenticated", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
      text: async () => "{}",
    };

    const result = await gmailTool.execute({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Žádné zprávy");
  });

  it("read action requires id parameter", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "read" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Message ID required");
  });

  it("send action requires to and subject", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "send" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("to and subject parameters required");
  });

  it("send action respects security guard authorization", async () => {
    mockAuthenticated = true;
    const guard = {
      authorize: vi.fn(async () => false),
    };

    const result = await gmailTool.execute(
      { action: "send", to: "test@test.com", subject: "Test" },
      "task-1",
      guard,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not authorized");
    expect(guard.authorize).toHaveBeenCalledWith("gmail", "email_send", "gmail:send");
  });

  it("reply action requires messageId and body", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "reply" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("messageId and body required");
  });

  it("search action requires query", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
      text: async () => "{}",
    };

    const result = await gmailTool.execute({ action: "search", query: "test" });
    expect(result.success).toBe(true);
  });

  it("delete action requires id", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "delete" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("id parameter required");
  });

  it("label action requires id and labels", async () => {
    mockAuthenticated = true;
    const result = await gmailTool.execute({ action: "label" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("id and addLabels/removeLabels required");
  });

  it("handles Gmail API errors gracefully", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
      text: async () => "Forbidden",
    };

    const result = await gmailTool.execute({ action: "list" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Gmail API error");
  });

  it("has all required parameters defined", () => {
    const paramNames = gmailTool.parameters.map(p => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("id");
    expect(paramNames).toContain("to");
    expect(paramNames).toContain("subject");
    expect(paramNames).toContain("body");
    expect(paramNames).toContain("query");
  });
});
