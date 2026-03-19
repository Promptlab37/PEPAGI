// ═══════════════════════════════════════════════════════════════
// PEPAGI — Level 5: Meta-Memory (Knowledge About Knowledge)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

export interface MetaRecord {
  id: string;
  memoryId: string;
  type: "episode" | "fact" | "procedure" | "skill";
  reliability: number;   // 0-1
  lastSuccess: string | null;
  lastFailure: string | null;
  notes: string;
  flaggedForVerification: boolean;
}

const META_PATH = join(PEPAGI_DATA_DIR, "memory", "meta.jsonl");
const UNRELIABLE_THRESHOLD = 0.3;

export class MetaMemory {
  private records: Map<string, MetaRecord> = new Map();
  private loaded = false;
  // FIX: cap records to prevent unbounded growth
  private static readonly MAX_RECORDS = 5000;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(META_PATH)) {
      const content = await readFile(META_PATH, "utf8");
      content.trim().split("\n").filter(Boolean).forEach(l => {
        const r = JSON.parse(l) as MetaRecord;
        this.records.set(r.memoryId, r);
      });
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = [...this.records.values()].map(r => JSON.stringify(r)).join("\n") + "\n";
    const tmpPath = `${META_PATH}.tmp.${process.pid}`;
    await writeFile(tmpPath, lines, "utf8");
    await rename(tmpPath, META_PATH); // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
  }

  /** Get or create a meta-record for a memory */
  async getOrCreate(memoryId: string, type: MetaRecord["type"]): Promise<MetaRecord> {
    await this.ensureLoaded();

    if (this.records.has(memoryId)) {
      return this.records.get(memoryId)!;
    }

    const record: MetaRecord = {
      id: nanoid(8),
      memoryId,
      type,
      reliability: 0.7,
      lastSuccess: null,
      lastFailure: null,
      notes: "",
      flaggedForVerification: false,
    };

    // FIX: evict oldest records if map exceeds cap
    if (this.records.size >= MetaMemory.MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    this.records.set(memoryId, record);
    await this.save();
    return record;
  }

  /** Record a successful use of a memory */
  async recordSuccess(memoryId: string, type: MetaRecord["type"]): Promise<void> {
    const record = await this.getOrCreate(memoryId, type);
    record.reliability = Math.min(1, record.reliability + 0.1);
    record.lastSuccess = new Date().toISOString();
    record.flaggedForVerification = false;
    await this.save();
  }

  /** Record a failed use of a memory */
  async recordFailure(memoryId: string, type: MetaRecord["type"], note?: string): Promise<void> {
    const record = await this.getOrCreate(memoryId, type);
    record.reliability = Math.max(0, record.reliability - 0.2);
    record.lastFailure = new Date().toISOString();
    if (note) record.notes = note;
    if (record.reliability < UNRELIABLE_THRESHOLD) {
      record.flaggedForVerification = true;
    }
    await this.save();
  }

  /** Get reliability score for a memory (0-1) */
  async getReliability(memoryId: string): Promise<number> {
    await this.ensureLoaded();
    return this.records.get(memoryId)?.reliability ?? 0.7;
  }

  /** Get all memories flagged for verification */
  async getFlagged(): Promise<MetaRecord[]> {
    await this.ensureLoaded();
    return [...this.records.values()].filter(r => r.flaggedForVerification);
  }

  /** Annotate reliability info onto context string */
  async annotateContext(memoryId: string, context: string): Promise<string> {
    const reliability = await this.getReliability(memoryId);
    const record = this.records.get(memoryId);

    if (record?.flaggedForVerification) {
      return `[⚠️ VERIFY: reliability=${reliability.toFixed(2)}] ${context}`;
    }
    if (reliability < 0.5) {
      return `[reliability=${reliability.toFixed(2)}] ${context}`;
    }
    return context;
  }
}
