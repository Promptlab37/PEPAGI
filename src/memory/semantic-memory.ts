// ═══════════════════════════════════════════════════════════════
// PEPAGI — Level 3: Semantic Memory (What I Know)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { vectorStore } from "./vector-store.js";
import { temporalDecay } from "../meta/temporal-decay.js";
// SECURITY: SEC-17 — MemoryGuard for write validation and provenance
import { memoryGuard } from "../security/memory-guard.js";

export interface KnowledgeFact {
  id: string;
  fact: string;
  source: string;       // taskId
  confidence: number;   // 0-1
  createdAt: string;
  lastVerified: string;
  tags: string[];
  useCount: number;
}

const KNOWLEDGE_PATH = join(PEPAGI_DATA_DIR, "memory", "knowledge.jsonl");

export class SemanticMemory {
  private facts: KnowledgeFact[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(KNOWLEDGE_PATH)) {
      const content = await readFile(KNOWLEDGE_PATH, "utf8");
      const raw = content.trim().split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l) as KnowledgeFact);

      // Apply temporal decay to confidence values on load
      this.facts = raw.map(fact => {
        const lastVerifiedDate = new Date(fact.lastVerified);
        const decayedConfidence = temporalDecay.decay(
          fact.confidence,
          lastVerifiedDate,
          temporalDecay.factHalfLife,
        );
        return { ...fact, confidence: decayedConfidence };
      }).filter(fact => fact.confidence >= 0.05); // remove fully expired facts
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = this.facts.map(f => JSON.stringify(f)).join("\n") + "\n";
    // AUD-03: atomic write
    const tmp = `${KNOWLEDGE_PATH}.tmp.${process.pid}`;
    await writeFile(tmp, lines, "utf8");
    await rename(tmp, KNOWLEDGE_PATH);
  }

  /** Add a new fact */
  async addFact(params: { fact: string; source: string; confidence?: number; tags?: string[] }): Promise<KnowledgeFact> {
    await this.ensureLoaded();

    // SECURITY: SEC-17 — Validate write through MemoryGuard
    const provenance = memoryGuard.createProvenance(params.source, "mediator", "AGENT_GENERATED");
    const existingTexts = this.facts.map(f => f.fact);
    const validation = await memoryGuard.validateWrite(params.fact, provenance, existingTexts);

    if (!validation.allowed) {
      // Return a dummy fact with 0 confidence to signal rejection without breaking callers
      return {
        id: "rejected",
        fact: `[Rejected: ${validation.reason}]`,
        source: params.source,
        confidence: 0,
        createdAt: new Date().toISOString(),
        lastVerified: new Date().toISOString(),
        tags: [],
        useCount: 0,
      };
    }

    // Check for near-duplicate (MemoryGuard also checks, but we handle the merge logic here)
    const existing = this.facts.find(f => f.fact.toLowerCase() === validation.sanitizedContent.toLowerCase());
    if (existing) {
      existing.lastVerified = new Date().toISOString();
      existing.confidence = Math.min(1, existing.confidence + 0.1); // increase confidence on re-encounter
      await this.save();
      return existing;
    }

    // Skip near-duplicates detected by MemoryGuard
    if (validation.isDuplicate) {
      const nearDup = this.facts.find(f => f.fact.toLowerCase().includes(validation.sanitizedContent.toLowerCase().slice(0, 50)));
      if (nearDup) {
        nearDup.lastVerified = new Date().toISOString();
        nearDup.confidence = Math.min(1, nearDup.confidence + 0.05);
        await this.save();
        return nearDup;
      }
    }

    // SECURITY: SEC-16 — Check for contradictions with existing high-confidence facts
    const highConfFacts = this.facts
      .filter(f => f.confidence >= 0.6)
      .map(f => ({ fact: f.fact, confidence: f.confidence, id: f.id }));
    const contradictions = memoryGuard.detectContradictions(validation.sanitizedContent, highConfFacts);
    if (contradictions.length > 0) {
      // Flag but allow — lower confidence on contradicted entry
      const loweredConf = Math.max(0.3, (params.confidence ?? 0.7) - 0.2);
      params.confidence = loweredConf;
    }

    const fact: KnowledgeFact = {
      id: nanoid(8),
      fact: validation.sanitizedContent,
      source: params.source,
      confidence: params.confidence ?? 0.7,
      createdAt: new Date().toISOString(),
      lastVerified: new Date().toISOString(),
      tags: params.tags ?? [],
      useCount: 0,
    };

    this.facts.push(fact);
    // BUG-06: was rewriting entire JSONL file on every addFact(); now append-only for new facts
    await appendFile(KNOWLEDGE_PATH, JSON.stringify(fact) + "\n", "utf8");
    return fact;
  }

  /** Search facts relevant to a query using VectorStore (hybrid TF-IDF + optional Ollama) */
  async search(query: string, limit = 10): Promise<KnowledgeFact[]> {
    await this.ensureLoaded();

    const eligible = this.facts.filter(f => f.confidence >= 0.3);
    if (eligible.length === 0) return [];

    const items = eligible.map(fact => ({
      id: fact.id,
      text: `${fact.fact} ${fact.tags.join(" ")}`,
      data: fact,
    }));

    const results = await vectorStore.hybridSearch(query, items, limit);
    const matched = results.map(r => {
      r.data.useCount++;
      // SECURITY: SEC-16 — Track retrieval frequency for anomaly detection
      memoryGuard.trackRetrieval(r.data.id);
      return r.data;
    });
    // ERR-03: useCount was incremented in memory but never persisted; call save() to persist it
    await this.save();
    return matched;
  }

  /** Get all facts */
  async getAll(): Promise<KnowledgeFact[]> {
    await this.ensureLoaded();
    return this.facts;
  }

  /** Update confidence of a fact */
  async updateConfidence(factId: string, delta: number): Promise<void> {
    await this.ensureLoaded();
    const fact = this.facts.find(f => f.id === factId);
    if (!fact) return;
    fact.confidence = Math.min(1, Math.max(0, fact.confidence + delta));
    await this.save();
  }

  async getStats(): Promise<{ total: number; avgConfidence: number }> {
    await this.ensureLoaded();
    if (this.facts.length === 0) return { total: 0, avgConfidence: 0 };
    return {
      total: this.facts.length,
      avgConfidence: this.facts.reduce((s, f) => s + f.confidence, 0) / this.facts.length,
    };
  }
}
