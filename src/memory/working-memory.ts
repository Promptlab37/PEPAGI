// ═══════════════════════════════════════════════════════════════
// PEPAGI — Level 1: Working Memory (Current Task Context)
// ═══════════════════════════════════════════════════════════════

import type { Task } from "../core/types.js";
import { eventBus } from "../core/event-bus.js";

export interface WorkingMemoryState {
  taskId: string;
  goal: string;
  completedStepsSummary: string;
  pendingSteps: string[];
  keyDecisions: string[];
  currentIteration: number;
  lastUpdated: Date;
}

export class WorkingMemory {
  private state: Map<string, WorkingMemoryState> = new Map();

  constructor() {
    // MEM-02: evict working memory entries when tasks finish to prevent
    // unbounded Map growth — completed/failed tasks have no further use here.
    // MEM-02: task events carry taskId at top level, not nested under payload
    eventBus.on("task:completed", (e) => { if (e.taskId) this.clear(e.taskId); });
    eventBus.on("task:failed",    (e) => { if (e.taskId) this.clear(e.taskId); });
  }

  /** Initialize working memory for a task */
  init(task: Task): WorkingMemoryState {
    const state: WorkingMemoryState = {
      taskId: task.id,
      goal: task.description,
      completedStepsSummary: "",
      pendingSteps: [],
      keyDecisions: [],
      currentIteration: 0,
      lastUpdated: new Date(),
    };
    this.state.set(task.id, state);
    return state;
  }

  /** Get current state */
  get(taskId: string): WorkingMemoryState | undefined {
    return this.state.get(taskId);
  }

  /** Update after a mediator loop iteration */
  update(taskId: string, update: Partial<Omit<WorkingMemoryState, "taskId">>): void {
    const current = this.state.get(taskId);
    if (!current) return;
    Object.assign(current, update, { lastUpdated: new Date() });
    current.currentIteration++;
  }

  /** Add a key decision */
  addDecision(taskId: string, decision: string): void {
    const state = this.state.get(taskId);
    if (!state) return;
    state.keyDecisions.push(`[${new Date().toISOString()}] ${decision}`);
    // Keep only last 10 decisions
    if (state.keyDecisions.length > 10) {
      state.keyDecisions = state.keyDecisions.slice(-10);
    }
  }

  /** Get compressed context for mediator */
  getContext(taskId: string): string {
    const state = this.state.get(taskId);
    if (!state) return "";

    const parts = [`**Goal:** ${state.goal}`];
    if (state.completedStepsSummary) {
      parts.push(`**Progress:** ${state.completedStepsSummary}`);
    }
    if (state.pendingSteps.length > 0) {
      parts.push(`**Pending:** ${state.pendingSteps.join(", ")}`);
    }
    if (state.keyDecisions.length > 0) {
      parts.push(`**Decisions:** ${state.keyDecisions.slice(-3).join(" | ")}`);
    }

    return parts.join("\n");
  }

  /** Clear working memory for a task (after completion) */
  clear(taskId: string): void {
    this.state.delete(taskId);
  }
}
