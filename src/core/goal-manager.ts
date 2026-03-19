// ═══════════════════════════════════════════════════════════════
// PEPAGI — GoalManager (Cron-based Proactive Goals)
// Daemon extension: PEPAGI autonomně spouští naplánované úkoly
// bez čekání na vstup uživatele.
//
// Goals jsou uloženy v ~/.pepagi/goals.json
// Schedule formáty:
//   "0 9 * * *"    — cron výraz (HH:MM každý den)
//   "every 1h"     — interval (1h, 30m, 2h, 15m, ...)
//   "daily 09:00"  — každý den v čas
//   "startup"      — jednou po startu daemonu
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import type { TaskStore } from "./task-store.js";
import type { Mediator } from "./mediator.js";
// SEC-09: Import SecurityGuard type to enable injection detection on goal prompts.
import type { SecurityGuard } from "../security/security-guard.js";

const logger = new Logger("GoalManager");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const GOALS_FILE = join(PEPAGI_DATA_DIR, "goals.json");

// ─── Goal Definition ──────────────────────────────────────────

export interface Goal {
  /** Unique name, e.g. "morning-briefing" */
  name: string;
  /** Human-readable description of what this goal does */
  description: string;
  /**
   * Schedule (see formats above).
   * Examples: "0 9 * * *", "every 2h", "daily 08:30", "startup"
   */
  schedule: string;
  /** The task prompt that will be submitted to Mediator */
  prompt: string;
  /** Whether this goal is active */
  enabled: boolean;
  /** Optional tags */
  tags?: string[];
  /** Last triggered (ISO string) */
  lastTriggered?: string;
  /** Number of times triggered */
  triggerCount?: number;
  /** IANA timezone, e.g. "Europe/Prague". Defaults to system timezone. */
  tz?: string;
  /**
   * Optional Telegram user ID to deliver the goal result to directly.
   * If set, result is sent as a DM; otherwise goes to all allowed users via system:alert.
   */
  deliverTo?: string;
}

// ─── Schedule parsers ─────────────────────────────────────────

/**
 * Parse "every Xh" or "every Xm" into milliseconds.
 * Returns null if not an interval expression.
 */
function parseIntervalMs(schedule: string): number | null {
  const m = schedule.match(/^every\s+(\d+(?:\.\d+)?)(h|m|s)$/i);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  if (unit === "h") return value * 3_600_000;
  if (unit === "m") return value * 60_000;
  if (unit === "s") return value * 1_000;
  return null;
}

/**
 * Parse "daily HH:MM" — returns ms until next trigger in given timezone.
 */
function parseDailyMs(schedule: string, tz?: string): number | null {
  const m = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (!m) return null;
  const targetH = parseInt(m[1]!, 10);
  const targetM = parseInt(m[2]!, 10);
  return msUntilTimeInTz(targetH, targetM, tz);
}

/**
 * Compute milliseconds until next HH:MM occurrence in the given IANA timezone.
 * Falls back to local time if tz is not provided or unsupported.
 */
function msUntilTimeInTz(hour: number, minute: number, tz?: string): number {
  const now = new Date();
  // Format "YYYY-MM-DDThh:mm:ss" in target timezone to determine current local time there
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
    const tzYear = get("year"); const tzMonth = get("month") - 1; const tzDay = get("day");
    const tzHour = get("hour"); const tzMinute = get("minute"); const tzSecond = get("second");

    // Build a target date in UTC that corresponds to HH:MM in the tz today
    // by computing the UTC offset
    const localNow = new Date(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond);
    const utcNow = new Date(now.getTime());
    const utcOffset = utcNow.getTime() - localNow.getTime(); // approx offset

    // Target = today HH:MM in tz, expressed in UTC
    let target = new Date(tzYear, tzMonth, tzDay, hour, minute, 0, 0);
    const targetUtc = target.getTime() + utcOffset;
    if (targetUtc <= now.getTime()) {
      target = new Date(tzYear, tzMonth, tzDay + 1, hour, minute, 0, 0);
      return target.getTime() + utcOffset - now.getTime();
    }
    return targetUtc - now.getTime();
  } catch {
    // Fallback: ignore timezone, use local
    const now2 = new Date();
    const target = new Date(now2);
    target.setHours(hour, minute, 0, 0);
    if (target <= now2) target.setDate(target.getDate() + 1);
    return target.getTime() - now2.getTime();
  }
}

// Parse a simple cron expression "M H * * *" (minute, hour, day, month, weekday).
// Supports "0 H * * *" (daily at hour H), "M H * * *" (daily at H:M), and "* /N * * * *" (every N minutes).
// Returns ms until next trigger, or null if unsupported.
function parseCronMs(schedule: string, tz?: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, , ,] = parts;
  if (!min || !hour) return null;

  // "0 H * * *" or "M H * * *" — daily at H:M
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && parts[2] === "*" && parts[3] === "*") {
    return msUntilTimeInTz(parseInt(hour, 10), parseInt(min, 10), tz);
  }

  // "*/N * * * *" — every N minutes
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && parts[2] === "*" && parts[3] === "*") {
    return parseInt(everyMin[1]!, 10) * 60_000;
  }

  return null;
}

/** Compute next trigger delay in ms for a schedule string + timezone. Returns null if unrecognized. */
function nextTriggerMs(schedule: string, tz?: string): number | null {
  if (schedule === "startup") return 0; // trigger immediately on start
  const interval = parseIntervalMs(schedule);
  if (interval !== null) return interval;
  const daily = parseDailyMs(schedule, tz);
  if (daily !== null) return daily;
  return parseCronMs(schedule, tz);
}

// ─── GoalManager class ────────────────────────────────────────

export class GoalManager {
  private goals: Goal[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(
    private taskStore: TaskStore,
    private mediator: Mediator,
    // SEC-09: Optional guard — when provided, goal prompts are screened for
    // prompt injection before being submitted to the mediator. Callers that
    // already construct GoalManager without a guard (daemon.ts, tests) continue
    // to work unchanged because the parameter is optional.
    private guard?: SecurityGuard,
  ) {}

  /** Load goals from disk (or create default example file) */
  async loadGoals(): Promise<void> {
    await mkdir(PEPAGI_DATA_DIR, { recursive: true });

    if (!existsSync(GOALS_FILE)) {
      await this.writeDefaultGoals();
    }

    try {
      const raw = await readFile(GOALS_FILE, "utf8");
      this.goals = JSON.parse(raw) as Goal[];
      // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
      logger.info("GoalManager loaded", { goals: this.goals.length, enabled: this.goals.filter(g => g.enabled).length });
    } catch (err) {
      logger.warn("Cannot load goals.json", { err: String(err) });
      this.goals = [];
    }
  }

  /** Save goals to disk */
  async saveGoals(): Promise<void> {
    // AUD-03: atomic write
    const tmp = `${GOALS_FILE}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.goals, null, 2), "utf8");
    await rename(tmp, GOALS_FILE);
  }

  /** Start scheduling all enabled goals */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadGoals();

    for (const goal of this.goals) {
      if (!goal.enabled) continue;
      this.scheduleGoal(goal);
    }

    logger.info("GoalManager started", {
      scheduled: [...this.timers.keys()],
    });
  }

  /** Stop all timers */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running = false;
    logger.info("GoalManager stopped");
  }

  private scheduleGoal(goal: Goal): void {
    const delayMs = nextTriggerMs(goal.schedule, goal.tz);
    if (delayMs === null) {
      logger.warn("Unsupported schedule format for goal", { name: goal.name, schedule: goal.schedule });
      return;
    }

    logger.debug(`Goal "${goal.name}" scheduled in ${Math.round(delayMs / 60_000)} minutes`);

    const timer = setTimeout(() => {
      this.triggerGoal(goal).catch(err =>
        logger.error(`Goal "${goal.name}" selhal`, { error: String(err) })
      );
    }, delayMs);

    this.timers.set(goal.name, timer);
  }

  /** Trigger a goal — create a task and process it */
  private async triggerGoal(goal: Goal): Promise<void> {
    logger.info(`Triggering goal: "${goal.name}"`, { prompt: goal.prompt.slice(0, 80) });

    // SEC-09: Screen the goal prompt for adversarial injection before passing it
    // to the mediator. A crafted goals.json could otherwise inject instructions
    // that hijack the mediator's behaviour. Risk threshold > 0.5 matches the
    // same bar used elsewhere in the security pipeline (wrapExternalData).
    if (this.guard) {
      const { riskScore, threats } = this.guard.detectInjection(goal.prompt);
      if (riskScore > 0.5) {
        logger.warn(`Goal "${goal.name}" skipped — prompt injection detected`, { riskScore, threats });
        return;
      }
    }

    // Update last triggered
    goal.lastTriggered = new Date().toISOString();
    goal.triggerCount = (goal.triggerCount ?? 0) + 1;
    await this.saveGoals().catch(e => logger.debug("saveGoals failed", { error: String(e) }));

    try {
      const task = this.taskStore.create({
        title: `[Goal] ${goal.name}`,
        description: goal.prompt,
        priority: "low",
      });

      const output = await this.mediator.processTask(task.id);
      logger.info(`Goal "${goal.name}" completed`, { success: output.success, summary: output.summary.slice(0, 100) });

      const resultText = output.success
        ? (typeof output.result === "string" ? output.result : output.summary)
        : `❌ Goal selhal: ${output.summary}`;

      // Deliver result: targeted DM if deliverTo set, otherwise broadcast alert
      if (goal.deliverTo) {
        eventBus.emit({
          type: "system:goal_result",
          goalName: goal.name,
          message: resultText.slice(0, 4000),
          success: output.success,
          userId: goal.deliverTo,
        });
      } else {
        eventBus.emit({
          type: "system:alert",
          message: `🎯 *${goal.name}*\n\n${resultText.slice(0, 800)}`,
          level: "warn",
        });
      }
    } catch (err) {
      logger.error(`Goal "${goal.name}" selhal`, { err: String(err) });
      eventBus.emit({
        type: "system:alert",
        message: `❌ Goal "${goal.name}" selhal: ${String(err)}`,
        level: "critical",
      });
    } finally {
      // Reschedule (skip "startup" — runs only once)
      if (goal.schedule !== "startup") {
        this.scheduleGoal(goal);
      }
    }
  }

  /** Add a new goal at runtime */
  async addGoal(goal: Goal): Promise<void> {
    this.goals = this.goals.filter(g => g.name !== goal.name);
    this.goals.push(goal);
    await this.saveGoals();
    if (this.running && goal.enabled) {
      this.scheduleGoal(goal);
    }
    logger.info("Goal added", { name: goal.name, schedule: goal.schedule });
  }

  /** Enable/disable a goal */
  async toggleGoal(name: string, enabled: boolean): Promise<boolean> {
    const goal = this.goals.find(g => g.name === name);
    if (!goal) return false;
    goal.enabled = enabled;
    await this.saveGoals();
    if (!enabled) {
      const timer = this.timers.get(name);
      if (timer) { clearTimeout(timer); this.timers.delete(name); }
    } else if (this.running) {
      this.scheduleGoal(goal);
    }
    return true;
  }

  /** List all goals with their next trigger info */
  listGoals(): Array<Goal & { nextTriggerMs: number | null }> {
    return this.goals.map(g => ({
      ...g,
      nextTriggerMs: nextTriggerMs(g.schedule, g.tz),
    }));
  }

  /** Create a default goals.json as example */
  private async writeDefaultGoals(): Promise<void> {
    const defaults: Goal[] = [
      {
        name: "daily-summary",
        description: "Každodenní souhrn v 9 ráno",
        schedule: "daily 09:00",
        prompt: "Připrav stručný přehled mého dne: zkontroluj počasí, připomeň případné úkoly z paměti a navrhni 3 priority na dnešek.",
        enabled: false,
        tags: ["daily", "productivity"],
      },
      {
        name: "weekly-review",
        description: "Týdenní přehled každé pondělí v 8:00",
        schedule: "0 8 * * 1",
        prompt: "Připrav týdenní review: co se povedlo minulý týden, co bylo v paměti uloženo jako důležité, a navrhni 5 priorit na tento týden.",
        enabled: false,
        tags: ["weekly", "review"],
      },
    ];
    // AUD-03: atomic write
    const tmp = `${GOALS_FILE}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(defaults, null, 2), "utf8");
    await rename(tmp, GOALS_FILE);
    logger.info("Created default goals.json", { path: GOALS_FILE });
  }
}
