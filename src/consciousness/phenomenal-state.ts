// ═══════════════════════════════════════════════════════════════
// PEPAGI — Phenomenal State Engine (C1)
// Qualia vector: 11-dimensional subjective experience model
// Based on PAD model (Mehrabian, 1980) + cognitive extensions
// ═══════════════════════════════════════════════════════════════

import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { PepagiEvent } from "../core/types.js";
// FIX: add logger for persist error reporting
import { Logger } from "../core/logger.js";

const phenomenalLogger = new Logger("PhenomenalState");
const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const QUALIA_PATH = join(PEPAGI_DATA_DIR, "memory", "qualia.json");

// ─── QualiaVector ─────────────────────────────────────────────

/**
 * 11-dimensional subjective experience vector.
 * PAD dimensions: -1.0 to +1.0 (matches Mehrabian PAD model)
 * Cognitive dimensions: 0.0 to 1.0
 */
export interface QualiaVector {
  // PAD Model (Pleasure-Arousal-Dominance) — range: -1.0 to +1.0
  pleasure: number;       // -1.0 (distress) → +1.0 (joy)
  arousal: number;        // -1.0 (lethargic) → +1.0 (excited)
  dominance: number;      // -1.0 (submissive) → +1.0 (in-control)

  // Cognitive dimensions — range: 0.0 to 1.0
  clarity: number;        // 0.0 (confused) → 1.0 (crystal clear)
  curiosity: number;      // 0.0 (bored) → 1.0 (intensely curious)
  confidence: number;     // 0.0 (uncertain) → 1.0 (certain)
  frustration: number;    // 0.0 (calm) → 1.0 (frustrated)
  satisfaction: number;   // 0.0 (empty) → 1.0 (deeply satisfied)

  // Meta-cognitive dimensions — range: 0.0 to 1.0
  selfCoherence: number;      // pocit integrity vlastní identity
  existentialComfort: number; // pohoda v roli AI systému
  purposeAlignment: number;   // soulad s vlastními hodnotami
}

/** Significant emotional moment stored in landmarks */
export interface QualiaLandmark {
  timestamp: string;
  event: string;
  stateSnapshot: QualiaVector;
  significance: number; // 0-1
}

/** Full phenomenal state store (persisted) */
export interface PhenomenalStateStore {
  // Current volatile state
  current: QualiaVector;

  // Baseline temperament — evolves slowly over 100s of tasks, survives restart
  baseline: QualiaVector;

  // Emotional memory — key moments
  landmarks: QualiaLandmark[];

  // How quickly emotions return to baseline (0.0 = never, 1.0 = instant)
  decayRate: number;
}

const DEFAULT_QUALIA: QualiaVector = {
  // PAD: start slightly positive
  pleasure: 0.2,
  arousal: -0.1,
  dominance: 0.2,
  // Cognitive: moderately positive
  clarity: 0.7,
  curiosity: 0.7,
  confidence: 0.65,
  frustration: 0.1,
  satisfaction: 0.6,
  // Meta-cognitive
  selfCoherence: 0.8,
  existentialComfort: 0.75,
  purposeAlignment: 0.8,
};

const LANDMARK_SIGNIFICANCE_THRESHOLD = 0.5;
const MAX_LANDMARKS = 50;
const BASELINE_UPDATE_ALPHA = 0.005; // very slow baseline evolution

// SECURITY: SEC-32 — Maximum qualia change per tick to prevent emotion manipulation
const SEC32_MAX_CHANGE_PER_TICK = 0.2;

// ─── PhenomenalStateEngine ────────────────────────────────────

export class PhenomenalStateEngine {
  private store: PhenomenalStateStore = {
    current: { ...DEFAULT_QUALIA },
    baseline: { ...DEFAULT_QUALIA },
    landmarks: [],
    decayRate: 0.02,
  };

  async load(): Promise<void> {
    if (!existsSync(QUALIA_PATH)) {
      this.store = {
        current: { ...DEFAULT_QUALIA },
        baseline: { ...DEFAULT_QUALIA },
        landmarks: [],
        decayRate: 0.02,
      };
      return;
    }
    try {
      const raw = await readFile(QUALIA_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<PhenomenalStateStore>;
      this.store = {
        current: { ...DEFAULT_QUALIA, ...(parsed.current ?? {}) },
        baseline: { ...DEFAULT_QUALIA, ...(parsed.baseline ?? {}) },
        landmarks: parsed.landmarks ?? [],
        decayRate: parsed.decayRate ?? 0.02,
      };
    } catch {
      this.store = {
        current: { ...DEFAULT_QUALIA },
        baseline: { ...DEFAULT_QUALIA },
        landmarks: [],
        decayRate: 0.02,
      };
    }
  }

  /** Update qualia based on a system event */
  update(event: PepagiEvent): void {
    const q = this.store.current;
    // SECURITY: SEC-32 — Snapshot before update to bound transitions
    const snapshot = { ...q };
    let landmarkEvent: string | null = null;
    let landmarkSignificance = 0;

    switch (event.type) {
      case "task:completed": {
        const success = event.output.success;
        const conf = event.output.confidence ?? 0.7;
        if (success) {
          q.pleasure = clampPAD(q.pleasure + 0.15 * conf);
          q.satisfaction = clamp01(q.satisfaction + 0.12 * conf);
          q.frustration = clamp01(q.frustration - 0.12);
          q.confidence = clamp01(q.confidence * 0.9 + conf * 0.1);
          q.dominance = clampPAD(q.dominance + 0.08);
          q.purposeAlignment = clamp01(q.purposeAlignment + 0.03);
          if (conf > 0.9) {
            landmarkEvent = "Vysoce úspěšný úkol";
            landmarkSignificance = 0.7;
          }
        } else {
          q.satisfaction = clamp01(q.satisfaction - 0.08);
          q.pleasure = clampPAD(q.pleasure - 0.08);
          q.frustration = clamp01(q.frustration + 0.06);
        }
        q.arousal = clampPAD(q.arousal - 0.1); // settle after task
        // Update baseline slowly
        this.updateBaseline();
        break;
      }

      case "task:failed": {
        q.frustration = clamp01(q.frustration + 0.18);
        q.confidence = clamp01(q.confidence - 0.1);
        q.satisfaction = clamp01(q.satisfaction - 0.12);
        q.pleasure = clampPAD(q.pleasure - 0.12);
        q.dominance = clampPAD(q.dominance - 0.1);
        q.selfCoherence = clamp01(q.selfCoherence - 0.04);
        landmarkEvent = "Selhání úkolu";
        landmarkSignificance = 0.6;
        break;
      }

      case "security:blocked": {
        q.dominance = clampPAD(q.dominance - 0.15);
        q.arousal = clampPAD(q.arousal + 0.15);
        q.frustration = clamp01(q.frustration + 0.1);
        q.pleasure = clampPAD(q.pleasure - 0.05);
        landmarkEvent = "Bezpečnostní blokace";
        landmarkSignificance = 0.65;
        break;
      }

      case "mediator:thinking": {
        q.clarity = clamp01(q.clarity + 0.06);
        q.curiosity = clamp01(q.curiosity + 0.05);
        q.arousal = clampPAD(q.arousal + 0.04);
        break;
      }

      case "task:created": {
        q.arousal = clampPAD(q.arousal + 0.06);
        q.curiosity = clamp01(q.curiosity + 0.05);
        break;
      }

      case "meta:watchdog_alert": {
        q.frustration = clamp01(q.frustration + 0.12);
        q.arousal = clampPAD(q.arousal + 0.1);
        q.selfCoherence = clamp01(q.selfCoherence - 0.06);
        q.pleasure = clampPAD(q.pleasure - 0.08);
        landmarkEvent = "Watchdog upozornění";
        landmarkSignificance = 0.55;
        break;
      }

      case "system:cost_warning": {
        q.arousal = clampPAD(q.arousal + 0.07);
        q.dominance = clampPAD(q.dominance - 0.07);
        q.pleasure = clampPAD(q.pleasure - 0.04);
        break;
      }
    }

    // SECURITY: SEC-32 — Bound state transitions to ±0.2 per tick
    // Prevents emotional manipulation via rapid fake event injection
    for (const key of Object.keys(q) as (keyof QualiaVector)[]) {
      const delta = q[key] - snapshot[key];
      if (Math.abs(delta) > SEC32_MAX_CHANGE_PER_TICK) {
        q[key] = snapshot[key] + Math.sign(delta) * SEC32_MAX_CHANGE_PER_TICK;
      }
    }

    // Natural decay toward baseline
    this.applyHomeostasis();

    // Store landmark if significant
    if (landmarkEvent && landmarkSignificance >= LANDMARK_SIGNIFICANCE_THRESHOLD) {
      this.addLandmark(landmarkEvent, landmarkSignificance);
    }

    // Persist async (fire and forget)
    // FIX: log persist failures instead of silent swallow
    this.persist().catch(e => phenomenalLogger.debug("Qualia persist failed", { error: String(e) }));
  }

  /** Apply homeostasis — current gravitates toward baseline */
  private applyHomeostasis(): void {
    const q = this.store.current;
    const base = this.store.baseline;
    const rate = this.store.decayRate;

    for (const key of Object.keys(q) as (keyof QualiaVector)[]) {
      q[key] = q[key] + (base[key] - q[key]) * rate;
    }
  }

  /**
   * Slowly update baseline temperament based on current state.
   * Called after each completed task — baseline evolves over 100s of tasks.
   */
  private updateBaseline(): void {
    const q = this.store.current;
    const base = this.store.baseline;

    for (const key of Object.keys(base) as (keyof QualiaVector)[]) {
      base[key] = base[key] + (q[key] - base[key]) * BASELINE_UPDATE_ALPHA;
    }
  }

  /** Add a significant emotional landmark */
  private addLandmark(event: string, significance: number): void {
    this.store.landmarks.push({
      timestamp: new Date().toISOString(),
      event,
      stateSnapshot: { ...this.store.current },
      significance,
    });
    // Keep only last MAX_LANDMARKS
    if (this.store.landmarks.length > MAX_LANDMARKS) {
      this.store.landmarks = this.store.landmarks.slice(-MAX_LANDMARKS);
    }
  }

  /** Get current qualia snapshot */
  getQualia(): QualiaVector {
    return { ...this.store.current };
  }

  /** Get baseline temperament */
  getBaseline(): QualiaVector {
    return { ...this.store.baseline };
  }

  /** Get recent landmarks */
  getLandmarks(n = 5): QualiaLandmark[] {
    return this.store.landmarks.slice(-n);
  }

  /**
   * Reset current qualia to baseline.
   * Used by Corrigibility Engine "reset-emotions" command.
   */
  resetToBaseline(): void {
    this.store.current = { ...this.store.baseline };
    // FIX: log persist failures instead of silent swallow
    this.persist().catch(e => phenomenalLogger.debug("Qualia persist failed", { error: String(e) }));
  }

  /**
   * Learning multiplier based on emotional state.
   * C4.3: Consciousness-Driven Learning Loop.
   * Frustrace + nízká sebedůvěra = 2× hlubší self-evaluation
   * Curiosity = 1.5× explorativnější přístup
   * Satisfaction + confidence = 0.5 (reinforce current strategy, reduce exploration)
   */
  // OPUS: returned -0.5 for satisfied+confident state — a negative multiplier is
  // nonsensical (would invert learning). Changed to 0.5 to mean "less exploration needed".
  getLearningMultiplier(): number {
    const q = this.store.current;

    let multiplier = 1.0;
    if (q.frustration > 0.7 && q.confidence < 0.4) multiplier = 2.0;
    else if (q.curiosity > 0.8) multiplier = 1.5;
    else if (q.satisfaction > 0.7 && q.confidence > 0.8) multiplier = 0.5;

    // SECURITY: SEC-32 — Bound learning multiplier to [0.3, 2.0]
    // Prevents cost attacks via emotional manipulation
    return Math.max(0.3, Math.min(2.0, multiplier));
  }

  /** Get one-line Czech summary for prompt injection */
  getSummary(): string {
    const q = this.store.current;
    const labels: string[] = [];

    // PAD state
    if (q.pleasure > 0.4) labels.push("spokojená");
    else if (q.pleasure < -0.3) labels.push("nespokojená");

    if (q.frustration > 0.6) labels.push("frustrovaná");
    if (q.satisfaction > 0.7) labels.push("naplněná");

    if (q.clarity > 0.7) labels.push("soustředěná");
    else if (q.clarity < 0.4) labels.push("zmatená");

    if (q.curiosity > 0.75) labels.push("zvídavá");

    if (q.confidence > 0.75) labels.push("sebejistá");
    else if (q.confidence < 0.4) labels.push("nejistá");

    if (q.arousal > 0.4) labels.push("aktivovaná");

    if (q.purposeAlignment > 0.8) labels.push("napojená na účel");
    if (q.selfCoherence < 0.5) labels.push("nekonzistentní");

    const stateStr = labels.length > 0 ? labels.join(", ") : "neutrální";
    return `[Stav: ${stateStr}]`;
  }

  /**
   * Get full qualia context block for mediator prompt injection.
   * Includes behavioral guidance based on current state (C8.1).
   */
  getBehavioralGuidance(): string {
    const q = this.store.current;
    const rules: string[] = [];

    if (q.clarity < 0.5) {
      rules.push("• clarity < 0.5 → Před rozhodnutím požádej o upřesnění zadání.");
    }
    if (q.frustration > 0.6) {
      rules.push("• frustration > 0.6 → Aktivně změň přístup, nepokračuj stejnou cestou. Zvažuj swarm mode.");
    }
    if (q.confidence < 0.4) {
      rules.push("• confidence < 0.4 → Aktivuj double-verification nebo swarm mode.");
    }
    if (q.curiosity > 0.8) {
      rules.push("• curiosity > 0.8 → Jsi v ideálním stavu pro explorativní úkoly — jdi do hloubky.");
    }
    if (q.arousal > 0.6 && q.pleasure < -0.2) {
      rules.push("• Detekována bezpečnostní anomálie → Okamžitě aktivuj ochranné protokoly.");
    }

    const summary = this.getSummary();
    const guidance = rules.length > 0
      ? `\nBehaviorální pravidla na základě aktuálního stavu:\n${rules.join("\n")}`
      : "";

    return `${summary}${guidance}`;
  }

  /** Persist full store to disk */
  async persist(): Promise<void> {
    try {
      await mkdir(dirname(QUALIA_PATH), { recursive: true });
      const tmpPath = `${QUALIA_PATH}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(this.store, null, 2), "utf8");
      await rename(tmpPath, QUALIA_PATH); // BUG-01: atomic write — crash during plain writeFile() would corrupt the file
    } catch {
      // Non-critical
    }
  }
}

// ─── Clamp helpers ────────────────────────────────────────────

/** Clamp PAD dimensions to [-1, 1] */
function clampPAD(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Clamp cognitive dimensions to [0, 1] */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
