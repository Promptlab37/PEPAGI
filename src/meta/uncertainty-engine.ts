// ═══════════════════════════════════════════════════════════════
// PEPAGI — Uncertainty Engine (Confidence Propagation)
// ═══════════════════════════════════════════════════════════════

import type { Task, TaskOutput } from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";

/** Confidence propagation constant */
const PROPAGATION_DECAY = 0.9;

export class UncertaintyEngine {
  constructor(private taskStore: TaskStore) {}

  /**
   * Calculate the overall confidence for a task, considering its subtask tree.
   * Parent confidence = min(subtask confidences) × PROPAGATION_DECAY
   */
  getTaskConfidence(taskId: string): number {
    // BUG-02: added cycle detection — circular task references would cause stack overflow
    return this.calculateSubtreeConfidence(taskId, new Set());
  }

  private calculateSubtreeConfidence(taskId: string, visited: Set<string>): number {
    // BUG-02: break cycle with neutral confidence rather than recursing infinitely
    if (visited.has(taskId)) return 0.5;
    visited.add(taskId);

    const task = this.taskStore.get(taskId);
    if (!task) return 0;

    // Leaf task (no subtasks)
    if (task.subtaskIds.length === 0) {
      return task.confidence;
    }

    // Aggregate subtask confidences
    const subtaskConfidences = task.subtaskIds
      .map(id => this.calculateSubtreeConfidence(id, visited))
      .filter(c => c > 0);

    if (subtaskConfidences.length === 0) return task.confidence;

    const minConfidence = Math.min(...subtaskConfidences);
    const propagated = minConfidence * PROPAGATION_DECAY;

    return Math.min(task.confidence, propagated);
  }

  /**
   * Check if confidence is below threshold and determine action.
   * @returns "proceed" | "verify" | "ask_user" | "abort"
   */
  recommendAction(confidence: number, attempts: number, maxAttempts: number): "proceed" | "verify" | "ask_user" | "abort" {
    if (confidence >= 0.8) return "proceed";
    if (confidence >= 0.6) return "verify";
    if (confidence >= 0.3 && attempts < maxAttempts) return "verify";
    if (confidence >= 0.3) return "ask_user";
    return "abort";
  }

  /**
   * Propagate output confidence up to parent task.
   */
  propagateUp(output: TaskOutput, parentTask: Task): number {
    const base = output.confidence;
    // Apply propagation decay when going up
    const propagated = base * PROPAGATION_DECAY;
    return Math.max(0, Math.min(1, propagated));
  }

  /**
   * Compute combined confidence from multiple parallel results.
   * Uses harmonic mean — penalizes outliers.
   */
  combineConfidences(confidences: number[]): number {
    if (confidences.length === 0) return 0;
    if (confidences.length === 1) return confidences[0]!;

    // Harmonic mean
    const harmonic = confidences.length / confidences.reduce((s, c) => s + (c > 0 ? 1 / c : Infinity), 0);
    return Math.min(1, harmonic * PROPAGATION_DECAY);
  }

  /**
   * Get uncertainty summary for display.
   */
  getUncertaintySummary(taskId: string): string {
    const confidence = this.getTaskConfidence(taskId);
    const task = this.taskStore.get(taskId);
    if (!task) return "Unknown task";

    const level = confidence >= 0.8 ? "HIGH" : confidence >= 0.6 ? "MEDIUM" : confidence >= 0.3 ? "LOW" : "CRITICAL";
    const subtaskCount = task.subtaskIds.length;

    return `Confidence: ${(confidence * 100).toFixed(0)}% [${level}]${subtaskCount > 0 ? `, propagated from ${subtaskCount} subtasks` : ""}`;
  }
}
