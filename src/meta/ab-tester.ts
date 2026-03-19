// ═══════════════════════════════════════════════════════════════
// PEPAGI — A/B Tester (Strategy Experimentation)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("ABTester");

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  controlStrategy: string;
  treatmentStrategy: string;
  controlResults: ExperimentResult[];
  treatmentResults: ExperimentResult[];
  winner: "control" | "treatment" | "inconclusive" | null;
  createdAt: string;
  concludedAt?: string;
}

export interface ExperimentResult {
  success: boolean;
  cost: number;
  latencyMs: number;
  confidence: number;
}

const EXPERIMENTS_PATH = join(PEPAGI_DATA_DIR, "memory", "experiments.jsonl");

export class ABTester {
  private experiments: Experiment[] = [];
  private taskCount = 0;
  private readonly experimentFrequency = 20; // run experiment every N tasks
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(EXPERIMENTS_PATH)) {
      const content = await readFile(EXPERIMENTS_PATH, "utf8");
      this.experiments = content.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Experiment);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = this.experiments.map(e => JSON.stringify(e)).join("\n") + "\n";
    const tmpPath = `${EXPERIMENTS_PATH}.tmp.${process.pid}`;
    await writeFile(tmpPath, lines, "utf8");
    await rename(tmpPath, EXPERIMENTS_PATH); // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
  }

  /** Increment task count — may trigger experiment */
  tick(): boolean {
    this.taskCount++;
    return this.taskCount % this.experimentFrequency === 0;
  }

  /** Create a new experiment */
  async createExperiment(params: {
    name: string;
    hypothesis: string;
    controlStrategy: string;
    treatmentStrategy: string;
  }): Promise<Experiment> {
    await this.ensureLoaded();

    const experiment: Experiment = {
      id: nanoid(8),
      name: params.name,
      hypothesis: params.hypothesis,
      controlStrategy: params.controlStrategy,
      treatmentStrategy: params.treatmentStrategy,
      controlResults: [],
      treatmentResults: [],
      winner: null,
      createdAt: new Date().toISOString(),
    };

    this.experiments.push(experiment);
    await this.save();
    logger.info("Experiment created", { id: experiment.id, name: experiment.name });
    return experiment;
  }

  /** Record a result for an experiment */
  async recordResult(
    experimentId: string,
    variant: "control" | "treatment",
    result: ExperimentResult,
  ): Promise<void> {
    await this.ensureLoaded();
    const exp = this.experiments.find(e => e.id === experimentId);
    if (!exp) return;

    if (variant === "control") exp.controlResults.push(result);
    else exp.treatmentResults.push(result);

    // Conclude when we have enough results (5 per variant)
    if (exp.controlResults.length >= 5 && exp.treatmentResults.length >= 5 && !exp.winner) {
      await this.conclude(exp);
    }

    await this.save();
  }

  /** Conclude an experiment and determine winner */
  private async conclude(exp: Experiment): Promise<void> {
    const controlScore = this.score(exp.controlResults);
    const treatmentScore = this.score(exp.treatmentResults);
    const diff = Math.abs(controlScore - treatmentScore);

    if (diff < 0.05) {
      exp.winner = "inconclusive";
    } else {
      exp.winner = treatmentScore > controlScore ? "treatment" : "control";
    }

    exp.concludedAt = new Date().toISOString();
    logger.info("Experiment concluded", { id: exp.id, winner: exp.winner, controlScore: controlScore.toFixed(3), treatmentScore: treatmentScore.toFixed(3) });
  }

  /** Calculate composite score for a set of results */
  private score(results: ExperimentResult[]): number {
    if (results.length === 0) return 0;
    const successRate = results.filter(r => r.success).length / results.length;
    const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / results.length;
    const avgCost = results.reduce((s, r) => s + r.cost, 0) / results.length;
    return (successRate * 0.4 + avgConfidence * 0.4) / (1 + avgCost * 10 * 0.2);
  }

  /** Get active experiments */
  async getActive(): Promise<Experiment[]> {
    await this.ensureLoaded();
    return this.experiments.filter(e => !e.winner);
  }

  /** Get winning strategies */
  async getWinners(): Promise<Array<{ name: string; winner: string; strategy: string }>> {
    await this.ensureLoaded();
    return this.experiments
      .filter(e => e.winner && e.winner !== "inconclusive")
      .map(e => ({
        name: e.name,
        winner: e.winner!,
        strategy: e.winner === "treatment" ? e.treatmentStrategy : e.controlStrategy,
      }));
  }
}
