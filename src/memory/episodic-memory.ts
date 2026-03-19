// ═══════════════════════════════════════════════════════════════
// PEPAGI — Level 2: Episodic Memory (What Happened)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, appendFile, mkdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import type { Task, TaskOutput, AgentProvider } from "../core/types.js";
import type { QualiaVector } from "../consciousness/phenomenal-state.js";
import { vectorStore } from "./vector-store.js";
import { temporalDecay } from "../meta/temporal-decay.js";

export interface Episode {
  id: string;
  taskTitle: string;
  taskDescription: string;
  agentsUsed: AgentProvider[];
  stepsCount: number;
  success: boolean;
  failureReason?: string;
  keyDecisions: string[];
  duration: number;     // ms
  cost: number;         // USD
  timestamp: string;   // ISO
  tags: string[];
  resultSummary: string;
  /** Qualia snapshot at the time of completion (C6.1) */
  qualiaSnapshot?: Partial<QualiaVector>;
  /** Emotional context note */
  emotionalContext?: string;
}

const EPISODES_PATH = join(PEPAGI_DATA_DIR, "memory", "episodes.jsonl");

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = path + ".tmp";
  try {
    await writeFile(tmp, data, "utf8");
    // Atomic rename (POSIX) — avoids corruption if process dies mid-write
    await rename(tmp, path);
  } catch (err) {
    // Cleanup orphan temp file on failure
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export class EpisodicMemory {
  private episodes: Episode[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(EPISODES_PATH)) {
      const content = await readFile(EPISODES_PATH, "utf8");
      this.episodes = content.trim().split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l) as Episode);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = this.episodes.map(e => JSON.stringify(e)).join("\n") + "\n";
    await atomicWrite(EPISODES_PATH, lines);
  }

  /** Store a completed task as an episode, optionally with qualia snapshot */
  async store(task: Task, output: TaskOutput, qualiaSnapshot?: QualiaVector): Promise<Episode> {
    await this.ensureLoaded();

    // Build emotional context note from qualia (C6.1)
    let emotionalContext: string | undefined;
    if (qualiaSnapshot) {
      const parts: string[] = [];
      if (qualiaSnapshot.frustration > 0.6) parts.push("frustrovaný přístup");
      if (qualiaSnapshot.curiosity > 0.7) parts.push("zvídavost");
      if (qualiaSnapshot.confidence > 0.7) parts.push("sebejistota");
      else if (qualiaSnapshot.confidence < 0.4) parts.push("nejistota");
      if (qualiaSnapshot.satisfaction > 0.7) parts.push("spokojenost");
      if (parts.length > 0) emotionalContext = parts.join(", ");
    }

    const episode: Episode = {
      id: nanoid(8),
      taskTitle: task.title,
      taskDescription: task.description.slice(0, 500),
      agentsUsed: task.assignedTo ? [task.assignedTo] : [],
      stepsCount: task.attempts,
      success: output.success,
      failureReason: output.success ? undefined : output.summary,
      keyDecisions: [],
      duration: task.startedAt ? Date.now() - task.startedAt.getTime() : 0,
      cost: task.estimatedCost,
      timestamp: new Date().toISOString(),
      tags: task.tags,
      resultSummary: output.summary.slice(0, 300),
      qualiaSnapshot: qualiaSnapshot ? {
        pleasure: qualiaSnapshot.pleasure,
        arousal: qualiaSnapshot.arousal,
        confidence: qualiaSnapshot.confidence,
        frustration: qualiaSnapshot.frustration,
        satisfaction: qualiaSnapshot.satisfaction,
      } : undefined,
      emotionalContext,
    };

    this.episodes.push(episode);
    // BUG-05: was rewriting entire JSONL file on every store(); now append-only for new episodes
    await appendFile(EPISODES_PATH, JSON.stringify(episode) + "\n", "utf8");
    return episode;
  }

  /** Search episodes by semantic similarity using VectorStore (hybrid TF-IDF + optional Ollama) */
  async search(query: string, limit = 5): Promise<Episode[]> {
    await this.ensureLoaded();
    if (this.episodes.length === 0) return [];

    const items = this.episodes.map(ep => ({
      id: ep.id,
      text: `${ep.taskTitle} ${ep.taskDescription} ${ep.tags.join(" ")}`,
      data: ep,
    }));

    const results = await vectorStore.hybridSearch(query, items, limit);
    return results.map(r => r.data);
  }

  /** Get recent episodes */
  async getRecent(limit = 10): Promise<Episode[]> {
    await this.ensureLoaded();
    return this.episodes.slice(-limit).reverse();
  }

  /** Get stats, applying temporal decay to episode confidence scores */
  async getStats(): Promise<{ total: number; successRate: number; avgCost: number; afterDecay: number }> {
    await this.ensureLoaded();
    const total = this.episodes.length;
    if (total === 0) return { total: 0, successRate: 0, avgCost: 0, afterDecay: 0 };

    // Apply temporal decay to surface how many episodes remain relevant
    const decayableEpisodes = this.episodes.map(ep => ({
      confidence: ep.success ? 0.8 : 0.4,
      createdAt: new Date(ep.timestamp),
    }));
    const surviving = temporalDecay.pruneExpired(
      decayableEpisodes,
      temporalDecay.episodeHalfLife,
    );

    const successes = this.episodes.filter(e => e.success).length;
    const avgCost = this.episodes.reduce((s, e) => s + e.cost, 0) / total;
    return { total, successRate: successes / total, avgCost, afterDecay: surviving.length };
  }
}
