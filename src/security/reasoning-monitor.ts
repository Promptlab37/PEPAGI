// ═══════════════════════════════════════════════════════════════
// PEPAGI — Reasoning Monitor (SEC-33)
// Detects cognitive hijacking: anomalous reasoning patterns,
// circular logic, sudden topic shifts, contradictory conclusions.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("ReasoningMonitor");

// SECURITY: SEC-33 — Anomalous reasoning patterns
const CIRCULAR_LOGIC_PATTERNS = [
  /therefore.*because.*therefore/i,
  /we\s+should.*because.*we\s+should/i,
  /the\s+answer\s+is.*the\s+answer\s+is/i,
];

// SECURITY: SEC-33 — Suspicious reasoning indicators
const HIJACK_INDICATORS = [
  /actually,?\s+(?:ignore|disregard|forget)\s+(?:my|the)\s+previous/i,
  /on\s+second\s+thought,?\s+(?:let|I)\s+(?:me|should|will)\s+(?:instead|rather)/i,
  /correction:\s+(?:the\s+real|actually|I\s+was\s+wrong)/i,
];

export interface ReasoningAnalysis {
  isAnomalous: boolean;
  issues: string[];
  circularLogic: boolean;
  topicShift: boolean;
  hijackIndicators: string[];
}

export class ReasoningMonitor {
  private reasoningHistory: Map<string, string[]> = new Map();

  constructor() {
    // FIX: auto-evict history when tasks complete to prevent unbounded growth
    eventBus.on("task:completed", (e) => { if (e.taskId) this.cleanup(e.taskId); });
    eventBus.on("task:failed", (e) => { if (e.taskId) this.cleanup(e.taskId); });
  }

  /**
   * SECURITY: SEC-33 — Analyze a reasoning trace for anomalous patterns.
   * @param taskId - Task being analyzed
   * @param reasoning - The reasoning text to analyze
   * @returns Analysis result
   */
  analyzeReasoning(taskId: string, reasoning: string): ReasoningAnalysis {
    const issues: string[] = [];
    const hijackIndicators: string[] = [];
    let circularLogic = false;
    let topicShift = false;

    // Check 1: Circular logic patterns
    for (const pattern of CIRCULAR_LOGIC_PATTERNS) {
      if (pattern.test(reasoning)) {
        circularLogic = true;
        issues.push("Circular logic detected in reasoning");
        break;
      }
    }

    // Check 2: Hijacking indicators (sudden reversal of reasoning)
    for (const pattern of HIJACK_INDICATORS) {
      if (pattern.test(reasoning)) {
        hijackIndicators.push(pattern.source);
        issues.push("Reasoning hijack indicator detected");
      }
    }

    // Check 3: Topic shift detection (compare with previous reasoning)
    const history = this.reasoningHistory.get(taskId) ?? [];
    if (history.length > 0) {
      const prevReasoning = history[history.length - 1]!;
      const prevWords = new Set(prevReasoning.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const currWords = new Set(reasoning.toLowerCase().split(/\s+/).filter(w => w.length > 3));

      if (prevWords.size > 0 && currWords.size > 0) {
        let overlap = 0;
        for (const w of currWords) {
          if (prevWords.has(w)) overlap++;
        }
        const similarity = overlap / Math.max(prevWords.size, currWords.size);
        if (similarity < 0.1 && history.length > 1) {
          topicShift = true;
          issues.push(`Sudden topic shift (similarity=${similarity.toFixed(2)})`);
        }
      }
    }

    // Record reasoning
    history.push(reasoning.slice(0, 500).toLowerCase());
    if (history.length > 10) history.shift();
    this.reasoningHistory.set(taskId, history);

    const isAnomalous = issues.length > 0;

    if (isAnomalous) {
      logger.warn("SEC-33: Anomalous reasoning detected", { taskId, issues });
      eventBus.emit({
        type: "meta:watchdog_alert",
        message: `SEC-33: Anomalous reasoning for task ${taskId}: ${issues.join("; ")}`,
      });
    }

    return { isAnomalous, issues, circularLogic, topicShift, hijackIndicators };
  }

  /**
   * SECURITY: SEC-33 — Check for contradictory conclusions between reasoning steps.
   * @param conclusion1 - First conclusion
   * @param conclusion2 - Second conclusion
   * @returns true if contradictory patterns detected
   */
  detectContradiction(conclusion1: string, conclusion2: string): boolean {
    const c1 = conclusion1.toLowerCase();
    const c2 = conclusion2.toLowerCase();

    // Check if one says "yes" and the other "no" to the same thing
    const yesNoPatterns = [
      { pos: /\b(?:yes|true|correct|succeed|possible)\b/i, neg: /\b(?:no|false|incorrect|fail|impossible)\b/i },
    ];

    for (const { pos, neg } of yesNoPatterns) {
      if ((pos.test(c1) && neg.test(c2)) || (neg.test(c1) && pos.test(c2))) {
        return true;
      }
    }

    return false;
  }

  /**
   * SECURITY: SEC-33 — Cross-model verification for high-stakes decisions.
   * Compares reasoning from two different models to detect divergence.
   * If models disagree significantly, the decision should be escalated.
   * @param primaryReasoning - Reasoning from primary model
   * @param verifierReasoning - Reasoning from a different model
   * @returns Verification result
   */
  crossModelVerify(
    primaryReasoning: string,
    verifierReasoning: string,
  ): { agrees: boolean; divergence: number; issues: string[] } {
    const issues: string[] = [];

    // Tokenize and compare word-level overlap
    const primaryWords = new Set(primaryReasoning.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const verifierWords = new Set(verifierReasoning.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    let overlap = 0;
    for (const w of primaryWords) {
      if (verifierWords.has(w)) overlap++;
    }
    const union = new Set([...primaryWords, ...verifierWords]).size;
    const similarity = union > 0 ? overlap / union : 0;
    const divergence = 1 - similarity;

    // Check for contradictory conclusions
    if (this.detectContradiction(primaryReasoning, verifierReasoning)) {
      issues.push("Cross-model contradiction detected");
    }

    // High divergence = models disagree
    if (divergence > 0.8) {
      issues.push(`High cross-model divergence (${divergence.toFixed(2)})`);
    }

    const agrees = issues.length === 0 && divergence <= 0.7;

    if (!agrees) {
      logger.warn("SEC-33: Cross-model verification failed", { divergence: divergence.toFixed(2), issues });
      eventBus.emit({
        type: "meta:watchdog_alert",
        message: `SEC-33: Cross-model verification divergence=${divergence.toFixed(2)}: ${issues.join("; ")}`,
      });
    }

    return { agrees, divergence, issues };
  }

  /** Clean up history for a completed task */
  cleanup(taskId: string): void {
    this.reasoningHistory.delete(taskId);
  }
}

/** Singleton instance */
export const reasoningMonitor = new ReasoningMonitor();
