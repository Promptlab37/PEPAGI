// ═══════════════════════════════════════════════════════════════
// Tests: Rate Limiter (SEC-30)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter SEC-30", () => {
  it("allows requests under the limit", () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.isRateLimited("user-1")).toBe(false);
    }
  });

  it("blocks requests over the limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.isRateLimited("user-1")).toBe(false); // 1
    expect(limiter.isRateLimited("user-1")).toBe(false); // 2
    expect(limiter.isRateLimited("user-1")).toBe(false); // 3
    expect(limiter.isRateLimited("user-1")).toBe(true);  // 4 — blocked
  });

  it("tracks users independently", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.isRateLimited("user-A")).toBe(false);
    expect(limiter.isRateLimited("user-A")).toBe(false);
    expect(limiter.isRateLimited("user-A")).toBe(true); // A blocked
    expect(limiter.isRateLimited("user-B")).toBe(false); // B still ok
  });

  it("reports correct remaining requests", () => {
    const limiter = new RateLimiter(5, 60_000);
    expect(limiter.getRemaining("user-1")).toBe(5);
    limiter.isRateLimited("user-1");
    expect(limiter.getRemaining("user-1")).toBe(4);
  });

  it("reports max remaining for unknown user", () => {
    const limiter = new RateLimiter(10, 60_000);
    expect(limiter.getRemaining("unknown")).toBe(10);
  });
});
