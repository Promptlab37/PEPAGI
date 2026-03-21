// ═══════════════════════════════════════════════════════════════
// PEPAGI — Self-Healer (L3 AI Emergency Recovery)
// Autonomous diagnostics and repair with safety guardrails.
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, appendFile, mkdir, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { eventBus } from "../core/event-bus.js";
import { Logger } from "../core/logger.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { claudeCircuitBreaker } from "../agents/llm-provider.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { TaskStore } from "../core/task-store.js";
import type { SecurityGuard } from "../security/security-guard.js";
import type { PepagiConfig } from "../config/loader.js";
import type { PepagiEvent } from "../core/types.js";

const logger = new Logger("SelfHealer");

// ─── Types ──────────────────────────────────────────────────

export interface HealContext {
  trigger: "task:failed" | "meta:watchdog_alert" | "system:alert";
  message: string;
  taskId?: string;
  timestamp: number;
}

export interface Diagnosis {
  problem: string;
  suggestedTier: 1 | 2 | 3;
  suggestedAction: string;
  affectedFiles?: string[];
  confidence: number;
}

export interface HealResult {
  tier: number;
  success: boolean;
  action: string;
  details: string;
  timestamp: number;
}

interface HealLogEntry {
  timestamp: string;
  tier: number;
  trigger: string;
  diagnosis: string;
  action: string;
  success: boolean;
  details: string;
  costUsd?: number;
}

// ─── Constants ──────────────────────────────────────────────

/** Files that must never be modified by self-heal code fixes — ALL security module files */
const PROTECTED_FILES = new Set([
  "agent-authenticator.ts",
  "audit-log.ts",
  "compliance-map.ts",
  "context-boundary.ts",
  "cost-tracker.ts",
  "credential-lifecycle.ts",
  "credential-scrubber.ts",
  "dlp-engine.ts",
  "drift-detector.ts",
  "incident-response.ts",
  "input-sanitizer.ts",
  "memory-guard.ts",
  "output-sanitizer.ts",
  "path-validator.ts",
  "policy-anchor.ts",
  "rate-limiter.ts",
  "reasoning-monitor.ts",
  "safe-fs.ts",
  "security-guard.ts",
  "side-channel.ts",
  "supply-chain.ts",
  "task-content-guard.ts",
  "tls-verifier.ts",
  "tool-guard.ts",
  "tripwire.ts",
]);

const HEAL_LOG_FILE = join(PEPAGI_DATA_DIR, "self-heal.jsonl");

// ─── SelfHealer ─────────────────────────────────────────────

export class SelfHealer {
  private healAttempts: Array<{ ts: number; tier: number; success: boolean }> = [];
  private cooldownUntil = 0;
  private handler: ((e: PepagiEvent) => void) | null = null;
  /** Track consecutive task failures — only trigger heal after threshold */
  private consecutiveTaskFailures = 0;
  private lastTaskFailureTs = 0;
  /** Minimum consecutive task failures before self-healer activates (prevents reacting to normal failures) */
  private static readonly TASK_FAILURE_THRESHOLD = 5;
  /** Reset failure counter if gap between failures exceeds this (ms) */
  private static readonly FAILURE_WINDOW_MS = 120_000; // 2 min

  constructor(
    private llm: LLMProvider,
    private taskStore: TaskStore,
    private guard: SecurityGuard,
    private config: PepagiConfig,
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────

  /** Register event listeners to trigger self-healing */
  start(): void {
    if (!this.config.selfHealing?.enabled) {
      logger.info("Self-healing disabled in config");
      return;
    }
    if (this.handler) return; // already started

    this.handler = (event: PepagiEvent) => {
      if (event.type === "task:failed") {
        // Don't trigger on every single task failure — track consecutive failures
        // and only activate after hitting the threshold. This prevents the self-healer
        // from restarting the daemon when a few subtasks fail (normal operation).
        const now = Date.now();
        if (now - this.lastTaskFailureTs > SelfHealer.FAILURE_WINDOW_MS) {
          this.consecutiveTaskFailures = 0; // reset if gap too large
        }
        this.lastTaskFailureTs = now;
        this.consecutiveTaskFailures++;
        if (this.consecutiveTaskFailures < SelfHealer.TASK_FAILURE_THRESHOLD) {
          logger.debug("Task failure tracked but below threshold", {
            consecutive: this.consecutiveTaskFailures,
            threshold: SelfHealer.TASK_FAILURE_THRESHOLD,
          });
          return;
        }
        // Reset counter after triggering
        this.consecutiveTaskFailures = 0;
        void this.onTrigger({ trigger: "task:failed", message: event.error, taskId: event.taskId, timestamp: now });
      } else if (event.type === "meta:watchdog_alert") {
        void this.onTrigger({ trigger: "meta:watchdog_alert", message: event.message, timestamp: Date.now() });
      } else if (event.type === "system:alert" && event.level === "critical") {
        void this.onTrigger({ trigger: "system:alert", message: event.message, timestamp: Date.now() });
      }
    };
    eventBus.onAny(this.handler);
    logger.info("Self-healer started", { tier2: this.config.selfHealing?.allowCodeFixes ? "enabled" : "disabled" });
  }

  /** Remove event listener */
  stop(): void {
    if (this.handler) {
      eventBus.offAny(this.handler);
      this.handler = null;
      logger.info("Self-healer stopped");
    }
  }

  // ─── Safety Checks ─────────────────────────────────────

  /** Check rate limit (max N per hour) and cooldown */
  canAttemptHeal(): boolean {
    const now = Date.now();
    const maxPerHour = this.config.selfHealing?.maxAttemptsPerHour ?? 3;
    const cooldownMs = this.config.selfHealing?.cooldownMs ?? 300_000;

    // Cooldown check
    if (now < this.cooldownUntil) {
      const remainingSec = Math.ceil((this.cooldownUntil - now) / 1000);
      logger.debug("Heal attempt blocked by cooldown", { remainingSec });
      return false;
    }

    // Rate limit: count attempts in the last hour
    const oneHourAgo = now - 3_600_000;
    const recentAttempts = this.healAttempts.filter(a => a.ts >= oneHourAgo);
    if (recentAttempts.length >= maxPerHour) {
      logger.warn("Heal rate limit reached", { attempts: recentAttempts.length, maxPerHour });
      return false;
    }

    // Set cooldown — actual rate-limit entry is recorded by recordAttempt() after the heal runs
    this.cooldownUntil = now + cooldownMs;
    return true;
  }

  /** Check if a file path is in the protected set */
  isProtectedFile(filePath: string): boolean {
    const basename = filePath.split("/").pop() ?? "";
    return PROTECTED_FILES.has(basename);
  }

  // ─── Event Handler ─────────────────────────────────────

  private async onTrigger(ctx: HealContext): Promise<void> {
    if (!this.canAttemptHeal()) return;

    try {
      // Diagnose
      const diagnosis = await this.diagnose(ctx);
      eventBus.emit({ type: "self-heal:attempt", tier: diagnosis.suggestedTier, diagnosis: diagnosis.problem, taskId: ctx.taskId });

      // Tier 1 (never start with restart_daemon — try safer actions first)
      let effectiveDiagnosis = diagnosis;
      if (diagnosis.suggestedAction === "restart_daemon") {
        // Downgrade to kill_stuck_tasks first — restart_daemon is too aggressive as first action
        effectiveDiagnosis = { ...diagnosis, suggestedAction: "kill_stuck_tasks" };
      }
      const t1Result = await this.healTier1(effectiveDiagnosis);
      this.recordAttempt(1, t1Result.success);
      await this.persistLog({ tier: 1, trigger: ctx.trigger, diagnosis: effectiveDiagnosis.problem, action: t1Result.action, success: t1Result.success, details: t1Result.details });

      if (t1Result.success) {
        eventBus.emit({ type: "self-heal:success", tier: 1, action: t1Result.action });
        return;
      }

      // Tier 2 (only if allowed)
      if (this.config.selfHealing?.allowCodeFixes) {
        const t2Result = await this.healTier2(diagnosis);
        this.recordAttempt(2, t2Result.success);
        await this.persistLog({ tier: 2, trigger: ctx.trigger, diagnosis: diagnosis.problem, action: t2Result.action, success: t2Result.success, details: t2Result.details });

        if (t2Result.success) {
          eventBus.emit({ type: "self-heal:success", tier: 2, action: t2Result.action });
          return;
        }
      }

      // Tier 3: escalate to human
      await this.escalate(diagnosis, [t1Result]);
      eventBus.emit({ type: "self-heal:failed", tier: 3, reason: "All automated recovery tiers exhausted" });
    } catch (err) {
      logger.error("Self-heal process failed", { error: String(err) });
      eventBus.emit({ type: "self-heal:failed", tier: 0, reason: String(err) });
    }
  }

  // ─── Diagnostics (read-only, cheap model) ───────────────

  async diagnose(ctx: HealContext): Promise<Diagnosis> {
    const recentErrors = await this.readRecentErrors(Date.now() - 600_000); // last 10 min
    const recentLogs = await this.readRecentLogs(50);

    // Check simple patterns first (no LLM needed)
    const simpleDiag = this.quickDiagnose(ctx, recentErrors);
    if (simpleDiag) return simpleDiag;

    // Use cheap LLM for complex diagnosis
    try {
      const costCap = this.config.selfHealing?.costCapPerAttempt ?? 0.50;
      const prompt = `You are a diagnostic agent for the PEPAGI system. Analyze the following error context and suggest a recovery action.

TRIGGER: ${ctx.trigger}
MESSAGE: ${ctx.message}
${ctx.taskId ? `TASK ID: ${ctx.taskId}` : ""}

RECENT ERRORS (last 10 min):
${recentErrors.slice(0, 5).join("\n")}

RECENT LOG LINES:
${recentLogs}

Respond in JSON:
{
  "problem": "short description of root cause",
  "suggestedTier": 1 or 2,
  "suggestedAction": "specific action to take",
  "affectedFiles": ["file.ts"] or [],
  "confidence": 0.0 to 1.0
}

Tier 1 actions: reset_circuit_breaker, kill_stuck_tasks, repair_config, restart_daemon, repair_memory, force_gc
Tier 2 actions: code_fix (only if tier 1 won't help)

Cost budget: $${costCap}. Be conservative — prefer Tier 1.`;

      const resp = await this.llm.quickCall(
        "You are a system diagnostics agent. Respond only with valid JSON.",
        prompt,
        undefined,
        true,
      );

      const parsed = JSON.parse(resp.content) as Diagnosis;
      // Clamp tier to valid range
      if (parsed.suggestedTier < 1 || parsed.suggestedTier > 2) parsed.suggestedTier = 1;
      if (parsed.confidence < 0 || parsed.confidence > 1) parsed.confidence = 0.5;
      return parsed;
    } catch {
      // Fallback: if LLM fails, return generic Tier 1 diagnosis
      return {
        problem: ctx.message,
        suggestedTier: 1,
        suggestedAction: "reset_circuit_breaker",
        confidence: 0.3,
      };
    }
  }

  /** Fast pattern-matching diagnosis without LLM call */
  private quickDiagnose(ctx: HealContext, recentErrors: string[]): Diagnosis | null {
    const msg = ctx.message.toLowerCase();

    if (msg.includes("circuit breaker") || msg.includes("circuit_breaker")) {
      return { problem: "Circuit breaker open", suggestedTier: 1, suggestedAction: "reset_circuit_breaker", confidence: 0.9 };
    }
    if (msg.includes("rate limit") || msg.includes("429")) {
      return { problem: "LLM rate limit hit", suggestedTier: 1, suggestedAction: "reset_circuit_breaker", confidence: 0.8 };
    }
    if (msg.includes("stuck") || msg.includes("stagnation") || msg.includes("timeout")) {
      return { problem: "Task stuck or timed out", suggestedTier: 1, suggestedAction: "kill_stuck_tasks", confidence: 0.8 };
    }
    if (msg.includes("config") && (msg.includes("corrupt") || msg.includes("invalid") || msg.includes("parse"))) {
      return { problem: "Config file corrupted", suggestedTier: 1, suggestedAction: "repair_config", confidence: 0.85 };
    }
    if (msg.includes("heap") || msg.includes("memory") || msg.includes("oom")) {
      return { problem: "Memory pressure / OOM risk", suggestedTier: 1, suggestedAction: "force_gc", confidence: 0.7 };
    }

    // Check if many recent errors share a pattern (systemic failure)
    // Threshold is high because normal task failures (worker fallback chain trying
    // 3-4 providers) can easily generate 10+ error entries per task.
    if (recentErrors.length > 20) {
      return { problem: `Systemic failure: ${recentErrors.length} errors in 10 min`, suggestedTier: 1, suggestedAction: "kill_stuck_tasks", confidence: 0.6 };
    }

    return null;
  }

  // ─── Tier 1: Infrastructure Healing (automatic, safe) ────

  async healTier1(diagnosis: Diagnosis): Promise<HealResult> {
    const action = diagnosis.suggestedAction;
    const now = Date.now();

    try {
      switch (action) {
        case "reset_circuit_breaker": {
          claudeCircuitBreaker.forceReset();
          logger.info("Tier 1: Circuit breaker reset");
          return { tier: 1, success: true, action, details: "Circuit breaker reset to closed state", timestamp: now };
        }

        case "kill_stuck_tasks": {
          const stuck = this.taskStore.getAll().filter(t =>
            t.status === "running" && t.startedAt && (now - t.startedAt.getTime()) > 600_000, // 10 min
          );
          for (const task of stuck) {
            this.taskStore.fail(task.id, "Killed by self-healer: stuck > 10 min");
          }
          const count = stuck.length;
          logger.info(`Tier 1: Killed ${count} stuck tasks`);
          return { tier: 1, success: count > 0, action, details: `Killed ${count} stuck tasks`, timestamp: now };
        }

        case "repair_config": {
          const configPath = join(PEPAGI_DATA_DIR, "config.json");
          if (existsSync(configPath)) {
            try {
              const raw = await readFile(configPath, "utf8");
              JSON.parse(raw); // test if valid JSON
              return { tier: 1, success: true, action, details: "Config is valid JSON — no repair needed", timestamp: now };
            } catch {
              // Config is corrupted — back it up and try to preserve API keys
              const backupPath = `${configPath}.bak.${now}`;
              try {
                await rename(configPath, backupPath);
              } catch { /* ignore */ }
              logger.warn("Tier 1: Config corrupted — backed up and will use defaults on next load");
              return { tier: 1, success: true, action, details: `Config backed up to ${backupPath} — defaults will be used`, timestamp: now };
            }
          }
          return { tier: 1, success: true, action, details: "No config file found — defaults will be used", timestamp: now };
        }

        case "force_gc": {
          const gc = (globalThis as unknown as { gc?: () => void }).gc;
          if (gc) {
            gc();
            logger.info("Tier 1: Forced garbage collection");
          }
          // Also kill heavy tasks
          const heavyTasks = this.taskStore.getAll().filter(t =>
            t.status === "running" && t.tokensUsed.input + t.tokensUsed.output > 200_000,
          );
          for (const task of heavyTasks) {
            this.taskStore.fail(task.id, "Killed by self-healer: high token usage under memory pressure");
          }
          return { tier: 1, success: true, action, details: `GC triggered, killed ${heavyTasks.length} heavy tasks`, timestamp: now };
        }

        case "repair_memory": {
          const memDir = join(PEPAGI_DATA_DIR, "memory");
          if (!existsSync(memDir)) {
            await mkdir(memDir, { recursive: true });
            return { tier: 1, success: true, action, details: "Memory directory recreated", timestamp: now };
          }
          // Check each JSONL file — rename corrupted ones to .bak
          const files = await readdir(memDir);
          let repaired = 0;
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = join(memDir, file);
            try {
              const content = await readFile(filePath, "utf8");
              // Validate each line is valid JSON
              for (const line of content.split("\n").filter(l => l.trim())) {
                JSON.parse(line);
              }
            } catch {
              await rename(filePath, `${filePath}.bak.${now}`).catch(() => {});
              repaired++;
            }
          }
          logger.info(`Tier 1: Memory repair — ${repaired} files backed up`);
          return { tier: 1, success: true, action, details: `${repaired} corrupted memory files backed up`, timestamp: now };
        }

        case "restart_daemon": {
          logger.warn("Tier 1: Requesting daemon restart via process.exit(1)");
          // Stop self-healer first to prevent re-entrant trigger from the critical alert below
          this.stop();
          // Emit alert before exit so platforms can notify user
          eventBus.emit({ type: "system:alert", message: "Self-healer: restarting daemon due to systemic failure", level: "critical" });
          // Give event handlers time to process
          await new Promise(resolve => setTimeout(resolve, 2000));
          process.exit(1); // LaunchAgent / systemd will restart
          // unreachable — but satisfies TypeScript
          return { tier: 1, success: true, action, details: "Daemon restart initiated", timestamp: now };
        }

        default:
          return { tier: 1, success: false, action, details: `Unknown Tier 1 action: ${action}`, timestamp: now };
      }
    } catch (err) {
      logger.error("Tier 1 heal failed", { action, error: String(err) });
      return { tier: 1, success: false, action, details: String(err), timestamp: now };
    }
  }

  // ─── Tier 2: Code Healing (isolated, with tests) ────────

  async healTier2(diagnosis: Diagnosis): Promise<HealResult> {
    const now = Date.now();
    const branchName = `self-heal/${now}`;

    // Verify we're in a git repo
    try {
      execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe", cwd: process.cwd() });
    } catch {
      return { tier: 2, success: false, action: "code_fix", details: "Not in a git repository — cannot create heal branch", timestamp: now };
    }

    // Check protected files
    if (diagnosis.affectedFiles?.some(f => this.isProtectedFile(f))) {
      return { tier: 2, success: false, action: "code_fix", details: "Affected files include protected security files — refusing code fix", timestamp: now };
    }

    try {
      // 1. Create branch
      execSync(`git checkout -b ${branchName}`, { stdio: "pipe", cwd: process.cwd() });

      // 2. Ask LLM for fix
      const fileContents: string[] = [];
      for (const file of diagnosis.affectedFiles ?? []) {
        if (this.isProtectedFile(file)) continue;
        try {
          const content = await readFile(join(process.cwd(), file), "utf8");
          fileContents.push(`--- ${file} ---\n${content.slice(0, 3000)}`);
        } catch { /* file may not exist */ }
      }

      const fixPrompt = `You are a code repair agent. Fix the following issue:

PROBLEM: ${diagnosis.problem}
ACTION: ${diagnosis.suggestedAction}

${fileContents.length > 0 ? `AFFECTED FILES:\n${fileContents.join("\n\n")}` : "No specific files identified."}

Respond with a JSON array of file edits:
[
  {
    "file": "src/path/to/file.ts",
    "search": "exact string to find",
    "replace": "replacement string"
  }
]

Rules:
- Minimal changes only — fix the specific bug.
- Do NOT modify security files (security-guard.ts, tripwire.ts, audit-log.ts, dlp-engine.ts).
- Respond ONLY with the JSON array.`;

      const resp = await this.llm.quickCall(
        "You are a surgical code repair agent. Respond only with a JSON array of edits.",
        fixPrompt,
        undefined,
        true,
      );

      const edits = JSON.parse(resp.content) as Array<{ file: string; search: string; replace: string }>;

      // 3. Validate and apply edits
      for (const edit of edits) {
        if (this.isProtectedFile(edit.file)) {
          logger.warn("Tier 2: Skipping protected file", { file: edit.file });
          continue;
        }
        const filePath = join(process.cwd(), edit.file);
        if (!existsSync(filePath)) continue;
        const content = await readFile(filePath, "utf8");
        if (!content.includes(edit.search)) {
          logger.warn("Tier 2: Search string not found in file", { file: edit.file });
          continue;
        }
        await writeFile(filePath, content.replace(edit.search, edit.replace), "utf8");
      }

      // 4. Run tsc
      try {
        execSync("npx tsc --noEmit", { stdio: "pipe", cwd: process.cwd(), timeout: 60_000 });
      } catch (err) {
        logger.warn("Tier 2: TypeScript check failed — rolling back", { error: String(err) });
        this.rollbackBranch(branchName);
        return { tier: 2, success: false, action: "code_fix", details: "TypeScript compilation failed", timestamp: now };
      }

      // 5. Run tests
      try {
        execSync("npx vitest run --reporter=json", { stdio: "pipe", cwd: process.cwd(), timeout: 120_000 });
      } catch (err) {
        logger.warn("Tier 2: Tests failed — rolling back", { error: String(err) });
        this.rollbackBranch(branchName);
        return { tier: 2, success: false, action: "code_fix", details: "Tests failed", timestamp: now };
      }

      // 6. Commit (never auto-merge)
      execSync(`git add -A && git commit -m "self-heal: ${diagnosis.problem.slice(0, 60)}"`, { stdio: "pipe", cwd: process.cwd() });
      execSync("git checkout main", { stdio: "pipe", cwd: process.cwd() });

      // 7. Notify user
      eventBus.emit({
        type: "system:alert",
        message: `🔧 Self-heal: code fix ready on branch \`${branchName}\`. Review and merge manually:\n\`git diff main...${branchName}\`\n\`git merge ${branchName}\``,
        level: "warn",
      });

      logger.info("Tier 2: Code fix committed on branch", { branch: branchName });
      return { tier: 2, success: true, action: "code_fix", details: `Fix committed on branch ${branchName} — awaiting manual merge`, timestamp: now };

    } catch (err) {
      logger.error("Tier 2 code fix failed", { error: String(err) });
      this.rollbackBranch(branchName);
      return { tier: 2, success: false, action: "code_fix", details: String(err), timestamp: now };
    }
  }

  /** Roll back to main and delete the heal branch */
  private rollbackBranch(branchName: string): void {
    try {
      execSync("git checkout main", { stdio: "pipe", cwd: process.cwd() });
      execSync(`git branch -D ${branchName}`, { stdio: "pipe", cwd: process.cwd() });
    } catch (err) {
      logger.error("Failed to rollback heal branch", { branchName, error: String(err) });
    }
  }

  // ─── Tier 3: Human Escalation ──────────────────────────

  async escalate(diagnosis: Diagnosis, attempts: HealResult[]): Promise<void> {
    const recentLogs = await this.readRecentLogs(100);
    const recentErrors = await this.readRecentErrors(Date.now() - 1_800_000); // last 30 min

    const report = [
      "🚨 **PEPAGI Self-Heal: Manual Intervention Required**",
      "",
      `**Problem:** ${diagnosis.problem}`,
      `**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%`,
      "",
      "**Attempted Fixes:**",
      ...attempts.map(a => `- Tier ${a.tier} (${a.action}): ${a.success ? "✓" : "✗"} — ${a.details}`),
      "",
      "**Recent Errors:**",
      ...recentErrors.slice(0, 10).map(e => `- ${e}`),
      "",
      "**Suggested Manual Actions:**",
      "1. Check logs: `~/.pepagi/logs/`",
      "2. Restart daemon: `npm run daemon:stop && npm run daemon`",
      "3. Check self-heal log: `~/.pepagi/self-heal.jsonl`",
    ].join("\n");

    eventBus.emit({ type: "system:alert", message: report, level: "critical" });
    logger.warn("Tier 3: Escalated to human", { diagnosis: diagnosis.problem });
  }

  // ─── Helpers ───────────────────────────────────────────

  private recordAttempt(tier: number, success: boolean): void {
    this.healAttempts.push({ ts: Date.now(), tier, success });
    // Keep only last 20 attempts in memory
    if (this.healAttempts.length > 20) this.healAttempts.shift();
  }

  private async persistLog(entry: Omit<HealLogEntry, "timestamp">): Promise<void> {
    try {
      const logEntry: HealLogEntry = { timestamp: new Date().toISOString(), ...entry };
      await appendFile(HEAL_LOG_FILE, JSON.stringify(logEntry) + "\n", "utf8");
    } catch (err) {
      logger.error("Failed to write self-heal log", { error: String(err) });
    }
  }

  /** Read last N lines from the most recent log file */
  async readRecentLogs(lines: number): Promise<string> {
    try {
      const logsDir = join(PEPAGI_DATA_DIR, "logs");
      if (!existsSync(logsDir)) return "(no logs)";
      const files = await readdir(logsDir);
      const logFiles = files.filter(f => f.startsWith("pepagi-") && f.endsWith(".jsonl")).sort().reverse();
      if (logFiles.length === 0) return "(no log files)";
      const content = await readFile(join(logsDir, logFiles[0]!), "utf8");
      return content.split("\n").filter(l => l.trim()).slice(-lines).join("\n");
    } catch {
      return "(error reading logs)";
    }
  }

  /** Read recent error-level entries from logs */
  async readRecentErrors(since: number): Promise<string[]> {
    try {
      const raw = await this.readRecentLogs(200);
      const errors: string[] = [];
      for (const line of raw.split("\n")) {
        try {
          const entry = JSON.parse(line) as { timestamp: string; level: string; message: string };
          if (entry.level === "error" && new Date(entry.timestamp).getTime() >= since) {
            errors.push(`[${entry.timestamp}] ${entry.message}`);
          }
        } catch { /* skip malformed lines */ }
      }
      return errors;
    } catch {
      return [];
    }
  }

  /** Expose attempts for testing */
  getAttempts(): Array<{ ts: number; tier: number; success: boolean }> {
    return [...this.healAttempts];
  }

  /** Expose cooldownUntil for testing */
  getCooldownUntil(): number {
    return this.cooldownUntil;
  }
}
