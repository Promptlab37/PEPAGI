import { nanoid } from "nanoid";
// OPUS: rename was dynamically imported inside persist() on every call — wasteful
import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task, TaskStatus, TaskOutput, AgentProvider, TaskPriority } from "./types.js";
import { eventBus } from "./event-bus.js";
// FIX: use structured logger instead of console.log/warn
import { Logger } from "./logger.js";

const taskStoreLogger = new Logger("TaskStore");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const TASKS_FILE = join(PEPAGI_DATA_DIR, "tasks.json");
const TASKS_TMP  = join(PEPAGI_DATA_DIR, "tasks.json.tmp");

export class TaskStore {
  private tasks = new Map<string, Task>();
  private saveScheduled = false;

  // ── Persistence ─────────────────────────────────────────────

  /** Load uncompleted tasks from disk on startup. */
  async load(): Promise<void> {
    await mkdir(PEPAGI_DATA_DIR, { recursive: true });
    if (!existsSync(TASKS_FILE)) return;
    try {
      const raw = await readFile(TASKS_FILE, "utf8");
      const list = JSON.parse(raw) as Task[];
      let restored = 0;
      for (const t of list) {
        // Re-hydrate Date fields
        t.createdAt   = new Date(t.createdAt);
        t.startedAt   = t.startedAt   ? new Date(t.startedAt)   : null;
        t.completedAt = t.completedAt ? new Date(t.completedAt) : null;

        // Skip terminal tasks — they're already in episodic memory
        if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") continue;

        // Reset in-flight tasks to pending (they didn't finish before crash)
        if (t.status === "running" || t.status === "assigned") {
          t.status = "pending";
          t.startedAt = null;
        }

        this.tasks.set(t.id, t);
        restored++;
      }
      if (restored > 0) {
        // Rebuild parent→subtask links
        for (const t of this.tasks.values()) {
          if (t.parentId) {
            const parent = this.tasks.get(t.parentId);
            if (parent && !parent.subtaskIds.includes(t.id)) parent.subtaskIds.push(t.id);
          }
        }
        // FIX: use structured logger instead of console.log
        taskStoreLogger.info("Restored pending tasks from disk", { restored });
      }
    } catch (err) {
      // FIX: use structured logger instead of console.warn
      taskStoreLogger.warn("Failed to load tasks.json (starting fresh)", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Schedule a debounced async save (max once per 500ms). */
  private scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      this.saveScheduled = false;
      // FIX: log persist failures instead of silent swallow
      this.persist().catch(e => taskStoreLogger.debug("Task persist failed", { error: String(e) }));
    }, 500);
  }

  /** Atomic write: tmp → rename. */
  private async persist(): Promise<void> {
    const list = [...this.tasks.values()];
    await mkdir(PEPAGI_DATA_DIR, { recursive: true });
    await writeFile(TASKS_TMP, JSON.stringify(list, null, 2), "utf8");
    await rename(TASKS_TMP, TASKS_FILE);
  }

  // ── CRUD ────────────────────────────────────────────────────

  create(params: { title: string; description: string; parentId?: string; priority?: TaskPriority; dependsOn?: string[]; tags?: string[]; input?: Record<string, unknown> }): Task {
    const task: Task = {
      id: nanoid(12),
      parentId: params.parentId ?? null,
      title: params.title,
      description: params.description,
      status: "pending",
      priority: params.priority ?? "medium",
      difficulty: "unknown",
      assignedTo: null,
      assignmentReason: null,
      input: params.input ?? {},
      output: null,
      subtaskIds: [],
      dependsOn: params.dependsOn ?? [],
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      tokensUsed: { input: 0, output: 0 },
      estimatedCost: 0,
      confidence: 0,
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      tags: params.tags ?? [],
    };
    this.tasks.set(task.id, task);
    if (task.parentId) {
      const parent = this.tasks.get(task.parentId);
      if (parent) parent.subtaskIds.push(task.id);
    }
    eventBus.emit({ type: "task:created", task });
    this.scheduleSave();
    return task;
  }

  get(id: string): Task | undefined { return this.tasks.get(id); }
  getAll(): Task[] { return [...this.tasks.values()]; }
  getReady(): Task[] {
    return this.getAll().filter(t =>
      (t.status === "pending" || t.status === "queued") &&
      t.dependsOn.every(d => this.tasks.get(d)?.status === "completed")
    );
  }

  assign(id: string, agent: AgentProvider, reason: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.assignedTo = agent;
    task.assignmentReason = reason;
    task.status = "assigned";
    eventBus.emit({ type: "task:assigned", taskId: id, agent });
    this.scheduleSave();
  }

  complete(id: string, output: TaskOutput): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.output = output;
    task.status = "completed";
    task.completedAt = new Date();
    task.confidence = output.confidence;
    eventBus.emit({ type: "task:completed", taskId: id, output, cost: task.estimatedCost, agent: task.assignedTo ?? undefined });
    this.scheduleSave();
  }

  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.lastError = error;
    task.attempts += 1;
    task.status = task.attempts < task.maxAttempts ? "pending" : "failed";
    if (task.status === "failed") task.completedAt = new Date();
    eventBus.emit({ type: "task:failed", taskId: id, error });
    this.scheduleSave();
  }

  // OPUS: Sonnet iterated the full list 5 times (filter × 4 + reduce).
  // Single-pass accumulation is O(n) instead of O(5n).
  getStats(): { total: number; pending: number; running: number; completed: number; failed: number; totalCost: number } {
    let pending = 0, running = 0, completed = 0, failed = 0, totalCost = 0;
    for (const t of this.tasks.values()) {
      totalCost += t.estimatedCost;
      switch (t.status) {
        case "pending": pending++; break;
        case "running": running++; break;
        case "completed": completed++; break;
        case "failed": failed++; break;
      }
    }
    return { total: this.tasks.size, pending, running, completed, failed, totalCost };
  }
}
