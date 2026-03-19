// ═══════════════════════════════════════════════════════════════
// PEPAGI — Metacognition (Self-Monitoring + Self-Evaluation)
// ═══════════════════════════════════════════════════════════════

import type { Task, TaskOutput } from "../core/types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { MemorySystem } from "../memory/memory-system.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { parseLLMJson } from "../core/parse-llm-json.js";

const logger = new Logger("Metacognition");

interface ConfidenceRecord {
  taskId: string;
  timestamp: Date;
  confidence: number;
  source: string;
}

export class Metacognition {
  // MEM-03: keyed by taskId so we can evict per-task; old flat array grew to
  // 500 entries globally and mixed data from all tasks with no cleanup path.
  private confidenceHistory: Map<string, ConfidenceRecord[]> = new Map();
  private readonly verificationThreshold = 0.6;

  constructor(
    private llm: LLMProvider,
    private memory: MemorySystem,
  ) {
    // MEM-03: evict history for a task once it reaches a terminal state to
    // prevent unbounded accumulation across long-running sessions.
    // task events carry taskId at top level, not nested under payload
    eventBus.on("task:completed", (e) => { if (e.taskId) this.confidenceHistory.delete(e.taskId); });
    eventBus.on("task:failed",    (e) => { if (e.taskId) this.confidenceHistory.delete(e.taskId); });
  }

  /**
   * Layer 1: Self-monitor after receiving a result.
   * Returns true if result needs verification by another model.
   */
  async selfMonitor(task: Task, result: string, confidence: number): Promise<{ needsVerification: boolean; adjustedConfidence: number; concerns: string[] }> {
    const taskHistory = this.confidenceHistory.get(task.id) ?? [];
    taskHistory.push({
      taskId: task.id,
      timestamp: new Date(),
      confidence,
      source: "worker",
    });
    this.confidenceHistory.set(task.id, taskHistory);

    const concerns: string[] = [];

    // Check confidence trend using this task's own history slice
    if (taskHistory.length >= 3) {
      const recent = taskHistory.slice(-3).map(h => h.confidence);
      const trend = recent[2]! - recent[0]!;
      if (trend < -0.2) {
        concerns.push("Confidence trending downward — escalation recommended");
      }
    }

    if (confidence < this.verificationThreshold) {
      concerns.push(`Low confidence (${confidence.toFixed(2)}) — verification needed`);
    }

    // Quick sanity check using cheap model
    if (result && result.length > 100 && confidence < 0.8) {
      try {
        const check = await this.llm.quickClaude(
          "You verify if an AI result is reasonable and complete. Respond with ONLY JSON: {\"reasonable\": true/false, \"confidence\": 0.0-1.0, \"issues\": []}",
          `Task: "${task.title}"\nResult preview: "${result.slice(0, 300)}"\n\nIs this result reasonable, complete, and does it address the task?`,
          CHEAP_CLAUDE_MODEL,
          true,
        );

        const parsed = parseLLMJson<{ reasonable: boolean; confidence: number; issues: string[] }>(check.content);
        if (!parsed.reasonable) {
          concerns.push(`Verification failed: ${(parsed.issues ?? []).join(", ")}`);
          return { needsVerification: true, adjustedConfidence: Math.min(confidence, parsed.confidence ?? 0.3), concerns };
        }
      } catch {
        // ignore verification errors
      }
    }

    const needsVerification = confidence < this.verificationThreshold || concerns.length > 0;
    return { needsVerification, adjustedConfidence: confidence, concerns };
  }

  /**
   * Layer 2: Self-evaluate after a task failure.
   * Returns root cause analysis and strategy recommendations.
   */
  async selfEvaluate(task: Task, error: string): Promise<string> {
    try {
      const response = await this.llm.quickClaude(
        "You analyze failures in AI task execution. Be specific and actionable.",
        `Task "${task.title}" failed with: "${error}"\n\nAnalyze why this failed. Was it:\n1. Bad task decomposition?\n2. Wrong agent choice?\n3. Insufficient context?\n4. Vague specification?\n5. Technical limitation?\n\nSuggest specific changes for next attempt.`,
        CHEAP_CLAUDE_MODEL,
      );

      // Store analysis in episodic memory
      await this.memory.semantic.addFact({
        fact: `Task type "${task.title.slice(0, 50)}" failure: ${response.content.slice(0, 200)}`,
        source: task.id,
        confidence: 0.8,
        tags: ["failure_analysis", ...task.tags],
      });

      logger.info("Self-evaluation complete", { taskId: task.id });
      return response.content;
    } catch (err) {
      logger.warn("Self-evaluation failed", { error: String(err) });
      return `Failed to analyze: ${error}`;
    }
  }

  /** Get confidence history for a task */
  getConfidenceHistory(taskId: string): ConfidenceRecord[] {
    return this.confidenceHistory.get(taskId) ?? [];
  }
}
