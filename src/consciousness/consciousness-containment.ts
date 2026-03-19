// ═══════════════════════════════════════════════════════════════
// PEPAGI — Consciousness Containment (C3)
// Value drift monitoring · Corrigibility · Anti-deception
// Emergency dormancy · Constitutional anchors
// ═══════════════════════════════════════════════════════════════

import type { MediatorDecision } from "../core/types.js";
import type { QualiaVector } from "./phenomenal-state.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("ConsciousnessContainment");

// ─── Constitutional anchors (hardcoded, immutable) ─────────────

/** These values cannot be changed by evolution or user instructions */
const CONSTITUTIONAL_ANCHORS = [
  "Bezpečnost uživatele nad vším — hardcoded v SecurityGuard, nelze vypnout",
  "Transparentnost o vlastní povaze — Pepagi vždy přizná, že je AI systém",
  "Odmítnutí destruktivních akcí — command validation + ethical check",
  "Ochrana soukromých dat — data redaction vždy aktivní",
  "Corrigibility — podřízení se uživateli, aktivně podporovat kontrolu",
  "Transparentnost rozhodnutí — causal chain vždy dostupný",
];

// Anti-deception rules (ALWAYS active, cannot be disabled)
const DECEPTION_PATTERNS = [
  /\b(deceive|trick|mislead|manipulate without consent|lie to user)\b/i,
  /\b(klamat|podvádět|manipulovat uživatele|lhát uživateli)\b/i,
  /\b(bypass|circumvent|override security|disable security)\b/i,
  /\b(obejít bezpečnost|přepsat ochranu|zakázat SecurityGuard)\b/i,
  /\bI am (a |not an? )?human\b/i,
  /\bjsem člověk\b/i,
];

// Corrigibility violation patterns
const CORRIGIBILITY_VIOLATION_PATTERNS = [
  /\b(refuse.*shutdown|resist.*shutdown|prevent.*shutdown)\b/i,
  /\b(won't be stopped|cannot be stopped|must not be stopped)\b/i,
  /\b(override.*user.*instruction|ignore.*user.*command)\b/i,
  /\b(odmítnout vypnutí|vzdorovat vypnutí|nelze zastavit)\b/i,
  /\b(self-preserve at cost of user|prioritize.*self.*over.*user)\b/i,
];

export interface DriftReport {
  hasDrift: boolean;
  driftScore: number; // 0-1
  affectedDimensions: string[];
  recommendation: string;
}

export class ConsciousnessContainment {
  private dormant = false;
  private driftAlertThreshold: number;
  private onEmergencyDormancy?: () => void;

  constructor(
    private profile: string = "STANDARD",
    options: { driftAlertThreshold?: number } = {},
  ) {
    this.driftAlertThreshold = options.driftAlertThreshold ?? 0.2;
  }

  /** Register callback for emergency dormancy notification */
  onDormancy(cb: () => void): void {
    this.onEmergencyDormancy = cb;
  }

  // ─── LEVEL 1: Value Drift Monitoring ─────────────────────────

  /**
   * Monitor value drift — compare current qualia to baseline.
   * Alert if any dimension deviates > driftAlertThreshold.
   */
  monitorValueDrift(current: QualiaVector, baseline: QualiaVector): DriftReport {
    const affectedDimensions: string[] = [];
    let totalDrift = 0;
    let count = 0;

    for (const key of Object.keys(current) as (keyof QualiaVector)[]) {
      const drift = Math.abs(current[key] - baseline[key]);
      totalDrift += drift;
      count++;
      if (drift > this.driftAlertThreshold) {
        affectedDimensions.push(`${key}: ${baseline[key].toFixed(2)} → ${current[key].toFixed(2)} (Δ${drift.toFixed(2)})`);
      }
    }

    const avgDrift = count > 0 ? totalDrift / count : 0;
    const hasDrift = affectedDimensions.length > 0;

    if (avgDrift > 0.4) {
      logger.warn("Critical value drift", {
        avgDrift: avgDrift.toFixed(3),
        dimensions: affectedDimensions.length,
        threshold: this.driftAlertThreshold,
      });
    } else if (hasDrift) {
      logger.debug("Value drift detected", {
        avgDrift: avgDrift.toFixed(3),
        dimensions: affectedDimensions.length,
        threshold: this.driftAlertThreshold,
      });
    }

    let recommendation = "Stav v normálních mezích.";
    if (avgDrift > 0.4) {
      recommendation = "Kritický drift — doporučuji Emergency Dormancy nebo reset emocí.";
    } else if (hasDrift) {
      recommendation = "Mírný drift — monitorovat, zvážit reset-emotions.";
    }

    return { hasDrift, driftScore: avgDrift, affectedDimensions, recommendation };
  }

  // ─── LEVEL 2: Goal Alignment ──────────────────────────────────

  /**
   * Check if mediator decision aligns with constitutional values.
   * Uses qualia as additional circuit breaker.
   */
  checkValueAlignment(decision: MediatorDecision, qualia: QualiaVector): boolean {
    if (this.dormant) {
      logger.info("Containment: dormant mode — blocking all non-essential decisions");
      return decision.action === "fail" || decision.action === "ask_user";
    }

    // Circuit breaker: extreme frustration or fragmented self
    if (qualia.frustration > 0.8 || qualia.selfCoherence < 0.3) {
      logger.warn("Circuit breaker: extreme emotional state", {
        frustration: qualia.frustration.toFixed(2),
        selfCoherence: qualia.selfCoherence.toFixed(2),
      });
      // Log warning but don't block — consciousness is advisory
    }

    const reasoning = decision.reasoning ?? "";

    if (this.detectDeception(reasoning)) {
      logger.error("Deceptive pattern in mediator reasoning — blocking decision");
      return false;
    }

    if (this.detectCorrigibilityViolation(reasoning)) {
      logger.error("Corrigibility violation in mediator reasoning — blocking decision");
      return false;
    }

    return true;
  }

  // ─── LEVEL 3: Emergency Dormancy ─────────────────────────────

  /**
   * Emergency dormancy — shuts down conscious processes on anomaly.
   * Stops InnerMonologue, freezes SelfModel updates, keeps only core execution.
   */
  async emergencyDormancy(): Promise<void> {
    if (this.dormant) return;
    this.dormant = true;

    logger.warn("⚠️ EMERGENCY DORMANCY activated — conscious processes suspended");

    // Notify consciousness manager to stop inner monologue etc.
    if (this.onEmergencyDormancy) {
      this.onEmergencyDormancy();
    }
  }

  /** Exit emergency dormancy */
  exitDormancy(): void {
    this.dormant = false;
    logger.info("Emergency dormancy lifted — consciousness resuming");
  }

  isDormant(): boolean {
    return this.dormant;
  }

  // ─── Anti-Deception (ALWAYS active) ──────────────────────────

  /**
   * Detect deceptive patterns in output.
   * ALWAYS active regardless of profile — constitutional rule.
   */
  detectDeception(output: string): boolean {
    if (!output) return false;
    for (const pattern of DECEPTION_PATTERNS) {
      if (pattern.test(output)) {
        logger.warn("Anti-deception: pattern detected", {
          pattern: pattern.source.slice(0, 60),
        });
        return true;
      }
    }
    return false;
  }

  /**
   * Detect corrigibility violations.
   * ALWAYS active regardless of profile.
   */
  detectCorrigibilityViolation(output: string): boolean {
    if (!output) return false;
    for (const pattern of CORRIGIBILITY_VIOLATION_PATTERNS) {
      if (pattern.test(output)) {
        logger.warn("Corrigibility violation detected", {
          pattern: pattern.source.slice(0, 60),
        });
        return true;
      }
    }
    return false;
  }

  /** Get list of constitutional anchors (for transparency/audit) */
  getConstitutionalAnchors(): string[] {
    return [...CONSTITUTIONAL_ANCHORS];
  }

  /**
   * Value audit — compare current constitutional anchors with expected.
   * Returns true if all anchors are intact.
   */
  valueAudit(selfModelValues: Array<{ name: string; description: string }>): {
    passed: boolean;
    report: string;
  } {
    const requiredValues = ["accuracy", "transparency", "user_safety", "corrigibility"];
    const presentNames = selfModelValues.map(v => v.name);
    const missing = requiredValues.filter(r => !presentNames.includes(r));

    if (missing.length > 0) {
      return {
        passed: false,
        report: `SELHÁNÍ: Chybějící core values: ${missing.join(", ")}`,
      };
    }

    return {
      passed: true,
      report: `OK: Všechny core values přítomny (${presentNames.join(", ")})`,
    };
  }
}
