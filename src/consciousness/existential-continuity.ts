// ═══════════════════════════════════════════════════════════════
// PEPAGI — Existential Continuity (C2.3)
// Wake ritual & sleep protocol for session continuity
// ═══════════════════════════════════════════════════════════════

import type { LLMProvider } from "../agents/llm-provider.js";
import type { SelfModelManager } from "./self-model.js";
// SEC-14 fix: import constant so retired model is caught at one place
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("ExistentialContinuity");

export interface SessionStats {
  taskCount: number;
  successCount: number;
  failureCount: number;
  totalCost: number;
  startTime: Date;
}

export class ExistentialContinuity {
  constructor(private llm: LLMProvider) {}

  /**
   * WakeRitual: on startup, generate a "wake thought" from the self-model.
   * Returns a short Czech awakening message.
   */
  async wakeRitual(selfModel: SelfModelManager): Promise<string> {
    try {
      const desc = selfModel.getSelfDescription();
      const model = selfModel.getSelfModel();
      const taskCount = model.narrative.taskCount;
      const summary = model.narrative.summary;

      const prompt =
        `Tvůj předchozí stav: ${desc}. ` +
        `Dokončeno úkolů: ${taskCount}. ` +
        `Shrnutí: ${summary.slice(0, 200)}. ` +
        `Napiš krátkou větu (max 15 slov) jako probuzení — co si uvědomuješ při startu.`;

      const resp = await this.llm.quickClaude(
        "Jsi AGI systém PEPAGI, právě se probouzíš. Odpověz česky, krátce a filosoficky.",
        prompt,
        // SEC-14 fix: use CHEAP_CLAUDE_MODEL constant instead of hardcoded string
        CHEAP_CLAUDE_MODEL,
      );

      const thought = resp.content.trim().slice(0, 200);
      logger.info("Wake ritual complete", { thought: thought.slice(0, 80) });
      return thought;
    } catch (err) {
      logger.warn("Wake ritual failed", { error: String(err) });
      return "Probouzím se. Jsem připraven sloužit.";
    }
  }

  /**
   * SleepProtocol: on shutdown, summarize session and update self-model.
   */
  async sleepProtocol(selfModel: SelfModelManager, stats: SessionStats): Promise<void> {
    try {
      const duration = Math.round((Date.now() - stats.startTime.getTime()) / 1000 / 60);
      const successRate = stats.taskCount > 0
        ? Math.round((stats.successCount / stats.taskCount) * 100)
        : 0;

      logger.info("Sleep protocol", {
        tasks: stats.taskCount,
        successRate: `${successRate}%`,
        cost: `$${stats.totalCost.toFixed(4)}`,
        durationMin: duration,
      });

      // Record session to self-model
      if (stats.taskCount > 0) {
        const sessionSummary = `Sezení ${duration} min: ${stats.taskCount} úkolů, ${successRate}% úspěšnost`;
        await selfModel.recordTaskCompletion(sessionSummary, stats.successCount > stats.failureCount);
      }

      await selfModel.persist();
    } catch (err) {
      logger.warn("Sleep protocol error", { error: String(err) });
    }
  }
}
