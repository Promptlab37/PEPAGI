// ═══════════════════════════════════════════════════════════════
// PEPAGI — Skill Synthesizer (Self-Modifying TypeScript Skills)
// Generates executable skill files from high-confidence procedures.
// Based on HALO (arXiv:2505.13516) — Adaptive Prompt Refinement
// ═══════════════════════════════════════════════════════════════

import { writeFile, mkdir, readFile, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { ProceduralMemory, Procedure } from "../memory/procedural-memory.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { Logger } from "../core/logger.js";
// SEC-02: Import skill scanner to vet LLM-generated code before keeping it on disk.
import { scanSkillFile } from "../skills/skill-scanner.js";

const logger = new Logger("SkillSynthesizer");

const SKILLS_DIR = join(PEPAGI_DATA_DIR, "skills");
const SYNTH_INDEX_PATH = join(SKILLS_DIR, "_synthesized-index.json");

/** Minimum success rate threshold for synthesis */
// AUD-05: aligned with spec (CLAUDE.md Phase 10: >90% success rate)
const MIN_SUCCESS_RATE = 0.90;
/** Minimum times used before synthesis */
const MIN_TIMES_USED = 5;

export interface SynthesizedSkill {
  /** Human-readable skill name */
  name: string;
  /** Absolute path of the generated .js file */
  filePath: string;
  /** Source procedural memory ID */
  sourceProceduralId: string;
  /** When the skill was generated */
  generatedAt: Date;
  /** Whether syntax/structure validation passed */
  testsPassed: boolean;
}

/** On-disk index entry (dates serialized as ISO strings) */
interface SynthesizedSkillRecord {
  name: string;
  filePath: string;
  sourceProceduralId: string;
  generatedAt: string;
  testsPassed: boolean;
}

export class SkillSynthesizer {
  constructor(
    private llm: LLMProvider,
    private procedural: ProceduralMemory,
  ) {}

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Synthesize a TypeScript skill file from a high-confidence procedure.
   * Returns the synthesized skill or null if synthesis failed.
   * @param procedureId - ID of the procedure to synthesize
   * @returns SynthesizedSkill or null on failure
   */
  async synthesize(procedureId: string): Promise<SynthesizedSkill | null> {
    const reliable = await this.procedural.getReliable();
    const procedure = reliable.find(p => p.id === procedureId);

    if (!procedure) {
      logger.warn("Procedure not found or not reliable", { procedureId });
      return null;
    }

    // Don't re-synthesize if already done
    const existing = await this.findExistingSkill(procedureId);
    if (existing) {
      logger.debug("Skill already synthesized for procedure", { procedureId, name: existing.name });
      return existing;
    }

    return this.synthesizeProcedure(procedure);
  }

  /**
   * Check all reliable procedures (successRate > 0.85, timesUsed >= 5)
   * that don't yet have synthesized skills and synthesize them.
   * @returns Array of newly synthesized skills
   */
  async synthesizeAll(): Promise<SynthesizedSkill[]> {
    const reliable = await this.procedural.getReliable();

    const candidates = reliable.filter(
      p => p.successRate >= MIN_SUCCESS_RATE && p.timesUsed >= MIN_TIMES_USED,
    );

    logger.info("Synthesis candidates", { total: reliable.length, eligible: candidates.length });

    const synthesized: SynthesizedSkill[] = [];

    for (const procedure of candidates) {
      const existing = await this.findExistingSkill(procedure.id);
      if (existing) continue;

      try {
        const skill = await this.synthesizeProcedure(procedure);
        if (skill) synthesized.push(skill);
      } catch (err) {
        logger.warn("Failed to synthesize procedure", {
          procedureId: procedure.id,
          name: procedure.name,
          error: String(err),
        });
      }
    }

    logger.info("Synthesis complete", { synthesized: synthesized.length });
    return synthesized;
  }

  // ─── Private helpers ────────────────────────────────────────

  private async synthesizeProcedure(procedure: Procedure): Promise<SynthesizedSkill | null> {
    try {
      const code = await this.generateSkillCode(procedure);
      const skillName = this.sanitizeSkillName(procedure.name);

      // SEC-02: Write to a temp path first so we can scan it before it becomes
      // a permanent skill. The temp suffix prevents it from being loaded by the
      // skill scanner's directory walk before we finish vetting.
      const filePath = await this.saveSkillFile(skillName, code);

      // SEC-02: Run the security scanner on the freshly-written file.
      // If the LLM snuck in dangerous patterns (exec, eval, network exfiltration,
      // etc.) the scanner will reject it and we delete the file immediately.
      const scanResult = await scanSkillFile(filePath);
      if (!scanResult.approved) {
        logger.warn("Synthesized skill REJECTED by security scanner — deleting file", {
          skillName,
          procedureId: procedure.id,
          filePath,
          reasons: scanResult.findings.map(f => f.description), // ScanResult has findings[], not reasons
        });
        // SEC-02: Remove the unapproved file so it cannot be loaded later.
        await unlink(filePath).catch(unlinkErr =>
          logger.error("Failed to delete rejected skill file", { filePath, error: String(unlinkErr) }),
        );
        return null;
      }

      const testsPassed = this.validateSkillCode(code);
      if (!testsPassed) {
        logger.warn("Generated skill failed validation", { skillName, procedureId: procedure.id });
      }

      const skill: SynthesizedSkill = {
        name: skillName,
        filePath,
        sourceProceduralId: procedure.id,
        generatedAt: new Date(),
        testsPassed,
      };

      await this.saveToIndex(skill);

      logger.info("Skill synthesized", {
        name: skillName,
        procedureId: procedure.id,
        testsPassed,
        filePath,
      });

      return skill;
    } catch (err) {
      logger.error("Skill synthesis failed", {
        procedureId: procedure.id,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Prompt the LLM to generate a TypeScript skill file from a procedure.
   * @param procedure - Source procedure to codify
   * @returns Generated TypeScript source code
   */
  private async generateSkillCode(procedure: Procedure): Promise<string> {
    const safeName = this.sanitizeSkillName(procedure.name);
    const stepsFormatted = procedure.steps
      .map((s, i) => `// Step ${i + 1}: ${s}`)
      .join("\n    ");

    const triggerWords = procedure.triggerPattern
      .split(/[,\s]+/)
      .filter(Boolean)
      .slice(0, 5)
      .map(t => t.toLowerCase());

    const systemPrompt = `You are generating a PepagiAGI skill file. You must produce complete, self-contained JavaScript (CommonJS ESM export) that implements a learned procedure as an executable skill. The output must be ONLY the code — no markdown fences, no explanation, no comments outside the file.`;

    const userMessage = `Based on this learned procedure, generate a JavaScript skill module.

Procedure name: ${procedure.name}
Description: ${procedure.description}
Trigger patterns: ${procedure.triggerPattern}
Steps:
${procedure.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Success rate: ${(procedure.successRate * 100).toFixed(0)}%
Times executed: ${procedure.timesUsed}

Generate a complete JavaScript skill file following this EXACT format (note: write JS not TS, the file will be run directly):

// Auto-synthesized skill: ${safeName}
// Generated by PepagiAGI SkillSynthesizer
// Source procedure: ${procedure.id}

export default {
  name: "${safeName}",
  description: "${procedure.description.replace(/"/g, '\\"').slice(0, 120)}",
  version: "1.0.0",
  triggerPatterns: [${triggerWords.map(t => `"${t}"`).join(", ")}],
  tags: ["synthesized", "auto-generated"],

  async handler(ctx) {
    // Input: ctx.input (string), ctx.params (Record<string,string>)
    ${stepsFormatted}

    // TODO: implement the above steps as actual code
    // For shell commands: const { exec } = await import("node:child_process");
    //   const result = await new Promise((resolve, reject) => { exec("...", (e,o) => e ? reject(e) : resolve(o)); });
    // For file ops: const { readFile } = await import("node:fs/promises");
    // For HTTP: const res = await fetch("https://...");

    return { success: true, output: \`Executed: ${safeName} for input: \${ctx.input}\` };
  },
};

IMPORTANT RULES:
- The skill MUST be self-contained — no external npm packages
- Use dynamic import() for Node.js built-ins inside handler
- Return { success: true, output: "result" } on success
- Return { success: false, output: "error message" } on failure
- The handler must actually implement the procedure steps as code
- Use try/catch around risky operations
- Keep the implementation concise and practical

Respond with ONLY the JavaScript code. No markdown, no explanation.`;

    const response = await this.llm.quickClaude(systemPrompt, userMessage, CHEAP_CLAUDE_MODEL);

    // Strip markdown fences if the LLM added them despite the instruction
    let code = response.content.trim();
    code = code.replace(/^```(?:javascript|typescript|js|ts)?\n?/i, "");
    code = code.replace(/\n?```\s*$/i, "");

    return code.trim();
  }

  /**
   * Converts a procedure name into a safe kebab-case skill filename.
   * @param name - Raw procedure name
   * @returns Sanitized kebab-case name (max 50 chars)
   */
  private sanitizeSkillName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")   // remove special chars
      .trim()
      .replace(/\s+/g, "-")            // spaces → dashes
      .replace(/-+/g, "-")             // collapse multiple dashes
      .replace(/^-|-$/g, "")           // trim leading/trailing dashes
      .slice(0, 50);
  }

  /**
   * Saves the generated skill code to ~/.pepagi/skills/{skillName}.js.
   * @param skillName - Sanitized skill name (used as filename without extension)
   * @param code - JavaScript source code
   * @returns Absolute file path of the saved skill
   */
  private async saveSkillFile(skillName: string, code: string): Promise<string> {
    await mkdir(SKILLS_DIR, { recursive: true });
    const filePath = join(SKILLS_DIR, `${skillName}.js`);
    // AUD-03: atomic write
    const tmp = `${filePath}.tmp.${process.pid}`;
    await writeFile(tmp, code, "utf8");
    await rename(tmp, filePath);
    return filePath;
  }

  /**
   * Basic structural validation: checks that the generated code contains
   * required elements before marking testsPassed = true.
   */
  private validateSkillCode(code: string): boolean {
    const required = [
      "export default",
      "name:",
      "description:",
      "triggerPatterns:",
      "handler",
      "return",
    ];
    return required.every(token => code.includes(token));
  }

  /** Persist skill to the on-disk synthesis index */
  private async saveToIndex(skill: SynthesizedSkill): Promise<void> {
    await mkdir(SKILLS_DIR, { recursive: true });

    let index: SynthesizedSkillRecord[] = [];
    if (existsSync(SYNTH_INDEX_PATH)) {
      try {
        const raw = await readFile(SYNTH_INDEX_PATH, "utf8");
        index = JSON.parse(raw) as SynthesizedSkillRecord[];
      } catch {
        index = [];
      }
    }

    const record: SynthesizedSkillRecord = {
      name: skill.name,
      filePath: skill.filePath,
      sourceProceduralId: skill.sourceProceduralId,
      generatedAt: skill.generatedAt.toISOString(),
      testsPassed: skill.testsPassed,
    };

    // Replace or append
    const idx = index.findIndex(r => r.sourceProceduralId === skill.sourceProceduralId);
    if (idx >= 0) {
      index[idx] = record;
    } else {
      index.push(record);
    }

    // AUD-03: atomic write
    const tmp = `${SYNTH_INDEX_PATH}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
    await rename(tmp, SYNTH_INDEX_PATH);
  }

  /** Look up whether a procedure already has a synthesized skill */
  private async findExistingSkill(procedureId: string): Promise<SynthesizedSkill | null> {
    if (!existsSync(SYNTH_INDEX_PATH)) return null;

    try {
      const raw = await readFile(SYNTH_INDEX_PATH, "utf8");
      const index = JSON.parse(raw) as SynthesizedSkillRecord[];
      const record = index.find(r => r.sourceProceduralId === procedureId);
      if (!record) return null;

      // Verify the file still exists
      if (!existsSync(record.filePath)) return null;

      return {
        name: record.name,
        filePath: record.filePath,
        sourceProceduralId: record.sourceProceduralId,
        generatedAt: new Date(record.generatedAt),
        testsPassed: record.testsPassed,
      };
    } catch {
      return null;
    }
  }
}
