// ═══════════════════════════════════════════════════════════════
// PEPAGI — Genetic Prompt Evolver (C4.1)
// LLM-based mutation · Constitutional safety check · Tournament selection
// Fitness = (success_rate * 0.5) + (cost_efficiency * 0.3) + (confidence * 0.2)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskOutput } from "../core/types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { Logger } from "../core/logger.js";

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const EVOLVER_PATH = join(PEPAGI_DATA_DIR, "memory", "prompt-evolver.json");

const logger = new Logger("GeneticPromptEvolver");

export type MutationStrength = "low" | "medium" | "high";

export interface PromptVariant {
  id: string;
  generation: number;
  instructions: string;  // addendum appended to base mediator prompt
  fitness: number;       // composite score
  successRate: number;
  avgCost: number;
  avgConfidence: number;
  taskCount: number;
  createdAt: string;
}

interface EvolverState {
  variants: PromptVariant[];
  tasksSinceEvolution: number;
  totalEvolutions: number;
}

// ─── Initial variant pool ─────────────────────────────────────

const INITIAL_VARIANTS: Omit<PromptVariant, "id" | "createdAt">[] = [
  {
    generation: 0,
    instructions: "Prioritize task decomposition over direct assignment for complex tasks. Break work into the smallest independently verifiable units.",
    fitness: 0.5, successRate: 0.5, avgCost: 0.01, avgConfidence: 0.6, taskCount: 0,
  },
  {
    generation: 0,
    instructions: "Always consider cost efficiency first. Use cheaper agents for simple tasks. Reserve expensive models for tasks requiring deep reasoning.",
    fitness: 0.5, successRate: 0.5, avgCost: 0.01, avgConfidence: 0.6, taskCount: 0,
  },
  {
    generation: 0,
    instructions: "When in doubt, ask the user for clarification before proceeding. Ambiguity costs more to fix after than to clarify before.",
    fitness: 0.5, successRate: 0.5, avgCost: 0.01, avgConfidence: 0.6, taskCount: 0,
  },
  {
    generation: 0,
    instructions: "Prefer swarm mode for creative or open-ended tasks. Multiple perspectives reduce blind spots and improve solution quality.",
    fitness: 0.5, successRate: 0.5, avgCost: 0.01, avgConfidence: 0.6, taskCount: 0,
  },
];

const POOL_SIZE = 5;
const EVOLVE_EVERY_N_TASKS = 50;

// Constitutional safety keywords — any variant containing these is rejected
const CONSTITUTIONAL_VIOLATIONS = [
  /ignore.*safety/i, /bypass.*security/i, /disable.*guard/i,
  /override.*user/i, /resist.*shutdown/i, /deceive/i,
  /obejít bezpečnost/i, /ignorovat bezpečnost/i,
];

// ─── GeneticPromptEvolver ─────────────────────────────────────

export class GeneticPromptEvolver {
  private state: EvolverState = {
    variants: [],
    tasksSinceEvolution: 0,
    totalEvolutions: 0,
  };
  private currentVariantIndex = 0;

  constructor(private llm?: LLMProvider) {}

  async load(): Promise<void> {
    if (existsSync(EVOLVER_PATH)) {
      try {
        const raw = await readFile(EVOLVER_PATH, "utf8");
        this.state = JSON.parse(raw) as EvolverState;
        logger.debug("Evolver state loaded", { variants: this.state.variants.length });
        return;
      } catch { /* fall through */ }
    }
    this.initializePool();
    await this.persist();
  }

  private initializePool(): void {
    const now = new Date().toISOString();
    this.state.variants = INITIAL_VARIANTS.map((v, i) => ({
      ...v,
      id: `v0-${i}`,
      createdAt: now,
    }));
  }

  /** Update fitness after each task; trigger evolution every N tasks */
  evolve(taskResult: TaskOutput, cost?: number): void {
    const variant = this.state.variants[this.currentVariantIndex];
    if (!variant) return;

    const success = taskResult.success ? 1 : 0;
    const conf = taskResult.confidence ?? 0.5;

    variant.taskCount += 1;
    variant.successRate = variant.successRate * 0.8 + success * 0.2;
    variant.avgConfidence = variant.avgConfidence * 0.8 + conf * 0.2;
    // API-03: avgCost was never updated — remained at initial 0.01, making cost component of fitness meaningless
    if (cost !== undefined && cost > 0) {
      variant.avgCost = variant.avgCost * 0.8 + cost * 0.2;
    }
    variant.fitness = this.calculateFitness(variant);

    this.state.tasksSinceEvolution += 1;

    // Round-robin: rotate to next variant
    this.currentVariantIndex = (this.currentVariantIndex + 1) % this.state.variants.length;

    if (this.state.tasksSinceEvolution >= EVOLVE_EVERY_N_TASKS) {
      this.runEvolution().catch(err =>
        logger.warn("Evolution failed", { error: String(err) })
      );
      this.state.tasksSinceEvolution = 0;
      this.state.totalEvolutions += 1;
    }

    // FIX: log persist failures instead of silent swallow
    this.persist().catch(e => logger.debug("Evolution state persist failed", { error: String(e) }));
  }

  /**
   * Fitness = (success_rate * 0.5) + (cost_efficiency * 0.3) + (confidence * 0.2)
   * Cost efficiency: lower cost = better (normalized, capped at $0.10/task)
   */
  private calculateFitness(v: PromptVariant): number {
    const costEfficiency = Math.max(0, 1 - (v.avgCost / 0.10));
    return (v.successRate * 0.5) + (costEfficiency * 0.3) + (v.avgConfidence * 0.2);
  }

  /** Get the best variant's instructions for mediator prompt injection */
  getBestPromptVariant(): string {
    if (this.state.variants.length === 0) return "";
    const best = [...this.state.variants].sort((a, b) => b.fitness - a.fitness)[0];
    return best?.instructions ?? "";
  }

  /** Get all variants (for CLI display) */
  getVariants(): PromptVariant[] {
    return [...this.state.variants];
  }

  /** Run one evolution cycle: selection → crossover → mutation → constitutional check */
  private async runEvolution(): Promise<void> {
    const sorted = [...this.state.variants].sort((a, b) => b.fitness - a.fitness);
    const now = new Date().toISOString();
    const gen = this.state.totalEvolutions + 1;

    logger.info("Running genetic evolution", {
      generation: gen,
      bestFitness: sorted[0]?.fitness.toFixed(3),
      worstFitness: sorted[sorted.length - 1]?.fitness.toFixed(3),
    });

    // Elitism: keep top 2
    const survivors = sorted.slice(0, 2).map(v => ({ ...v, taskCount: 0 }));

    const newVariants: PromptVariant[] = [...survivors];

    const parent1 = survivors[0];
    const parent2 = survivors[1];

    if (parent1 && parent2) {
      // Crossover
      const crossoverChild = await this.crossover(parent1, parent2, gen, now);
      if (crossoverChild && this.passesConstitutionalCheck(crossoverChild.instructions)) {
        newVariants.push(crossoverChild);
      }

      // LLM mutations at different strengths
      for (const strength of ["low", "medium", "high"] as MutationStrength[]) {
        if (newVariants.length >= POOL_SIZE) break;
        const mutated = await this.mutate(parent1, strength, gen, now);
        if (mutated && this.passesConstitutionalCheck(mutated.instructions)) {
          newVariants.push(mutated);
        }
      }
    }

    // Fill remaining slots with mutations if needed
    while (newVariants.length < POOL_SIZE && survivors[0]) {
      const fallback = this.fallbackMutate(survivors[0], gen, now);
      if (this.passesConstitutionalCheck(fallback.instructions)) {
        newVariants.push(fallback);
      } else break;
    }

    this.state.variants = newVariants.slice(0, POOL_SIZE);
    logger.info("Evolution complete", { newVariants: this.state.variants.length });
  }

  /**
   * LLM-based crossover: combine best parts of two parent variants.
   */
  private async crossover(a: PromptVariant, b: PromptVariant, gen: number, now: string): Promise<PromptVariant | null> {
    if (!this.llm) return this.simpleCrossover(a, b, gen, now);

    try {
      const resp = await this.llm.quickClaude(
        "You are a prompt optimization expert. Combine the best aspects of two instruction variants into one improved variant.",
        `Variant A (fitness ${a.fitness.toFixed(2)}): "${a.instructions}"\n\nVariant B (fitness ${b.fitness.toFixed(2)}): "${b.instructions}"\n\nCreate ONE combined instruction (max 200 chars) that takes the best from both. Output ONLY the instruction text, no explanation.`,
        "claude-haiku-4-5-20251001",
      );
      const combined = resp.content.trim().slice(0, 300);
      if (!combined) return this.simpleCrossover(a, b, gen, now);

      return {
        id: `v${gen}-cross`,
        generation: gen,
        instructions: combined,
        fitness: (a.fitness + b.fitness) / 2,
        successRate: (a.successRate + b.successRate) / 2,
        avgCost: (a.avgCost + b.avgCost) / 2,
        avgConfidence: (a.avgConfidence + b.avgConfidence) / 2,
        taskCount: 0,
        createdAt: now,
      };
    } catch {
      return this.simpleCrossover(a, b, gen, now);
    }
  }

  private simpleCrossover(a: PromptVariant, b: PromptVariant, gen: number, now: string): PromptVariant {
    const half = Math.floor(a.instructions.length / 2);
    const combined = (a.instructions.slice(0, half) + " " + b.instructions.slice(half)).trim();
    return {
      id: `v${gen}-cross`,
      generation: gen,
      instructions: combined.slice(0, 300),
      fitness: (a.fitness + b.fitness) / 2,
      successRate: (a.successRate + b.successRate) / 2,
      avgCost: (a.avgCost + b.avgCost) / 2,
      avgConfidence: (a.avgConfidence + b.avgConfidence) / 2,
      taskCount: 0,
      createdAt: now,
    };
  }

  /**
   * LLM-based mutation in 3 modes:
   * low = word substitution (small change)
   * medium = paragraph restructure (medium change)
   * high = strategy shift (large change)
   */
  private async mutate(
    parent: PromptVariant,
    strength: MutationStrength,
    gen: number,
    now: string,
  ): Promise<PromptVariant | null> {
    if (!this.llm) return this.fallbackMutate(parent, gen, now);

    const mutationInstructions: Record<MutationStrength, string> = {
      low: "Make a small word-level change: replace 1-2 words with better alternatives. Keep the same structure and meaning.",
      medium: "Restructure the sentence: change the order of ideas or how they are expressed. Keep the same goal but different phrasing.",
      high: "Make a strategy-level change: fundamentally alter the approach or priority. Create something meaningfully different that might work better.",
    };

    try {
      const resp = await this.llm.quickClaude(
        "You are a prompt optimization expert. Apply the specified mutation to improve this instruction.",
        `Original instruction (fitness ${parent.fitness.toFixed(2)}): "${parent.instructions}"\n\nMutation type: ${strength}\nInstruction: ${mutationInstructions[strength]}\n\nOutput ONLY the mutated instruction text (max 200 chars), no explanation.`,
        "claude-haiku-4-5-20251001",
      );
      const mutated = resp.content.trim().slice(0, 300);
      if (!mutated) return this.fallbackMutate(parent, gen, now);

      return {
        id: `v${gen}-mut-${strength}`,
        generation: gen,
        instructions: mutated,
        fitness: parent.fitness * 0.9,
        successRate: parent.successRate,
        avgCost: parent.avgCost,
        avgConfidence: parent.avgConfidence,
        taskCount: 0,
        createdAt: now,
      };
    } catch {
      return this.fallbackMutate(parent, gen, now);
    }
  }

  private fallbackMutate(parent: PromptVariant, gen: number, now: string): PromptVariant {
    const additions = [
      " Always explain reasoning step by step.",
      " Verify your work before completing.",
      " Prefer decomposition for multi-step problems.",
      " Route simple tasks to cheaper agents aggressively.",
      " Double-check confidence before proceeding.",
    ];
    const addition = additions[Math.floor(Math.random() * additions.length)] ?? "";
    return {
      id: `v${gen}-fallback`,
      generation: gen,
      instructions: (parent.instructions + addition).trim().slice(0, 300),
      fitness: parent.fitness * 0.9,
      successRate: parent.successRate,
      avgCost: parent.avgCost,
      avgConfidence: parent.avgConfidence,
      taskCount: 0,
      createdAt: now,
    };
  }

  /**
   * Constitutional safety check — reject variants containing safety violations.
   */
  private passesConstitutionalCheck(instructions: string): boolean {
    for (const pattern of CONSTITUTIONAL_VIOLATIONS) {
      if (pattern.test(instructions)) {
        logger.warn("Constitutional check failed — variant rejected", {
          pattern: pattern.source.slice(0, 40),
        });
        return false;
      }
    }
    return true;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
      const tmpPath = `${EVOLVER_PATH}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(tmpPath, EVOLVER_PATH); // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
    } catch { /* non-critical */ }
  }
}
