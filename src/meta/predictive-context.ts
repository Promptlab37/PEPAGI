// ═══════════════════════════════════════════════════════════════
// PEPAGI — Predictive Context Loader
// Pre-loads memory context BEFORE the user finishes asking,
// based on conversation patterns and task classification.
// Based on A-MEM (arXiv:2502.12110) — proactive context priming
// ═══════════════════════════════════════════════════════════════

import type { LLMProvider } from "../agents/llm-provider.js";
import type { MemorySystem } from "../memory/memory-system.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "../core/logger.js";
import type { Task } from "../core/types.js";

const logger = new Logger("PredictiveContextLoader");

/** Valid task type classifications */
const TASK_TYPES = [
  "coding",
  "analysis",
  "creative_writing",
  "research",
  "planning",
  "automation",
  "qa",
  "other",
] as const;

type TaskType = typeof TASK_TYPES[number];

/** Suggested agents keyed by task type */
const AGENT_SUGGESTIONS: Record<TaskType, string> = {
  coding:           "claude (best at code generation and debugging)",
  analysis:         "claude or gpt (strong reasoning and data analysis)",
  creative_writing: "claude (nuanced creative output)",
  research:         "gemini (large context window, web-aware)",
  planning:         "claude (hierarchical decomposition)",
  automation:       "claude with agentic tools (bash/file execution)",
  qa:               "gpt-4o-mini or claude-haiku (fast, cheap validation)",
  other:            "claude (general-purpose fallback)",
};

/** Difficulty hints keyed by task type */
const DIFFICULTY_HINTS: Record<TaskType, string> = {
  coding:           "medium-complex depending on scope",
  analysis:         "medium — requires careful reasoning",
  creative_writing: "simple-medium — mostly single-pass",
  research:         "medium — may need multiple retrieval steps",
  planning:         "complex — hierarchical decomposition advised",
  automation:       "complex — tool use and error handling needed",
  qa:               "trivial-simple — fast verification loop",
  other:            "unknown — escalate to mediator",
};

export interface PredictedContext {
  /** Classified task category */
  taskType: string;
  /** Pre-loaded memory context string ready for injection */
  relevantMemories: string;
  /** Estimated difficulty hint */
  estimatedDifficulty: string;
  /** Suggested agent string */
  suggestedAgent: string;
  /** Confidence in the prediction (0-1) */
  confidence: number;
}

/** Cache entry shape */
interface CacheEntry {
  context: PredictedContext;
  /** Epoch ms when this entry expires */
  expires: number;
}

/** TTL for cached predictions: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

export class PredictiveContextLoader {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private llm: LLMProvider,
    private memory: MemorySystem | null,
  ) {}

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Pre-load context for a task before processing starts.
   * Uses conversation history to predict what memory and agent will be needed.
   * @param task - The task about to be processed
   * @param conversationHistory - Recent conversation turns for pattern context
   * @returns PredictedContext with pre-loaded memories and agent hint
   */
  async preloadContext(
    task: Task,
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<PredictedContext> {
    const key = this.cacheKey(task.description);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      logger.debug("Returning cached predicted context", { taskId: task.id });
      return cached.context;
    }

    // Use last 3 conversation turns for pattern context
    const recentHistory = conversationHistory.slice(-3);

    // Classify task type (cheap LLM call)
    const taskType = await this.classifyTaskType(
      task.description,
      recentHistory,
    );

    // Pre-fetch relevant memories if memory system is available
    let relevantMemories = "";
    if (this.memory) {
      try {
        relevantMemories = await this.memory.getRelevantContext(task);
      } catch (err) {
        logger.debug("Memory pre-load failed", { taskId: task.id, error: String(err) });
        relevantMemories = "";
      }
    }

    // Compute confidence: higher when we have memory context AND clear task type
    const hasMemories = relevantMemories.length > 50;
    const isKnownType = taskType !== "other";
    const confidence = (hasMemories ? 0.5 : 0.25) + (isKnownType ? 0.35 : 0.1) + 0.15;

    const context: PredictedContext = {
      taskType,
      relevantMemories,
      estimatedDifficulty: DIFFICULTY_HINTS[taskType as TaskType] ?? "unknown",
      suggestedAgent: AGENT_SUGGESTIONS[taskType as TaskType] ?? AGENT_SUGGESTIONS.other,
      confidence: Math.min(confidence, 1.0),
    };

    // Cache the result
    this.cache.set(key, {
      context,
      expires: Date.now() + CACHE_TTL_MS,
    });

    // MEM-07: cap the cache at 200 entries — TTL alone doesn't bound size when
    // there is a continuous stream of distinct task descriptions. Map insertion
    // order is stable, so keys().next() always returns the oldest entry.
    if (this.cache.size > 200) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    logger.info("Predictive context loaded", {
      taskId: task.id,
      taskType,
      confidence: context.confidence.toFixed(2),
      hasMemories,
    });

    return context;
  }

  /**
   * Extract task type classification from description.
   * Uses a cheap LLM call to return one of the known task type labels.
   * @param description - Task description text
   * @param recentHistory - Optional recent conversation turns for additional context
   * @returns One of the valid task type strings
   */
  async classifyTaskType(
    description: string,
    recentHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
  ): Promise<string> {
    const historyContext = recentHistory.length > 0
      ? `\nRecent conversation:\n${recentHistory.map(h => `${h.role}: ${h.content.slice(0, 200)}`).join("\n")}`
      : "";

    const systemPrompt = `You are a task classifier. Classify the task into exactly one category. Respond with ONLY the category word, nothing else.

Valid categories:
- coding: writing, debugging, reviewing code; building software
- analysis: data analysis, evaluation, comparison, metrics
- creative_writing: stories, blog posts, marketing copy, creative content
- research: finding information, summarizing sources, fact-checking
- planning: project plans, roadmaps, breaking down goals, scheduling
- automation: scripts, workflows, pipelines, bots, scheduled tasks
- qa: testing, validation, quality checks, reviewing outputs
- other: anything that does not fit the above

Respond with ONLY one word from the list above.`;

    const userMessage = `Task: ${description.slice(0, 500)}${historyContext}`;

    try {
      const response = await this.llm.quickClaude(systemPrompt, userMessage, CHEAP_CLAUDE_MODEL);
      const raw = response.content.trim().toLowerCase().replace(/[^a-z_]/g, "");

      // Validate against known types
      if ((TASK_TYPES as readonly string[]).includes(raw)) {
        return raw;
      }

      // Fuzzy fallback: try to match prefix
      const matched = TASK_TYPES.find(t => raw.startsWith(t.slice(0, 5)));
      return matched ?? "other";
    } catch (err) {
      logger.warn("Task classification failed, defaulting to 'other'", { error: String(err) });
      return "other";
    }
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Generate a stable cache key for a task description.
   * Uses first 200 chars normalized to reduce cache misses on trivial variations.
   * @param taskDescription - Raw task description
   * @returns Cache key string
   */
  private cacheKey(taskDescription: string): string {
    return taskDescription
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  /**
   * Manually invalidate the cache for a specific task description.
   * Useful if underlying memory changes between calls.
   * @param taskDescription - Description to invalidate
   */
  invalidate(taskDescription: string): void {
    const key = this.cacheKey(taskDescription);
    this.cache.delete(key);
  }

  /** Clear all cached predictions */
  clearCache(): void {
    this.cache.clear();
  }

  /** Number of currently cached predictions */
  get cacheSize(): number {
    return this.cache.size;
  }
}
