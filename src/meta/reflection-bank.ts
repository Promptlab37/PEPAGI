// ═══════════════════════════════════════════════════════════════
// PEPAGI — Reflection Bank (Dual-Loop Self-Improvement)
// ═══════════════════════════════════════════════════════════════

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Task, TaskOutput, RecoveryLearning } from "../core/types.js";
import { parseLLMJson } from "../core/parse-llm-json.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { Logger } from "../core/logger.js";
import type { PhenomenalStateEngine } from "../consciousness/phenomenal-state.js";

const logger = new Logger("ReflectionBank");

export interface Reflection {
  id: string;
  taskId: string;
  taskTitle: string;
  whatWorked: string;
  whatDidnt: string;
  wouldDoDifferently: string;
  timestamp: string;
  tags: string[];
}

const REFLECTIONS_PATH = join(PEPAGI_DATA_DIR, "memory", "reflections.jsonl");

export class ReflectionBank {
  private reflections: Reflection[] = [];
  private loaded = false;

  constructor(private llm: LLMProvider, private phenomenalState: PhenomenalStateEngine | null = null) {}

  /**
   * Wire in a PhenomenalStateEngine after construction (e.g. after ConsciousnessManager boots).
   * @param state - The phenomenal state engine instance
   */
  setPhenomenalState(state: PhenomenalStateEngine): void {
    this.phenomenalState = state;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(REFLECTIONS_PATH)) {
      const content = await readFile(REFLECTIONS_PATH, "utf8");
      this.reflections = content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Reflection);
    }
    this.loaded = true;
  }

  /** Append a single reflection to the JSONL file (consistent with episodic/semantic memory) */
  private async appendReflection(reflection: Reflection): Promise<void> {
    await appendFile(REFLECTIONS_PATH, JSON.stringify(reflection) + "\n", "utf8");
  }

  /**
   * Perform reflection after task completion (Extrospection → Bank).
   */
  async reflect(task: Task, output: TaskOutput): Promise<Reflection | null> {
    if (!output.success && task.attempts < task.maxAttempts) return null; // don't reflect on intermediate failures

    try {
      // Adjust reflection depth based on emotional state (learning multiplier)
      const learningMultiplier = this.phenomenalState?.getLearningMultiplier() ?? 1.0;

      let systemInstruction: string;
      let userPromptSuffix: string;
      if (learningMultiplier >= 1.5) {
        // Curious or frustrated+uncertain: reflect in depth
        systemInstruction = "You reflect on completed AI tasks to learn lessons. Be specific and actionable. Be thorough and detailed. Return ONLY JSON: {\"whatWorked\": \"...\", \"whatDidnt\": \"...\", \"wouldDoDifferently\": \"...\"}";
        userPromptSuffix = "Provide a thorough, detailed reflection on this task execution.";
      } else if (learningMultiplier <= -0.3) {
        // Satisfied + confident: brief reinforcement only
        systemInstruction = "You reflect on completed AI tasks. Return ONLY JSON: {\"whatWorked\": \"...\", \"whatDidnt\": \"...\", \"wouldDoDifferently\": \"...\"}";
        userPromptSuffix = "Briefly note what worked well.";
      } else {
        // Default depth
        systemInstruction = "You reflect on completed AI tasks to learn lessons. Be specific and actionable. Return ONLY JSON: {\"whatWorked\": \"...\", \"whatDidnt\": \"...\", \"wouldDoDifferently\": \"...\"}";
        userPromptSuffix = "Reflect on this task execution.";
      }

      const response = await this.llm.quickClaude(
        systemInstruction,
        `Task: "${task.title}"\nOutcome: ${output.success ? "SUCCESS" : "FAILURE"}\nSummary: ${output.summary}\n\n${userPromptSuffix}`,
        CHEAP_CLAUDE_MODEL,
        true,
      );

      const parsed = parseLLMJson<{ whatWorked: string; whatDidnt: string; wouldDoDifferently: string }>(response.content);

      // Validate reflection content — must be strings of reasonable length
      // Prevents adversarially crafted LLM output from being stored as injection payload
      const clean = (s: unknown, max = 500): string => {
        if (typeof s !== "string") return "";
        return s.slice(0, max).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // strip control chars
      };

      await this.ensureLoaded();

      const reflection: Reflection = {
        id: nanoid(8),
        taskId: task.id,
        taskTitle: task.title.slice(0, 100),
        whatWorked: clean(parsed.whatWorked),
        whatDidnt: clean(parsed.whatDidnt),
        wouldDoDifferently: clean(parsed.wouldDoDifferently),
        timestamp: new Date().toISOString(),
        tags: task.tags,
      };

      this.reflections.push(reflection);
      await this.appendReflection(reflection);

      logger.debug("Reflection stored", { taskId: task.id });
      return reflection;
    } catch (err) {
      logger.warn("Reflection failed", { error: String(err) });
      return null;
    }
  }

  /**
   * Retrieve relevant reflections for a new task (Introspection).
   */
  async getRelevant(taskDescription: string, limit = 3): Promise<Reflection[]> {
    await this.ensureLoaded();

    const queryWords = new Set(taskDescription.toLowerCase().split(/\W+/).filter(w => w.length > 3));

    return this.reflections
      .map(r => {
        const text = `${r.taskTitle} ${r.tags.join(" ")}`.toLowerCase();
        const matches = [...queryWords].filter(w => text.includes(w)).length;
        return { r, score: matches };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.r);
  }

  /**
   * Format reflections as context for mediator.
   */
  async getContextString(taskDescription: string): Promise<string> {
    const relevant = await this.getRelevant(taskDescription);
    if (relevant.length === 0) return "";

    const items = relevant.map(r =>
      `• "${r.taskTitle}": Worked: ${r.whatWorked.slice(0, 80)} | Fix: ${r.wouldDoDifferently.slice(0, 80)}`
    );

    return `**Past Reflections:**\n${items.join("\n")}`;
  }

  /**
   * Ingest a RecoveryLearning as a Reflection without LLM call.
   * Converts recovery data directly into the reflection format.
   */
  async ingestRecoveryLearning(task: Task, learning: RecoveryLearning): Promise<Reflection> {
    await this.ensureLoaded();

    const reflection: Reflection = {
      id: nanoid(8),
      taskId: task.id,
      taskTitle: task.title.slice(0, 100),
      whatWorked: learning.solution.slice(0, 500),
      whatDidnt: `${learning.failurePattern}: ${learning.rootCause}`.slice(0, 500),
      wouldDoDifferently: learning.preventionHint.slice(0, 500),
      timestamp: new Date().toISOString(),
      tags: [...task.tags, "recovery"],
    };

    this.reflections.push(reflection);
    await this.appendReflection(reflection);

    logger.debug("Ingested recovery learning as reflection", { taskId: task.id, reflectionId: reflection.id });
    return reflection;
  }

  async getStats(): Promise<{ total: number }> {
    await this.ensureLoaded();
    return { total: this.reflections.length };
  }
}
