// ═══════════════════════════════════════════════════════════════
// PEPAGI — Cost Tracker (SEC-13)
// Per-user cost tracking, decomposition caps, cost persistence,
// emergency degraded mode, per-minute rate limiting.
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("CostTracker");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const COSTS_PATH = join(PEPAGI_DATA_DIR, "costs.json");

// SECURITY: SEC-13 — Decomposition limits
/** Maximum decomposition depth (parent → child → grandchild = 3 levels) */
export const MAX_DECOMPOSITION_DEPTH = 3;
/** Maximum subtasks per parent task */
export const MAX_SUBTASKS_PER_PARENT = 10;

// SECURITY: SEC-13 — Default per-user daily limit ($5)
const DEFAULT_DAILY_LIMIT_USD = 5.0;
// SECURITY: SEC-13 — Default per-minute LLM call limit
const DEFAULT_MAX_CALLS_PER_MINUTE = 20;
// SECURITY: SEC-13 — Emergency degraded mode threshold (80%)
const DEGRADED_MODE_THRESHOLD = 0.8;

interface UserCostEntry {
  userId: string;
  date: string;       // YYYY-MM-DD
  totalCost: number;
  callCount: number;
}

interface CostStore {
  entries: UserCostEntry[];
  lastSaved: string;
}

export class CostTracker {
  private userCosts: Map<string, UserCostEntry> = new Map();
  private callTimestamps: number[] = [];
  private degradedMode = false;
  private dailyLimit: number;
  private maxCallsPerMinute: number;

  constructor(
    dailyLimitUsd = DEFAULT_DAILY_LIMIT_USD,
    maxCallsPerMinute = DEFAULT_MAX_CALLS_PER_MINUTE,
  ) {
    this.dailyLimit = dailyLimitUsd;
    this.maxCallsPerMinute = maxCallsPerMinute;
  }

  /**
   * SECURITY: SEC-13 — Load persisted cost data from disk.
   * Only loads today's entries (older entries are ignored).
   */
  async load(): Promise<void> {
    try {
      const raw = await readFile(COSTS_PATH, "utf8");
      const store = JSON.parse(raw) as CostStore;
      const today = this.todayStr();
      for (const entry of store.entries) {
        if (entry.date === today) {
          this.userCosts.set(entry.userId, entry);
        }
      }
      logger.debug("SEC-13: Cost data loaded", { entries: this.userCosts.size });
    } catch {
      // No saved costs — start fresh
    }
  }

  /**
   * SECURITY: SEC-13 — Persist current cost data to disk.
   */
  async save(): Promise<void> {
    const store: CostStore = {
      entries: [...this.userCosts.values()],
      lastSaved: new Date().toISOString(),
    };
    await mkdir(PEPAGI_DATA_DIR, { recursive: true });
    const tmp = `${COSTS_PATH}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await rename(tmp, COSTS_PATH);
  }

  /**
   * SECURITY: SEC-13 — Record cost for a user.
   * @returns false if cost exceeds daily limit
   */
  recordCost(userId: string, cost: number): boolean {
    const today = this.todayStr();
    let entry = this.userCosts.get(userId);

    if (!entry || entry.date !== today) {
      entry = { userId, date: today, totalCost: 0, callCount: 0 };
      this.userCosts.set(userId, entry);
    }

    entry.totalCost += cost;
    entry.callCount += 1;

    // Check daily limit
    if (entry.totalCost >= this.dailyLimit) {
      logger.warn("SEC-13: User daily cost limit exceeded", {
        userId: userId.slice(0, 8),
        cost: entry.totalCost.toFixed(4),
        limit: this.dailyLimit,
      });
      eventBus.emit({
        type: "security:blocked",
        taskId: "cost-tracker",
        reason: `SEC-13: User daily cost limit exceeded ($${entry.totalCost.toFixed(2)}/$${this.dailyLimit})`,
      });
      return false;
    }

    // Check 80% warning
    if (entry.totalCost >= this.dailyLimit * DEGRADED_MODE_THRESHOLD && !this.degradedMode) {
      this.degradedMode = true;
      logger.warn("SEC-13: Entering degraded mode (80% budget)", {
        userId: userId.slice(0, 8),
        cost: entry.totalCost.toFixed(4),
      });
      eventBus.emit({
        type: "system:cost_warning",
        currentCost: entry.totalCost,
        limit: this.dailyLimit,
      });
    }

    // Persist periodically (every 10 calls)
    if (entry.callCount % 10 === 0) {
      // FIX: log save failures instead of silent swallow
      this.save().catch(e => logger.debug("Cost data save failed", { error: String(e) }));
    }

    return true;
  }

  /**
   * SECURITY: SEC-13 — Per-minute LLM call rate limiter.
   * @returns true if call is allowed
   */
  checkCallRate(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    this.callTimestamps = this.callTimestamps.filter(t => t >= oneMinuteAgo);

    if (this.callTimestamps.length >= this.maxCallsPerMinute) {
      logger.warn("SEC-13: Per-minute call rate exceeded", {
        calls: this.callTimestamps.length,
        max: this.maxCallsPerMinute,
      });
      return false;
    }

    this.callTimestamps.push(now);
    return true;
  }

  /**
   * SECURITY: SEC-13 — Validate decomposition depth.
   * @param currentDepth - Current decomposition depth
   * @returns true if decomposition is allowed
   */
  checkDecompositionDepth(currentDepth: number): boolean {
    if (currentDepth >= MAX_DECOMPOSITION_DEPTH) {
      logger.warn("SEC-13: Decomposition depth limit reached", {
        depth: currentDepth,
        max: MAX_DECOMPOSITION_DEPTH,
      });
      return false;
    }
    return true;
  }

  /**
   * SECURITY: SEC-13 — Validate subtask count.
   * @param subtaskCount - Number of subtasks being created
   * @returns true if subtask count is within limit
   */
  checkSubtaskCount(subtaskCount: number): boolean {
    if (subtaskCount > MAX_SUBTASKS_PER_PARENT) {
      logger.warn("SEC-13: Subtask count limit exceeded", {
        count: subtaskCount,
        max: MAX_SUBTASKS_PER_PARENT,
      });
      return false;
    }
    return true;
  }

  /** Get user's cost for today */
  getUserCost(userId: string): number {
    const entry = this.userCosts.get(userId);
    if (!entry || entry.date !== this.todayStr()) return 0;
    return entry.totalCost;
  }

  /** Check if in degraded mode */
  isDegraded(): boolean {
    return this.degradedMode;
  }

  /** Reset degraded mode (e.g. on new day) */
  resetDegradedMode(): void {
    this.degradedMode = false;
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Singleton instance */
export const costTracker = new CostTracker();
