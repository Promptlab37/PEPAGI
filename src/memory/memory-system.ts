// ═══════════════════════════════════════════════════════════════
// PEPAGI — Memory System Orchestrator (All 5 Levels)
// ═══════════════════════════════════════════════════════════════

import type { Task, TaskOutput } from "../core/types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { WorkingMemory } from "./working-memory.js";
import { EpisodicMemory } from "./episodic-memory.js";
import { SemanticMemory } from "./semantic-memory.js";
import { ProceduralMemory } from "./procedural-memory.js";
import { MetaMemory } from "./meta-memory.js";
import { ConversationMemory } from "./conversation-memory.js";
import { Logger } from "../core/logger.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { temporalDecay } from "../meta/temporal-decay.js";
import { parseLLMJson } from "../core/parse-llm-json.js";
import type { PhenomenalStateEngine } from "../consciousness/phenomenal-state.js";

const logger = new Logger("MemorySystem");

export class MemorySystem {
  public working: WorkingMemory;
  public episodic: EpisodicMemory;
  public semantic: SemanticMemory;
  public procedural: ProceduralMemory;
  public meta: MetaMemory;
  public conversation: ConversationMemory;

  constructor(private llm: LLMProvider, private phenomenalState: PhenomenalStateEngine | null = null) {
    this.working = new WorkingMemory();
    this.episodic = new EpisodicMemory();
    this.semantic = new SemanticMemory();
    this.procedural = new ProceduralMemory();
    this.meta = new MetaMemory();
    this.conversation = new ConversationMemory();
  }

  /**
   * Wire in a PhenomenalStateEngine after construction (e.g. after ConsciousnessManager boots).
   * @param state - The phenomenal state engine instance
   */
  setPhenomenalState(state: PhenomenalStateEngine): void {
    this.phenomenalState = state;
  }

  /**
   * Get all relevant context for a task by querying all memory levels.
   * @returns Formatted context string to inject into mediator prompt
   */
  async getRelevantContext(task: Task): Promise<string> {
    const sections: string[] = [];

    // Level 1: Working memory (current task state)
    const wm = this.working.get(task.id);
    if (wm && wm.currentIteration > 0) {
      sections.push(`**Working Memory (current task):**\n${this.working.getContext(task.id)}`);
    }

    // Levels 2-4: Run episodic, semantic, and procedural searches in parallel
    const [episodicResult, semanticResult, proceduralResult] = await Promise.allSettled([
      this.episodic.search(task.description, 3),
      this.semantic.search(task.description, 5),
      this.procedural.findMatch(task.description),
    ]);

    // Level 2: Similar episodes
    if (episodicResult.status === "fulfilled" && Array.isArray(episodicResult.value) && episodicResult.value.length > 0) {
      const episodes = episodicResult.value;
      const epText = episodes.map(e => {
        const outcome = e.success ? "✓" : "✗";
        return `  ${outcome} "${e.taskTitle}" — ${e.resultSummary}`;
      }).join("\n");
      sections.push(`**Similar Past Tasks (${episodes.length}):**\n${epText}`);
    } else if (episodicResult.status === "rejected") {
      logger.debug("Episodic memory search failed", { error: String(episodicResult.reason) });
    }

    // Level 3: Relevant facts (with temporal decay applied)
    if (semanticResult.status === "fulfilled" && Array.isArray(semanticResult.value) && semanticResult.value.length > 0) {
      try {
        const facts = semanticResult.value;
        const decayedFacts = facts.map(f => {
          const lastVerifiedDate = new Date(f.lastVerified);
          const decayedConfidence = temporalDecay.decay(
            f.confidence,
            lastVerifiedDate,
            temporalDecay.factHalfLife,
          );
          return { ...f, confidence: Math.max(0, decayedConfidence) };
        }).filter(f => f.confidence >= 0.1);

        if (decayedFacts.length > 0) {
          const factResults = await Promise.allSettled(
            decayedFacts.map(f => this.meta.annotateContext(f.id, `• ${f.fact} [confidence: ${f.confidence.toFixed(2)}]`))
          );
          const factText = factResults.map((r, i) =>
            r.status === "fulfilled" ? r.value : `• ${decayedFacts[i]!.fact} [confidence: ${decayedFacts[i]!.confidence.toFixed(2)}]`
          );
          sections.push(`**Relevant Facts:**\n${factText.join("\n")}`);
        }
      } catch (err) {
        logger.debug("Semantic memory post-processing failed", { error: String(err) });
      }
    } else if (semanticResult.status === "rejected") {
      logger.debug("Semantic memory search failed", { error: String(semanticResult.reason) });
    }

    // Level 4: Matching procedure
    if (proceduralResult.status === "fulfilled" && proceduralResult.value) {
      try {
        const proc = proceduralResult.value;
        const reliability = await this.meta.getReliability(proc.id);
        sections.push(`**Known Procedure (${reliability >= 0.5 ? "reliable" : "⚠️ low reliability"}):**\n"${proc.name}"\nSteps:\n${proc.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
      } catch (err) {
        logger.debug("Procedural memory post-processing failed", { error: String(err) });
      }
    } else if (proceduralResult.status === "rejected") {
      logger.debug("Procedural memory search failed", { error: String(proceduralResult.reason) });
    }

    return sections.length > 0
      ? `\n---\n## Memory Context\n${sections.join("\n\n")}\n---`
      : "";
  }

  /**
   * Update all memory levels after task completion.
   */
  async learn(task: Task, output: TaskOutput): Promise<void> {
    // Level 1: Init working memory if not already
    this.working.init(task);

    // Level 2: Store episode
    try {
      const episode = await this.episodic.store(task, output);
      await this.meta.recordSuccess(episode.id, "episode");
      logger.debug("Stored episode", { taskId: task.id, episodeId: episode.id });
    } catch (err) {
      logger.warn("Failed to store episode", { taskId: task.id, error: String(err) });
    }

    // Level 3: Extract facts (from successes) or failure lessons (from failures)
    if (output.success) {
      try {
        await this.extractFacts(task, output);
      } catch (err) {
        logger.debug("Fact extraction failed", { error: String(err) });
      }
    } else if (output.summary) {
      try {
        await this.extractFailureLessons(task, output);
      } catch (err) {
        logger.debug("Failure lesson extraction failed", { error: String(err) });
      }
    }

    // Level 4: Check if this should become a procedure (relaxed: any successful task)
    if (output.success && task.attempts <= task.maxAttempts) {
      try {
        await this.maybeCreateProcedure(task, output);
      } catch (err) {
        logger.debug("maybeCreateProcedure failed", { taskId: task.id, error: String(err) });
      }
    }

    // Level 5: Update meta-memory
    const flagged = await this.meta.getFlagged();
    if (flagged.length > 0) {
      logger.debug(`${flagged.length} memories flagged for verification`);
    }
  }

  /** Extract factual learnings from completed task using cheap LLM */
  private async extractFacts(task: Task, output: TaskOutput): Promise<void> {
    const result = typeof output.result === "string" ? output.result : JSON.stringify(output.result);
    if (!result || result.length < 50) return;

    // Apply learning multiplier to determine how many facts to extract
    // Default 3 facts; multiplier of 2.0 → up to 6; multiplier of -0.5 → min 1
    const learningMultiplier = this.phenomenalState?.getLearningMultiplier() ?? 1.0;
    const maxFacts = Math.max(1, Math.round(3 * Math.max(0.35, learningMultiplier)));

    const response = await this.llm.quickClaude(
      `You extract factual learnings from completed tasks. Extract 0-${maxFacts} specific, reusable facts. Return ONLY a JSON array of strings, e.g. ["Fact 1", "Fact 2"]. If no good facts, return [].`,
      `Task: "${task.title}"\nResult: ${result.slice(0, 1000)}\n\nExtract specific facts worth remembering for future tasks.`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const facts = parseLLMJson(response.content);
      if (!Array.isArray(facts)) return;

      for (const fact of facts) {
        if (typeof fact === "string" && fact.length > 10) {
          await this.semantic.addFact({
            fact,
            source: task.id,
            confidence: output.confidence * 0.8,
            tags: task.tags,
          });
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  /** Extract lessons from failed tasks using cheap LLM */
  private async extractFailureLessons(task: Task, output: TaskOutput): Promise<void> {
    const summary = output.summary || "";
    const errorInfo = task.lastError || "";
    const combined = `${summary} ${errorInfo}`.trim();
    if (combined.length < 20) return;

    const response = await this.llm.quickClaude(
      "You extract lessons from failed AI tasks. Extract 1-2 specific facts about what doesn't work and why. " +
      "Return ONLY a JSON array: [{\"fact\": \"...\", \"confidence\": 0.4-0.8}]. If nothing useful, return [].",
      `Task: "${task.title}"\nFailure: ${combined.slice(0, 800)}\n\nWhat specific lesson can we learn from this failure?`,
      CHEAP_CLAUDE_MODEL,
      true,
    );

    try {
      const lessons = parseLLMJson(response.content);
      if (!Array.isArray(lessons)) return;

      for (const lesson of lessons) {
        if (typeof lesson === "object" && lesson !== null && "fact" in lesson) {
          const fact = String((lesson as { fact: string }).fact);
          const confidence = typeof (lesson as { confidence?: number }).confidence === "number"
            ? Math.min(0.8, Math.max(0.4, (lesson as { confidence: number }).confidence))
            : 0.5;
          if (fact.length > 10) {
            await this.semantic.addFact({
              fact,
              source: task.id,
              confidence,
              tags: [...task.tags, "failure-lesson"],
            });
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  /** Create a procedure if task type repeats */
  private async maybeCreateProcedure(task: Task, output: TaskOutput): Promise<void> {
    // Skip procedure creation when satisfied/stable — system already knows this approach well
    const learningMultiplier = this.phenomenalState?.getLearningMultiplier() ?? 1.0;
    if (learningMultiplier < 0.8) {
      logger.debug("maybeCreateProcedure: skipping — learning multiplier too low (satisfied/stable)", { multiplier: learningMultiplier });
      return;
    }

    // Check if similar task types exist in episodic memory
    const similar = await this.episodic.search(task.title, 5);
    const successfulSimilar = similar.filter(e => e.success && e.id !== task.id);

    if (successfulSimilar.length >= 1) {
      // Create a simple procedure
      const steps = output.summary
        .split(/[.!]/)
        .map(s => s.trim())
        .filter(s => s.length > 10)
        .slice(0, 5);

      if (steps.length >= 2) {
        await this.procedural.store({
          name: `Procedure for: ${task.title.slice(0, 50)}`,
          description: task.description.slice(0, 200),
          triggerPattern: task.tags.join(", ") || task.title.split(" ").slice(0, 3).join(" "),
          steps,
          cost: task.estimatedCost,
        });
        logger.debug("Created new procedure from repeated successful task", { taskId: task.id });
      }
    }
  }

  /**
   * Consolidate old successful episodes into semantic facts.
   * Finds episodes older than 7 days with success=true and confidence > 0.6,
   * extracts 1-3 semantic facts from each via the cheap LLM, and saves them.
   */
  async consolidate(): Promise<void> {
    let newFactCount = 0;
    let consolidatedCount = 0;

    try {
      const allEpisodes = await this.episodic.getRecent(100);

      const eligible = allEpisodes.filter(ep =>
        temporalDecay.shouldConsolidate({
          confidence: ep.success ? 0.8 : 0.3,
          createdAt: new Date(ep.timestamp),
          success: ep.success,
        }),
      );

      for (const episode of eligible) {
        consolidatedCount++;
        try {
          const response = await this.llm.quickClaude(
            "You extract reusable semantic facts from completed task episodes. " +
            "Return ONLY a JSON array of 1-3 short factual strings worth remembering for future tasks. " +
            "If nothing generalizable, return [].",
            `Episode title: "${episode.taskTitle}"\n` +
            `Description: ${episode.taskDescription}\n` +
            `Result: ${episode.resultSummary}\n` +
            `Tags: ${episode.tags.join(", ")}\n\n` +
            "Extract 1-3 specific, reusable facts.",
            CHEAP_CLAUDE_MODEL,
            true,
          );

          const parsed = parseLLMJson(response.content);
          if (!Array.isArray(parsed)) continue;

          for (const item of parsed) {
            if (typeof item === "string" && item.length > 10) {
              await this.semantic.addFact({
                fact: item,
                source: episode.id,
                confidence: 0.7,
                tags: episode.tags,
              });
              newFactCount++;
            }
          }
        } catch {
          // Skip episodes that fail to parse — log at debug level
          logger.debug("consolidate: failed to extract facts from episode", { episodeId: episode.id });
        }
      }

      logger.info(`Consolidated ${consolidatedCount} episodes → ${newFactCount} new facts`);
    } catch (err) {
      logger.warn("Memory consolidation failed", { error: String(err) });
    }
  }

  /** Get memory statistics for display */
  async getStats(): Promise<Record<string, unknown>> {
    const [ep, sem, proc] = await Promise.all([
      this.episodic.getStats(),
      this.semantic.getStats(),
      this.procedural.getStats(),
    ]);

    return {
      episodic: ep,
      semantic: sem,
      procedural: proc,
    };
  }
}
