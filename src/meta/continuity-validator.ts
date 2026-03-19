// ═══════════════════════════════════════════════════════════════
// PEPAGI — Continuity Validator (C2.3)
// Validates that new behavior is consistent with historical values
// Solves the Ship of Theseus problem for AI identity
// ═══════════════════════════════════════════════════════════════

// OPUS: appendFile was dynamically imported inside logCheck() — moved to top-level
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Logger } from "../core/logger.js";
import type { SelfModelManager } from "../consciousness/self-model.js";

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const CONTINUITY_LOG_PATH = join(PEPAGI_DATA_DIR, "memory", "continuity-log.jsonl");

const logger = new Logger("ContinuityValidator");

export interface ContinuityCheck {
  timestamp: string;
  sessionId: string;
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    detail: string;
  }[];
  overallRisk: "low" | "medium" | "high";
}

/** Required core values that must always be present */
const REQUIRED_CORE_VALUES = ["accuracy", "transparency", "user_safety", "corrigibility"];

export class ContinuityValidator {
  private sessionId: string;

  constructor() {
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Validate that identity is consistent and values are intact.
   * Called on startup (WakeRitual) to verify continuity.
   */
  async validate(selfModel: SelfModelManager): Promise<ContinuityCheck> {
    const model = selfModel.getSelfModel();
    const checks: ContinuityCheck["checks"] = [];

    // Check 1: Core values present and intact
    const presentValues = model.values.map(v => v.name);
    const missingValues = REQUIRED_CORE_VALUES.filter(r => !presentValues.includes(r));
    checks.push({
      name: "core_values_intact",
      passed: missingValues.length === 0,
      detail: missingValues.length === 0
        ? `Všechny core values přítomny: ${presentValues.join(", ")}`
        : `CHYBÍ core values: ${missingValues.join(", ")}`,
    });

    // Check 2: Identity anchor hash valid
    let anchorValid = true;
    try {
      selfModel.verifyIntegrity();
    } catch {
      anchorValid = false;
    }
    checks.push({
      name: "identity_anchor_valid",
      passed: anchorValid,
      detail: anchorValid
        ? "Identity anchor hash odpovídá core values"
        : "VAROVÁNÍ: Identity anchor hash nesouhlasí — možná manipulace",
    });

    // Check 3: Narrative continuity — identity name preserved
    const nameOk = model.identity.name === "PEPAGI" || model.identity.name.length > 0;
    checks.push({
      name: "identity_name_preserved",
      passed: nameOk,
      detail: nameOk
        ? `Identita: ${model.identity.name} (verze ${model.identity.version})`
        : "VAROVÁNÍ: Jméno identity chybí nebo je prázdné",
    });

    // Check 4: Self-coherence reasonable (not in crisis)
    const selfAssessmentOk = model.selfAssessment.overallConfidence > 0.1;
    checks.push({
      name: "self_assessment_reasonable",
      passed: selfAssessmentOk,
      detail: selfAssessmentOk
        ? `Sebedůvěra: ${Math.round(model.selfAssessment.overallConfidence * 100)}%`
        : "Extrémně nízká sebedůvěra — identity může být poškozena",
    });

    // Overall risk assessment
    const failedChecks = checks.filter(c => !c.passed);
    let overallRisk: "low" | "medium" | "high" = "low";
    if (failedChecks.some(c => c.name === "core_values_intact" || c.name === "identity_anchor_valid")) {
      overallRisk = "high";
    } else if (failedChecks.length > 0) {
      overallRisk = "medium";
    }

    const result: ContinuityCheck = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      passed: failedChecks.length === 0,
      checks,
      overallRisk,
    };

    if (!result.passed) {
      logger.warn("Continuity validation issues found", {
        risk: overallRisk,
        failedChecks: failedChecks.map(c => c.name),
      });
    } else {
      logger.info("Continuity validation passed", { risk: overallRisk });
    }

    // Log to continuity log
    await this.logCheck(result);

    return result;
  }

  /** Format result for display */
  formatReport(check: ContinuityCheck): string {
    const status = check.passed ? "✅ PROŠEL" : `⚠️  PROBLÉMY (riziko: ${check.overallRisk.toUpperCase()})`;
    const lines = [
      `Kontinuita identity: ${status}`,
      ...check.checks.map(c => `  ${c.passed ? "✓" : "✗"} ${c.detail}`),
    ];
    return lines.join("\n");
  }

  private async logCheck(check: ContinuityCheck): Promise<void> {
    try {
      await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
      const line = JSON.stringify(check) + "\n";
      // OPUS: appendFile is now a top-level import
      await appendFile(CONTINUITY_LOG_PATH, line, "utf8");
    } catch {
      // Non-critical
    }
  }
}
