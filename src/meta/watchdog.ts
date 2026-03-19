// ═══════════════════════════════════════════════════════════════
// PEPAGI — Watchdog Agent (Independent Supervisor)
// ═══════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { eventBus } from "../core/event-bus.js";
import type { TaskStore } from "../core/task-store.js";
import { Logger } from "../core/logger.js";
import { claudeCircuitBreaker } from "../agents/llm-provider.js";

const logger = new Logger("Watchdog");

interface WatchdogCheck {
  taskId: string;
  checkTime: Date;
  issues: string[];
}

// SECURITY: SEC-22 — Per-agent resource quotas
interface AgentQuota {
  tokens: number;
  toolCalls: number;
}

// SECURITY: SEC-22 — Approval request rate limiter
interface ApprovalRateState {
  timestamps: number[];
}

export class Watchdog {
  private checks: WatchdogCheck[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private actionHistory: Map<string, string[]> = new Map();
  // SECURITY: SEC-22 — Semantic loop detection: track recent outputs per task
  private outputHistory: Map<string, string[]> = new Map();
  // SECURITY: SEC-22 — Per-agent quotas per task
  private agentQuotas: Map<string, AgentQuota> = new Map();
  /** SEC-22: Max tokens per agent per task */
  private readonly maxTokensPerAgent = 500_000;
  /** SEC-22: Max tool calls per agent per task */
  private readonly maxToolCallsPerAgent = 50;
  // SECURITY: SEC-22 — Approval request rate limiter
  private approvalRate: ApprovalRateState = { timestamps: [] };
  /** SEC-22: Max approval requests per minute */
  private readonly maxApprovalsPerMinute = 3;

  constructor(
    private taskStore: TaskStore,
    private readonly checkIntervalMs = 300_000, // 5 minutes (was 30s)
    private readonly maxSameActions = 3,
  ) {}

  /** Start monitoring */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.runChecks(), this.checkIntervalMs);
    logger.info("Watchdog started");
  }

  /** Stop monitoring */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info("Watchdog stopped");
  }

  /** Record a mediator action for loop detection */
  recordAction(taskId: string, action: string): void {
    const history = this.actionHistory.get(taskId) ?? [];
    history.push(action);
    if (history.length > 20) history.shift();
    this.actionHistory.set(taskId, history);
  }

  // BUG-07: spawnSync blocks the Node.js event loop during claude CLI startup (1-3s)
  private checkClaudeAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("claude", ["auth", "status"], { timeout: 5000 });
      let output = "";
      proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      proc.on("close", (code) => {
        logger.info("Self-heal: claude auth status", { output: output.slice(0, 300) });
        const isAuthed =
          output.toLowerCase().includes("logged in") ||
          output.toLowerCase().includes("authenticated") ||
          output.toLowerCase().includes("signed in");
        resolve(code === 0 && isAuthed);
      });
      proc.on("error", () => resolve(false));
    });
  }

  /**
   * Attempt to self-heal Claude Code CLI.
   * Returns true if Claude appears healthy after the attempt.
   */
  private async attemptSelfHeal(): Promise<boolean> {
    // Check 1: is the `claude` binary reachable? (async — avoids blocking event loop)
    const whichFound = await new Promise<boolean>((resolve) => {
      const proc = spawn("which", ["claude"], { stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 5_000);
      proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (!whichFound) {
      logger.error("Self-heal: `claude` binary not found — nainstaluj Claude Code CLI");
      eventBus.emit({
        type: "system:alert",
        message: "🔴 PEPAGI self-heal: příkaz `claude` nenalezen. Nainstaluj Claude Code CLI.",
        level: "critical",
      });
      return false;
    }

    // Check 2: auth status (async — avoids blocking event loop for 1-3s)
    const isAuthed = await this.checkClaudeAuth();

    if (!isAuthed) {
      // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
      logger.warn("Self-heal: Claude Code is not authenticated — session expired");
      eventBus.emit({
        type: "system:alert",
        message:
          "🔴 PEPAGI self-heal: Claude Code session expirovala. " +
          "Přihlas se znovu: `claude auth login` (na Macu spusť terminál).",
        level: "critical",
      });
      return false;
    }

    // Auth looks OK — maybe it was a transient issue, reset the circuit breaker
    claudeCircuitBreaker.forceReset();
    logger.info("Self-heal: Claude auth OK — circuit breaker reset");
    return true;
  }

  /**
   * Check LLM health via circuit breaker failure count.
   * If too many failures → attempt self-heal and alert user.
   */
  private async checkLLMHealth(): Promise<void> {
    const recentFailures = claudeCircuitBreaker.getRecentFailureCount(600_000);
    const cbState = claudeCircuitBreaker.getState();

    if (cbState === "open" || recentFailures > 20) {
      logger.warn("LLM health: critical state", { recentFailures, cbState });
      const healed = await this.attemptSelfHeal();
      if (!healed) {
        eventBus.emit({
          type: "system:alert",
          message:
            `⚠️ PEPAGI: LLMProvider selhává — ${recentFailures} chyb za posledních 10 minut ` +
            `(circuit breaker: ${cbState}). Self-heal se nepodařil. Čekám na ruční zásah.`,
          level: "critical",
        });
        // Stop the watchdog interval to prevent zombie state
        this.stop();
        logger.error("Watchdog stopped — LLM is permanently unavailable, awaiting manual restart");
      }
    }
  }

  // ─── SEC-22: Semantic Loop Detection ──────────────────────

  /**
   * SECURITY: SEC-22 — Record worker output for semantic loop detection.
   * @param taskId - Task ID
   * @param output - Worker output text
   */
  recordOutput(taskId: string, output: string): void {
    const history = this.outputHistory.get(taskId) ?? [];
    // Store a normalized snippet (first 200 chars, lowercase, trimmed)
    history.push(output.slice(0, 200).toLowerCase().trim());
    if (history.length > 10) history.shift();
    this.outputHistory.set(taskId, history);
  }

  /**
   * SECURITY: SEC-22 — Detect semantic loops (repeated similar outputs).
   * Uses simple string similarity (Jaccard on word sets).
   * @param taskId - Task ID to check
   * @returns true if loop detected
   */
  detectSemanticLoop(taskId: string): boolean {
    const history = this.outputHistory.get(taskId) ?? [];
    if (history.length < 2) return false;

    const last = history[history.length - 1]!;
    const prev = history[history.length - 2]!;

    const wordsA = new Set(last.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(prev.split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    const similarity = intersection / union;

    // Similarity > 0.8 = semantically repeated output
    if (similarity > 0.8) {
      logger.warn("SEC-22: Semantic loop detected", { taskId, similarity: similarity.toFixed(2) });
      eventBus.emit({
        type: "meta:watchdog_alert",
        message: `SEC-22: Semantic loop detected for task ${taskId} (similarity=${similarity.toFixed(2)})`,
      });
      return true;
    }
    return false;
  }

  // ─── SEC-22: Per-Agent Resource Quotas ──────────────────

  /**
   * SECURITY: SEC-22 — Track agent resource usage per task.
   * @param taskId - Task ID
   * @param agentId - Agent provider name
   * @param tokens - Tokens used in this call
   * @param toolCalls - Number of tool calls in this step
   * @returns true if within quota, false if quota exceeded
   */
  trackAgentUsage(taskId: string, agentId: string, tokens: number, toolCalls: number): boolean {
    const key = `${taskId}:${agentId}`;
    const quota = this.agentQuotas.get(key) ?? { tokens: 0, toolCalls: 0 };
    quota.tokens += tokens;
    quota.toolCalls += toolCalls;
    this.agentQuotas.set(key, quota);

    if (quota.tokens > this.maxTokensPerAgent) {
      logger.warn("SEC-22: Agent token quota exceeded", { taskId, agentId, tokens: quota.tokens });
      eventBus.emit({
        type: "security:blocked",
        taskId,
        reason: `SEC-22: Agent ${agentId} exceeded token quota (${quota.tokens}/${this.maxTokensPerAgent})`,
      });
      return false;
    }

    if (quota.toolCalls > this.maxToolCallsPerAgent) {
      logger.warn("SEC-22: Agent tool call quota exceeded", { taskId, agentId, toolCalls: quota.toolCalls });
      eventBus.emit({
        type: "security:blocked",
        taskId,
        reason: `SEC-22: Agent ${agentId} exceeded tool call quota (${quota.toolCalls}/${this.maxToolCallsPerAgent})`,
      });
      return false;
    }

    return true;
  }

  /** SEC-22: Get current agent quota usage */
  getAgentQuota(taskId: string, agentId: string): AgentQuota {
    return this.agentQuotas.get(`${taskId}:${agentId}`) ?? { tokens: 0, toolCalls: 0 };
  }

  // ─── SEC-22: Approval Rate Limiter ──────────────────────

  /**
   * SECURITY: SEC-22 — Rate-limit approval requests to prevent HITL overwhelm.
   * @returns true if approval request is allowed
   */
  checkApprovalRate(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    this.approvalRate.timestamps = this.approvalRate.timestamps.filter(t => t >= oneMinuteAgo);
    if (this.approvalRate.timestamps.length >= this.maxApprovalsPerMinute) {
      logger.warn("SEC-22: Approval rate limit exceeded");
      return false;
    }
    this.approvalRate.timestamps.push(now);
    return true;
  }

  /** Run all watchdog checks */
  private async runChecks(): Promise<void> {
    const tasks = this.taskStore.getAll().filter(t => t.status === "running" || t.status === "waiting_subtasks");

    for (const task of tasks) {
      const issues: string[] = [];

      // Check 1: Infinite loop detection
      const history = this.actionHistory.get(task.id) ?? [];
      if (history.length >= this.maxSameActions) {
        const last = history.slice(-this.maxSameActions);
        if (last.every(a => a === last[0])) {
          issues.push(`Infinite loop detected: "${last[0]}" repeated ${this.maxSameActions} times`);
        }
      }

      // Check 2: Stagnation (no progress in last few checks)
      const prevChecks = this.checks.filter(c => c.taskId === task.id).slice(-3);
      if (prevChecks.length >= 3 && task.status === "running") {
        const timeSinceStart = task.startedAt
          ? (Date.now() - task.startedAt.getTime()) / 1000 / 60
          : 0;
        if (timeSinceStart > 5) {
          issues.push(`Task running for ${timeSinceStart.toFixed(1)} minutes without completion`);
        }
      }

      // Check 3: Too many attempts
      if (task.attempts >= task.maxAttempts) {
        issues.push(`Task at max attempts (${task.attempts}/${task.maxAttempts})`);
      }

      if (issues.length > 0) {
        logger.warn("Watchdog alert", { taskId: task.id, issues });
        eventBus.emit({
          type: "meta:watchdog_alert",
          message: `Task ${task.id} (${task.title}): ${issues.join("; ")}`,
        });
      }

      this.checks.push({ taskId: task.id, checkTime: new Date(), issues });
    }

    // Cleanup old checks
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.checks = this.checks.filter(c => c.checkTime.getTime() > cutoff);

    // Cleanup actionHistory for completed/non-running tasks to prevent unbounded growth
    const runningTaskIds = new Set(tasks.map(t => t.id));
    for (const taskId of this.actionHistory.keys()) {
      if (!runningTaskIds.has(taskId)) {
        this.actionHistory.delete(taskId);
      }
    }

    // Check LLM health (circuit breaker state + recent failure count)
    await this.checkLLMHealth();
  }

  /** Get check history for a task */
  getHistory(taskId: string): WatchdogCheck[] {
    return this.checks.filter(c => c.taskId === taskId);
  }
}
