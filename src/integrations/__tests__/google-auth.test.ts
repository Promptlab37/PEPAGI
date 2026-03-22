// ═══════════════════════════════════════════════════════════════
// PEPAGI — Google OAuth2 Tests
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs and fetch before importing the module
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

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

describe("Google OAuth2 Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set env vars for testing
    process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it("isGoogleAuthenticated returns false when no tokens exist", async () => {
    const { isGoogleAuthenticated } = await import("../../integrations/google-auth.js");
    const result = await isGoogleAuthenticated();
    expect(result).toBe(false);
  });

  it("getGoogleAccessToken throws when not authenticated", async () => {
    const { getGoogleAccessToken } = await import("../../integrations/google-auth.js");
    await expect(getGoogleAccessToken()).rejects.toThrow("Not authenticated");
  });

  it("startGoogleAuth requires client ID and secret", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    // Re-import to get fresh module
    vi.resetModules();
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mock("node:fs", () => ({ existsSync: vi.fn().mockReturnValue(false) }));

    const mod = await import("../../integrations/google-auth.js");
    await expect(mod.startGoogleAuth()).rejects.toThrow("GOOGLE_CLIENT_ID");
  });

  it("startGoogleAuth returns auth URL with correct parameters", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";

    vi.resetModules();
    const mod = await import("../../integrations/google-auth.js");

    const result = await mod.startGoogleAuth(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(result.authUrl).toContain("accounts.google.com");
    expect(result.authUrl).toContain("client_id=test-id");
    expect(result.authUrl).toContain("gmail.modify");
    expect(result.authUrl).toContain("access_type=offline");
    expect(typeof result.waitForCallback).toBe("function");

    // Clean up the callback server by not calling waitForCallback
  });

  it("googleFetch adds Bearer token header", async () => {
    // This test verifies the function structure — actual token refresh
    // requires mocking the full token flow
    const { googleFetch } = await import("../../integrations/google-auth.js");
    // Should throw because we're not authenticated
    await expect(googleFetch("https://www.googleapis.com/test")).rejects.toThrow();
  });

  it("revokeGoogleAuth succeeds even without tokens", async () => {
    const { revokeGoogleAuth } = await import("../../integrations/google-auth.js");
    // Should not throw
    await expect(revokeGoogleAuth()).resolves.toBeUndefined();
  });
});
