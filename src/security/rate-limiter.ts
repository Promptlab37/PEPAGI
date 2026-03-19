// ═══════════════════════════════════════════════════════════════
// PEPAGI — Per-User Rate Limiter (SEC-30)
// Reusable rate limiter for messaging platforms.
// Prevents message flooding from individual users.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("RateLimiter");

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * SECURITY: SEC-30 — Per-user rate limiter for messaging platforms.
 * Uses a sliding window approach to limit requests per user.
 */
export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  /**
   * @param maxRequests - Maximum requests per window
   * @param windowMs - Window duration in milliseconds
   * @param name - Limiter name for logging
   */
  constructor(
    private readonly maxRequests: number = 20,
    private readonly windowMs: number = 60_000,
    private readonly name: string = "default",
  ) {}

  /**
   * Check if a user has exceeded their rate limit.
   * Automatically increments the counter.
   *
   * @param userId - User identifier (numeric ID, snowflake, phone number)
   * @returns true if rate-limited (should block), false if allowed
   */
  isRateLimited(userId: string): boolean {
    const now = Date.now();

    // Periodic eviction to prevent unbounded growth
    if (this.entries.size > 500) {
      for (const [k, v] of this.entries) {
        if (now - v.windowStart >= this.windowMs) this.entries.delete(k);
      }
    }

    const entry = this.entries.get(userId);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(userId, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;

    if (entry.count > this.maxRequests) {
      logger.warn(`Rate limit exceeded (${this.name})`, {
        userId,
        count: entry.count,
        max: this.maxRequests,
      });
      return true;
    }

    return false;
  }

  /** Get remaining requests for a user in the current window */
  getRemaining(userId: string): number {
    const entry = this.entries.get(userId);
    if (!entry || Date.now() - entry.windowStart >= this.windowMs) {
      return this.maxRequests;
    }
    return Math.max(0, this.maxRequests - entry.count);
  }
}
