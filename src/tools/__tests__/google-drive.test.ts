// ═══════════════════════════════════════════════════════════════
// PEPAGI — Google Drive Tool Tests
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
let mockFetchResponse: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; headers: { get: (name: string) => string | null } } | null = null;

vi.mock("../../integrations/google-auth.js", () => ({
  isGoogleAuthenticated: vi.fn(async () => mockAuthenticated),
  googleFetch: vi.fn(async () => {
    if (!mockFetchResponse) throw new Error("No mock response set");
    return mockFetchResponse;
  }),
}));

vi.mock("../../security/path-validator.js", () => ({
  validatePath: vi.fn(async (p: string) => p),
  PathSecurityError: class PathSecurityError extends Error {
    rawPath: string;
    resolvedPath: string;
    toolName: string;
    constructor(message: string, rawPath: string, resolvedPath: string, toolName: string) {
      super(message);
      this.rawPath = rawPath;
      this.resolvedPath = resolvedPath;
      this.toolName = toolName;
    }
  },
}));

import { googleDriveTool } from "../google-drive.js";

describe("Google Drive Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticated = false;
    mockFetchResponse = null;
  });

  it("has correct name and description", () => {
    expect(googleDriveTool.name).toBe("google_drive");
    expect(googleDriveTool.description).toContain("Google Drive");
  });

  it("requires action parameter", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("action parameter required");
  });

  it("requires OAuth authentication", async () => {
    mockAuthenticated = false;
    const result = await googleDriveTool.execute({ action: "list" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("OAuth2 authentication");
  });

  it("returns error for unknown action", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "invalid" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown action");
  });

  it("list action returns files", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { id: "abc", name: "test.txt", mimeType: "text/plain", size: "1024", modifiedTime: "2026-01-01T00:00:00Z" },
        ],
      }),
      text: async () => "{}",
      headers: { get: () => null },
    };

    const result = await googleDriveTool.execute({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("test.txt");
    expect(result.output).toContain("abc");
  });

  it("list action handles empty results", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ files: [] }),
      text: async () => "{}",
      headers: { get: () => null },
    };

    const result = await googleDriveTool.execute({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No files found");
  });

  it("read action requires fileId", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "read" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("fileId parameter required");
  });

  it("create action requires name", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "create" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("name parameter required");
  });

  it("share action requires fileId and email", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "share" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("fileId and email parameters required");
  });

  it("search action requires query", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "search" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("query parameter required");
  });

  it("upload action requires filePath or content", async () => {
    mockAuthenticated = true;
    const result = await googleDriveTool.execute({ action: "upload" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Either filePath or content");
  });

  it("handles API errors gracefully", async () => {
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
      text: async () => "Forbidden",
      headers: { get: () => null },
    };

    const result = await googleDriveTool.execute({ action: "list" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Drive API error");
  });

  it("search calls API with correct query", async () => {
    const { googleFetch } = await import("../../integrations/google-auth.js");
    mockAuthenticated = true;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ files: [] }),
      text: async () => "{}",
      headers: { get: () => null },
    };

    await googleDriveTool.execute({ action: "search", query: "test doc" });
    expect(googleFetch).toHaveBeenCalledWith(expect.stringContaining("fullText"));
  });

  it("has all required parameters defined", () => {
    const paramNames = googleDriveTool.parameters.map(p => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("fileId");
    expect(paramNames).toContain("name");
    expect(paramNames).toContain("query");
    expect(paramNames).toContain("email");
  });
});
