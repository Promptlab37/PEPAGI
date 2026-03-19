// ═══════════════════════════════════════════════════════════════
// PEPAGI — World Model (Mental Simulation)
// ═══════════════════════════════════════════════════════════════

import { z } from "zod";
import type { AgentProvider, DifficultyLevel } from "../core/types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { parseLLMJson } from "../core/parse-llm-json.js";

// ERR-01 + TS-02: Zod schema for individual scenario simulation responses from the LLM.
// Prevents NaN propagation when the LLM returns unexpected or missing fields.
// .default() ensures that even a *successful* parse of a partial object never yields
// undefined — every field is guaranteed to carry a safe value after validation.
const WorldModelResponseSchema = z.object({
  successProbability: z.number().min(0).max(1).optional().default(0.7),
  estimatedCost: z.number().optional(),                       // no universal default — falls back to scenario.estimatedCost below
  speed: z.enum(["fast", "medium", "slow"]).optional().default("medium"),
  risks: z.array(z.string()).optional().default([]),
  recommendation: z.string().optional().default(""),
});

const logger = new Logger("WorldModel");

export interface SimulationScenario {
  description: string;
  agent: AgentProvider;
  estimatedCost: number;
  taskDifficulty: DifficultyLevel;
  approach?: string;
}

export interface SimulationResult {
  scenario: SimulationScenario;
  predictedSuccess: number;   // 0-1
  predictedCost: number;      // USD
  predictedDuration: "fast" | "medium" | "slow";
  risks: string[];
  recommendation: string;
}

interface CacheEntry {
  key: string;
  results: SimulationResult[];
  timestamp: number;
}

export class WorldModel {
  private cache: CacheEntry[] = [];
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private llm: LLMProvider) {}

  /**
   * Simulate multiple scenarios and return ranked results.
   * Uses the cheapest available model (Haiku).
   */
  async simulate(scenarios: SimulationScenario[]): Promise<SimulationResult[]> {
    const cacheKey = JSON.stringify(scenarios.map(s => ({ d: s.description.slice(0, 50), a: s.agent })));

    // Check cache
    const cached = this.cache.find(c => c.key === cacheKey && Date.now() - c.timestamp < this.CACHE_TTL);
    if (cached) {
      logger.debug("World model cache hit");
      return cached.results;
    }

    const scenarioText = scenarios.map((s, i) => {
      const safeDesc = s.description.slice(0, 100).replace(/[<>&"]/g, c =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c
      );
      return `Scenario ${i + 1}: Assign <task_desc>${safeDesc}</task_desc> to ${s.agent} (difficulty=${s.taskDifficulty}, budget=$${s.estimatedCost.toFixed(3)})`;
    }).join("\n");

    const prompt = `Simulate these task scenarios and predict outcomes:

${scenarioText}

For each scenario, predict:
- successProbability: 0.0-1.0
- estimatedCost: USD amount
- speed: "fast" | "medium" | "slow"
- risks: array of potential issues
- recommendation: one sentence

Respond with ONLY a JSON array matching the scenario count:
[{"successProbability": 0.85, "estimatedCost": 0.02, "speed": "medium", "risks": ["..."], "recommendation": "..."}]`;

    try {
      const response = await this.llm.quickClaude(
        "You are a simulation engine that predicts outcomes of AI task assignments. Be realistic and concise.",
        prompt,
        CHEAP_CLAUDE_MODEL,
        true,
      );

      // ERR-01 + TS-02: Parse raw JSON then validate each element with Zod instead of
      // blindly casting. Invalid/missing fields fall back to safe defaults, preventing NaN.
      let rawParsed: unknown;
      try {
        rawParsed = parseLLMJson(response.content);
      } catch {
        // If the LLM response is not valid JSON at all, rawParsed stays undefined
        // and every scenario will use its heuristic fallback below.
        rawParsed = [];
      }
      const rawArray = Array.isArray(rawParsed) ? rawParsed : [];

      const results: SimulationResult[] = scenarios.map((scenario, i) => {
        const rawItem = rawArray[i] ?? {};
        // safeParse so a malformed entry never throws — we fall back to safe defaults on
        // failure. The explicit type annotation on `sim` prevents TS18047/TS2339 when
        // safeParse returns false (the .default() values in the schema guarantee the
        // success branch always carries concrete values, not undefined).
        const parseResult = WorldModelResponseSchema.safeParse(rawItem);
        const sim: Partial<{ successProbability: number; estimatedCost: number; speed: "fast" | "medium" | "slow"; risks: string[]; recommendation: string }> =
          parseResult.success ? parseResult.data : {};
        return {
          scenario,
          predictedSuccess: Math.min(1, Math.max(0, sim.successProbability ?? 0.7)),
          predictedCost: sim.estimatedCost ?? scenario.estimatedCost,
          predictedDuration: sim.speed ?? "medium",
          risks: sim.risks ?? [],
          recommendation: sim.recommendation ?? "",
        };
      });

      // Cache results (AUD-02: TTL prune + size cap to prevent unbounded growth)
      this.cache = this.cache.filter(c => Date.now() - c.timestamp < this.CACHE_TTL);
      if (this.cache.length >= 50) this.cache = this.cache.slice(-25);
      this.cache.push({ key: cacheKey, results, timestamp: Date.now() });

      // Emit TUI event for neural stream display
      const bestIdx  = this.pickBest(results);
      const best     = results[bestIdx];
      const taskId   = scenarios[0]?.description.slice(0, 36) ?? "unknown";
      if (best) {
        eventBus.emit({
          type: "world:simulated",
          taskId,
          scenarios: results.length,
          winner: best.scenario.agent,
          predictedSuccess: best.predictedSuccess,
        });
      }

      return results;
    } catch (err) {
      logger.warn("World model simulation failed, using heuristics", { error: String(err) });
      // Fallback heuristics
      return scenarios.map(s => ({
        scenario: s,
        predictedSuccess: s.taskDifficulty === "trivial" ? 0.99 : s.taskDifficulty === "complex" ? 0.6 : 0.8,
        predictedCost: s.estimatedCost,
        predictedDuration: s.taskDifficulty === "trivial" ? "fast" : s.taskDifficulty === "complex" ? "slow" : "medium" as "fast" | "medium" | "slow",
        risks: [],
        recommendation: "Proceed based on difficulty estimate",
      }));
    }
  }

  /**
   * MCTS-inspired: pick the best strategy from multiple options.
   * @returns Index of best scenario (highest success × lowest cost)
   */
  pickBest(results: SimulationResult[]): number {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      // Score = success_probability / (1 + cost) — prefer high success, low cost
      const score = r.predictedSuccess / (1 + r.predictedCost * 10);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return bestIdx;
  }
}
