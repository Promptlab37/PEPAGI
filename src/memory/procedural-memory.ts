// ═══════════════════════════════════════════════════════════════
// PEPAGI — Level 4: Procedural Memory (How To Do It)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

export interface Procedure {
  id: string;
  name: string;
  description: string;
  triggerPattern: string;   // regex or keywords
  steps: string[];
  successRate: number;
  timesUsed: number;
  averageCost: number;
  createdAt: string;
  lastUsed: string;
  reliable: boolean;        // false if successRate < 0.3
}

const PROCEDURES_PATH = join(PEPAGI_DATA_DIR, "memory", "procedures.jsonl");
const MIN_SUCCESS_COUNT = 3;
const UNRELIABLE_THRESHOLD = 0.3;

export class ProceduralMemory {
  private procedures: Procedure[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(PROCEDURES_PATH)) {
      const content = await readFile(PROCEDURES_PATH, "utf8");
      this.procedures = content.trim().split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l) as Procedure);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = this.procedures.map(p => JSON.stringify(p)).join("\n") + "\n";
    const tmpPath = `${PROCEDURES_PATH}.tmp.${process.pid}`;
    await writeFile(tmpPath, lines, "utf8");
    await rename(tmpPath, PROCEDURES_PATH); // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
  }

  /** Find a matching procedure for a task */
  async findMatch(taskDescription: string): Promise<Procedure | null> {
    await this.ensureLoaded();

    const desc = taskDescription.toLowerCase();

    for (const proc of this.procedures) {
      if (!proc.reliable) continue;
      if (proc.timesUsed < MIN_SUCCESS_COUNT) continue;

      // Match by keywords or pattern
      const keywords = proc.triggerPattern.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const matches = keywords.filter(kw => desc.includes(kw));
      // Math.round: 1kw→1, 2kw→1, 3kw→2, 4kw→2, 5kw→3 (avoids 2-keyword 100% bug with Math.ceil)
      const threshold = Math.max(1, Math.round(keywords.length * 0.6));
      if (matches.length >= threshold) {
        proc.timesUsed++;
        proc.lastUsed = new Date().toISOString();
        await this.save();
        return proc;
      }
    }

    return null;
  }

  /** Store a new procedure */
  async store(params: {
    name: string;
    description: string;
    triggerPattern: string;
    steps: string[];
    cost: number;
  }): Promise<Procedure> {
    await this.ensureLoaded();

    const existing = this.procedures.find(p => p.triggerPattern === params.triggerPattern);
    if (existing) {
      existing.steps = params.steps;
      existing.timesUsed++;
      existing.lastUsed = new Date().toISOString();
      await this.save();
      return existing;
    }

    const proc: Procedure = {
      id: nanoid(8),
      name: params.name,
      description: params.description,
      triggerPattern: params.triggerPattern,
      steps: params.steps,
      successRate: 1.0,
      timesUsed: 1,
      averageCost: params.cost,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      reliable: true,
    };

    this.procedures.push(proc);
    await this.save();
    return proc;
  }

  /** Record outcome of using a procedure */
  async recordOutcome(procedureId: string, success: boolean, cost: number): Promise<void> {
    await this.ensureLoaded();
    const proc = this.procedures.find(p => p.id === procedureId);
    if (!proc) return;

    // Update rolling success rate
    proc.successRate = proc.successRate * 0.8 + (success ? 0.2 : 0);
    proc.averageCost = proc.averageCost * 0.8 + cost * 0.2;
    proc.reliable = proc.successRate >= UNRELIABLE_THRESHOLD;

    await this.save();
  }

  /** Get all reliable procedures */
  async getReliable(): Promise<Procedure[]> {
    await this.ensureLoaded();
    return this.procedures.filter(p => p.reliable && p.timesUsed >= MIN_SUCCESS_COUNT);
  }

  async getStats(): Promise<{ total: number; reliable: number; avgSuccessRate: number }> {
    await this.ensureLoaded();
    const reliable = this.procedures.filter(p => p.reliable).length;
    const avgSuccessRate = this.procedures.length > 0
      ? this.procedures.reduce((s, p) => s + p.successRate, 0) / this.procedures.length
      : 0;
    return { total: this.procedures.length, reliable, avgSuccessRate };
  }
}
