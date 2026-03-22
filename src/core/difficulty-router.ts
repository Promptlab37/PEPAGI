// ═══════════════════════════════════════════════════════════════
// PEPAGI — Difficulty-Aware Router (DAAO-inspired)
// ═══════════════════════════════════════════════════════════════

import type { DifficultyLevel, AgentProvider } from "../core/types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { AgentPool } from "../agents/agent-pool.js";
import type { QualiaVector } from "../consciousness/phenomenal-state.js";
import { Logger } from "./logger.js";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

const logger = new Logger("DifficultyRouter");

export interface AgentPerformanceProfile {
  agent: AgentProvider;
  taskType: string;
  successRate: number;
  avgCost: number;
  sampleCount: number;
}

const PROFILES_PATH = join(PEPAGI_DATA_DIR, "memory", "agent-profiles.jsonl");

export interface RoutingDecision {
  difficulty: DifficultyLevel;
  // BUG-04: null when no agents are available instead of always defaulting to "claude"
  recommendedAgent: AgentProvider | null;
  useWorldModel: boolean;
  useSwarm: boolean;
  requiresVerification: boolean;
  reasoning: string;
}

export class DifficultyRouter {
  private profiles: AgentPerformanceProfile[] = [];
  private loaded = false;
  /** LLM difficulty classification cache — keyed by first 200 chars, 10-min TTL */
  private difficultyCache = new Map<string, { difficulty: DifficultyLevel; timestamp: number }>();
  private static readonly CACHE_TTL_MS = 10 * 60_000;

  constructor(
    private llm: LLMProvider,
    private pool: AgentPool,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(PROFILES_PATH)) {
      const content = await readFile(PROFILES_PATH, "utf8");
      this.profiles = content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as AgentPerformanceProfile);
    }
    this.loaded = true;
  }

  private async saveProfiles(): Promise<void> {
    const lines = this.profiles.map(p => JSON.stringify(p)).join("\n") + "\n";
    // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
    const tmpPath = `${PROFILES_PATH}.tmp.${process.pid}`;
    await writeFile(tmpPath, lines, "utf8");
    await rename(tmpPath, PROFILES_PATH);
  }

  /**
   * Estimate task difficulty using cheap LLM classification.
   */
  async estimateDifficulty(taskDescription: string): Promise<DifficultyLevel> {
    const heuristicDiff = this.heuristicDifficulty(taskDescription);

    // For simple tasks, trust heuristics
    if (heuristicDiff === "trivial" || heuristicDiff === "simple") {
      return heuristicDiff;
    }

    // Check LLM cache before calling the model
    const cacheKey = taskDescription.slice(0, 200).toLowerCase();
    const cached = this.difficultyCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DifficultyRouter.CACHE_TTL_MS) {
      return cached.difficulty;
    }

    try {
      const response = await this.llm.quickCall(
        `Classify task difficulty as one of: trivial, simple, medium, complex, unknown.
trivial: Single-step, no creativity needed (e.g., "what is 2+2?")
simple: A few steps, clear requirements (e.g., "write a hello world")
medium: Multiple steps, some complexity (e.g., "build a REST API endpoint")
complex: Many components, high uncertainty (e.g., "architect a distributed system")
unknown: Unclear requirements or novel problem

Respond with ONLY the difficulty word, nothing else.`,
        taskDescription.slice(0, 500),
      );

      const diff = (["trivial", "simple", "medium", "complex", "unknown"].includes(response.content.trim().toLowerCase())
        ? response.content.trim().toLowerCase()
        : "medium") as DifficultyLevel;
      this.difficultyCache.set(cacheKey, { difficulty: diff, timestamp: Date.now() });
      return diff;
    } catch {
      return heuristicDiff;
    }
  }

  /** Heuristic difficulty estimation (no LLM) */
  private heuristicDifficulty(desc: string): DifficultyLevel {
    const words = desc.split(/\s+/).length;
    const lower = desc.toLowerCase();

    // English technical terms
    const technicalTerms = (desc.match(/\b(?:api|database|deploy|architecture|distributed|microservice|algorithm|optimize|integrate|migrate|refactor|server|docker|kubernetes)\b/gi) ?? []).length;
    const constraints = (desc.match(/\b(?:must|requirement|constraint|ensure|guarantee)\b/gi) ?? []).length;

    // Coding/tool intent — Czech + English keywords that indicate real work
    const needsTools = /\b(code|file|script|install|deploy|build|test|write|create|fix|debug|generate|implement|analyze|edit|refactor|bug|error|pdf|report)\b/i.test(desc)
      || /(?:^|\W)(soubor|napiš|vytvoř|oprav|spusť|najdi|stáhni|kód|skript|projekt|chybu?|sestav|uprav|přepiš|vylepši|analyzuj|prozkoumej|projdi|zkontroluj)(?:$|\W)/i.test(desc);

    // Short conversational messages WITHOUT tool intent → trivial
    if (words <= 15 && technicalTerms === 0 && !needsTools) return "trivial";
    // Short messages WITH tool intent → at least simple (getAgentBudget promotes to medium)
    if (words <= 15 && needsTools) return "simple";
    if (words < 30 && technicalTerms <= 1 && !needsTools) return "simple";
    if (technicalTerms >= 3 || constraints >= 3) return "complex";
    // Tool tasks with moderate length → medium
    if (needsTools) return "medium";
    return "medium";
  }

  /**
   * Make a routing decision based on task difficulty.
   * Optionally accepts qualia for consciousness-driven routing (C6.1):
   * Frustrated Pepagi prefers more reliable (expensive) agents.
   */
  async route(taskDescription: string, qualia?: QualiaVector): Promise<RoutingDecision | null> {
    await this.ensureLoaded();
    const difficulty = await this.estimateDifficulty(taskDescription);
    const available = this.pool.getAvailableAgents();

    const taskType = this.extractTaskType(taskDescription);
    const bestAgent = this.getBestAgentForType(taskType, available.map(a => a.provider));

    // Consciousness-driven routing: frustrovaný Pepagi preferuje jistější (dražší) agenty
    const isFrustrated = qualia ? qualia.frustration > 0.6 : false;
    const isUncertain = qualia ? qualia.confidence < 0.4 : false;
    const preferReliable = isFrustrated || isUncertain;

    // BUG-04: was returning "claude" even when no agents available, causing guaranteed failure
    if (!available[0]) return null;
    const safeAgent = available[0].provider;
    // When preferring reliability (frustrated/uncertain), use claude if available in the pool —
    // claude is the most trusted model; fall back to first available if claude is not present.
    const reliableAgent = preferReliable
      ? (available.find(a => a.provider === "claude") ?? available[0]).provider
      : safeAgent;
    const routedAgent = preferReliable ? reliableAgent : (bestAgent ?? safeAgent);

    const qualiaNote = preferReliable
      ? ` [Qualia: frustrace=${qualia?.frustration?.toFixed(2)}/důvěra=${qualia?.confidence?.toFixed(2)} → preferuji jistější model]`
      : "";

    // Prefer Ollama or Kiro (free local providers) for trivial/simple tasks when available and not frustrated
    const ollamaAgent = available.find(a => a.provider === "ollama");
    const kiroAgent = available.find(a => a.provider === "kiro");
    const preferLocal = (ollamaAgent || kiroAgent) && !preferReliable;
    const localAgent: AgentProvider = ollamaAgent ? "ollama" : "kiro";

    switch (difficulty) {
      case "trivial":
        return {
          difficulty, recommendedAgent: preferReliable ? reliableAgent : (preferLocal ? localAgent : (bestAgent ?? safeAgent)),
          useWorldModel: false, useSwarm: false, requiresVerification: false,
          reasoning: preferLocal
            ? `Trivial task — using free local ${localAgent === "ollama" ? "Ollama (gemma3:12b)" : "Kiro CLI (ACP)"}${qualiaNote}`
            : `Trivial task — cheapest agent, no overhead${qualiaNote}`,
        };
      case "simple":
        return {
          difficulty, recommendedAgent: preferReliable ? routedAgent : (preferLocal ? localAgent : routedAgent),
          useWorldModel: false, useSwarm: false, requiresVerification: preferReliable,
          reasoning: preferLocal
            ? `Simple task — using free local ${localAgent === "ollama" ? "Ollama (gemma3:12b)" : "Kiro CLI (ACP)"}${qualiaNote}`
            : `Simple task — basic confidence check${qualiaNote}`,
        };
      case "medium":
        return {
          difficulty, recommendedAgent: routedAgent,
          useWorldModel: true, useSwarm: preferReliable, requiresVerification: true,
          reasoning: `Medium task — world model simulation + verification${qualiaNote}`,
        };
      case "complex":
        return {
          difficulty, recommendedAgent: safeAgent,
          useWorldModel: true, useSwarm: preferReliable, requiresVerification: true,
          reasoning: `Complex task — best model, MCTS, double verification${qualiaNote}`,
        };
      case "unknown":
      default:
        return {
          difficulty, recommendedAgent: safeAgent,
          useWorldModel: true, useSwarm: true, requiresVerification: true,
          reasoning: `Unknown difficulty — escalate to swarm${qualiaNote}`,
        };
    }
  }

  /** Extract task type keywords for profile lookup */
  private extractTaskType(desc: string): string {
    const types = ["code", "write", "analyze", "debug", "deploy", "design", "research", "summarize"];
    for (const t of types) {
      if (desc.toLowerCase().includes(t)) return t;
    }
    return "general";
  }

  /** Get best agent based on historical performance */
  private getBestAgentForType(taskType: string, available: AgentProvider[]): AgentProvider | null {
    const relevant = this.profiles.filter(
      p => p.taskType === taskType && available.includes(p.agent) && p.sampleCount >= 3
    );

    if (relevant.length === 0) return null;

    // Score = success_rate / (1 + avg_cost * 10)
    return relevant.reduce((best: AgentPerformanceProfile, p: AgentPerformanceProfile) => {
      const score = p.successRate / (1 + p.avgCost * 10);
      const bestScore = best.successRate / (1 + best.avgCost * 10);
      return score > bestScore ? p : best;
    }).agent;
  }

  /** Record outcome for performance learning */
  async recordOutcome(agent: AgentProvider, taskType: string, success: boolean, cost: number): Promise<void> {
    await this.ensureLoaded();

    const existing = this.profiles.find(p => p.agent === agent && p.taskType === taskType);
    if (existing) {
      existing.successRate = existing.successRate * 0.8 + (success ? 0.2 : 0);
      existing.avgCost = existing.avgCost * 0.8 + cost * 0.2;
      existing.sampleCount++;
    } else {
      this.profiles.push({
        agent, taskType,
        successRate: success ? 1 : 0,
        avgCost: cost,
        sampleCount: 1,
      });
    }

    await this.saveProfiles();
  }
}
