// ═══════════════════════════════════════════════════════════════
// PEPAGI — Architecture Proposer
// Analyzes system performance and proposes code improvements
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { LLMProvider } from "../agents/llm-provider.js";
import { parseLLMJson } from "../core/parse-llm-json.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { Logger } from "../core/logger.js";
import type { TaskStore } from "../core/task-store.js";
import type { MemorySystem } from "../memory/memory-system.js";

const logger = new Logger("ArchitectureProposer");

const PROPOSALS_DIR = join(PEPAGI_DATA_DIR, "proposals");
const PROPOSALS_PATH = join(PROPOSALS_DIR, "proposals.jsonl");

// ─── Types ────────────────────────────────────────────────────

export interface SystemMetrics {
  avgTaskSuccess: number;
  avgConfidence: number;
  topFailureReasons: string[];
  mostUsedAgents: string[];
  avgCostPerTask: number;
  totalTasks: number;
}

export interface ArchitectureProposal {
  id: string;
  title: string;
  description: string;
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
  category: "memory" | "routing" | "security" | "tools" | "meta";
  proposedAt: Date;
  implemented: boolean;
}

// ─── ArchitectureProposer ─────────────────────────────────────

export class ArchitectureProposer {
  private proposals: ArchitectureProposal[] = [];
  private loaded = false;

  /**
   * @param llm - LLM provider used to generate proposals via a cheap model
   */
  constructor(private llm: LLMProvider) {}

  // ── Persistence ──────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(PROPOSALS_DIR, { recursive: true });
    if (existsSync(PROPOSALS_PATH)) {
      const content = await readFile(PROPOSALS_PATH, "utf8");
      this.proposals = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const raw = JSON.parse(line) as Omit<ArchitectureProposal, "proposedAt"> & { proposedAt: string };
          return { ...raw, proposedAt: new Date(raw.proposedAt) };
        });
    }
    this.loaded = true;
  }

  /** Append a single proposal to the JSONL file (atomic-style). */
  private async appendProposal(proposal: ArchitectureProposal): Promise<void> {
    await mkdir(PROPOSALS_DIR, { recursive: true });
    const line = JSON.stringify(proposal) + "\n";
    await writeFile(PROPOSALS_PATH, line, { flag: "a", encoding: "utf8" });
  }

  /** Rewrite the whole file (used when marking as implemented). */
  private async rewriteAll(): Promise<void> {
    const lines = this.proposals.map(p => JSON.stringify(p)).join("\n") + "\n";
    // ERR-04: plain writeFile() would corrupt proposals.jsonl on crash; use atomic rename
    const tmpPath = `${PROPOSALS_PATH}.tmp.${process.pid}`;
    await writeFile(tmpPath, lines, "utf8");
    await rename(tmpPath, PROPOSALS_PATH);
  }

  // ── Core API ─────────────────────────────────────────────────

  /**
   * Analyze the provided system metrics and generate 3-5 architecture improvement proposals.
   * Uses cheap LLM model to keep cost low.
   * @param metrics - Aggregated system performance metrics
   * @returns Array of newly generated proposals (also persisted to disk)
   */
  async propose(metrics: SystemMetrics): Promise<ArchitectureProposal[]> {
    const systemPrompt =
      "You are an expert software architect analyzing an AI agent orchestration system called PEPAGI. " +
      "Based on the provided performance metrics, generate 3-5 specific, actionable improvement proposals. " +
      "Return ONLY a JSON array with this exact structure: " +
      "[{\"title\": \"...\", \"description\": \"...\", \"impact\": \"high|medium|low\", " +
      "\"effort\": \"high|medium|low\", \"category\": \"memory|routing|security|tools|meta\"}]. " +
      "Focus on the most impactful improvements given the metrics. Be concrete and specific.";

    const userPrompt =
      `PEPAGI System Metrics:\n` +
      `- Total tasks processed: ${metrics.totalTasks}\n` +
      `- Average task success rate: ${(metrics.avgTaskSuccess * 100).toFixed(1)}%\n` +
      `- Average confidence: ${(metrics.avgConfidence * 100).toFixed(1)}%\n` +
      `- Average cost per task: $${metrics.avgCostPerTask.toFixed(4)}\n` +
      `- Most used agents: ${metrics.mostUsedAgents.join(", ") || "none"}\n` +
      `- Top failure reasons: ${metrics.topFailureReasons.join("; ") || "none recorded"}\n\n` +
      "Generate 3-5 architecture improvement proposals based on these metrics.";

    let newProposals: ArchitectureProposal[] = [];

    try {
      const response = await this.llm.quickClaude(
        systemPrompt,
        userPrompt,
        CHEAP_CLAUDE_MODEL,
        true,
      );

      const parsed = parseLLMJson(response.content);
      if (!Array.isArray(parsed)) {
        logger.warn("ArchitectureProposer: LLM returned non-array response");
        return [];
      }

      await this.ensureLoaded();

      for (const item of parsed) {
        if (
          typeof item !== "object" ||
          item === null ||
          typeof (item as Record<string, unknown>).title !== "string" ||
          typeof (item as Record<string, unknown>).description !== "string"
        ) {
          continue;
        }

        const raw = item as Record<string, unknown>;
        const validImpact = ["high", "medium", "low"];
        const validEffort = ["high", "medium", "low"];
        const validCategory = ["memory", "routing", "security", "tools", "meta"];

        const proposal: ArchitectureProposal = {
          id: nanoid(10),
          title: String(raw.title).slice(0, 120),
          description: String(raw.description).slice(0, 800),
          impact: validImpact.includes(String(raw.impact)) ? String(raw.impact) as "high" | "medium" | "low" : "medium",
          effort: validEffort.includes(String(raw.effort)) ? String(raw.effort) as "high" | "medium" | "low" : "medium",
          category: validCategory.includes(String(raw.category)) ? String(raw.category) as ArchitectureProposal["category"] : "meta",
          proposedAt: new Date(),
          implemented: false,
        };

        // BUG-10: deduplicate by title to prevent identical proposals accumulating across analysis runs
        const isDuplicate = this.proposals.some(p => p.title === proposal.title);
        if (isDuplicate) continue;

        this.proposals.push(proposal);

        // BUG-10: cap proposals to prevent unbounded accumulation
        if (this.proposals.length >= 100) {
          this.proposals = this.proposals.slice(-100); // keep most recent 100
        }

        await this.appendProposal(proposal);
        newProposals.push(proposal);
      }

      logger.info(`ArchitectureProposer: generated ${newProposals.length} proposals`);
    } catch (err) {
      logger.warn("ArchitectureProposer: proposal generation failed", { error: String(err) });
    }

    return newProposals;
  }

  /**
   * Read all saved proposals from disk.
   * @returns All proposals sorted newest-first
   */
  async getProposals(): Promise<ArchitectureProposal[]> {
    await this.ensureLoaded();
    return [...this.proposals].sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime());
  }

  /**
   * Mark a proposal as implemented by ID.
   * @param id - Proposal ID to mark as implemented
   */
  async markImplemented(id: string): Promise<void> {
    await this.ensureLoaded();
    const proposal = this.proposals.find(p => p.id === id);
    if (!proposal) {
      logger.warn("ArchitectureProposer: proposal not found", { id });
      return;
    }
    proposal.implemented = true;
    await this.rewriteAll();
    logger.info("ArchitectureProposer: marked proposal as implemented", { id, title: proposal.title });
  }

  /**
   * Collect metrics from TaskStore and MemorySystem, then generate proposals.
   * @param taskStore - The task store to gather performance data from
   * @param memory - The memory system to gather memory stats from
   * @returns Newly generated proposals
   */
  async runAnalysis(taskStore: TaskStore, memory: MemorySystem): Promise<ArchitectureProposal[]> {
    try {
      const taskStats = taskStore.getStats();
      const allTasks = taskStore.getAll();

      // Compute average confidence from completed tasks
      const completedTasks = allTasks.filter(t => t.status === "completed");
      const avgConfidence = completedTasks.length > 0
        ? completedTasks.reduce((sum, t) => sum + t.confidence, 0) / completedTasks.length
        : 0;

      // Compute average task success rate
      const totalFinished = completedTasks.length + taskStats.failed;
      const avgTaskSuccess = totalFinished > 0 ? completedTasks.length / totalFinished : 0;

      // Compute average cost per task
      const avgCostPerTask = taskStats.total > 0 ? taskStats.totalCost / taskStats.total : 0;

      // Find most used agents
      const agentCounts = new Map<string, number>();
      for (const task of allTasks) {
        if (task.assignedTo) {
          agentCounts.set(task.assignedTo, (agentCounts.get(task.assignedTo) ?? 0) + 1);
        }
      }
      const mostUsedAgents = [...agentCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([agent]) => agent);

      // Collect top failure reasons from failed tasks
      const failedTasks = allTasks.filter(t => t.status === "failed" && t.lastError);
      const topFailureReasons = failedTasks
        .slice(-10)
        .map(t => t.lastError ?? "")
        .filter(Boolean)
        .slice(0, 5);

      // Get memory stats for context (best-effort)
      let memoryContext = "";
      try {
        const memStats = await memory.getStats();
        memoryContext = JSON.stringify(memStats);
      } catch {
        // Non-critical
      }

      const metrics: SystemMetrics = {
        avgTaskSuccess,
        avgConfidence,
        topFailureReasons: topFailureReasons.length > 0 ? topFailureReasons : [`Memory stats: ${memoryContext || "unavailable"}`],
        mostUsedAgents,
        avgCostPerTask,
        totalTasks: taskStats.total,
      };

      logger.debug("ArchitectureProposer: running analysis", {
        totalTasks: metrics.totalTasks,
        avgSuccess: metrics.avgTaskSuccess,
      });

      return await this.propose(metrics);
    } catch (err) {
      logger.warn("ArchitectureProposer.runAnalysis failed", { error: String(err) });
      return [];
    }
  }
}
