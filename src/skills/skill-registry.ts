// ═══════════════════════════════════════════════════════════════
// PEPAGI — SkillRegistry
// Dynamic skill loader analogous to ClaWHub.
// Loads .js skill files from ~/.pepagi/skills/ at runtime.
// Each skill can be triggered by natural language patterns.
// ═══════════════════════════════════════════════════════════════

// OPUS: writeFile was dynamically imported inside writeExampleSkill() — moved to top-level
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "../security/audit-log.js";
import { scanSkillFile, signSkill, verifySkillIntegrity, type ScanResult } from "./skill-scanner.js";

const logger = new Logger("SkillRegistry");

const SKILLS_DIR = join(
  process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi"),
  "skills",
);

// ─── Skill Definition ─────────────────────────────────────────

export interface SkillContext {
  /** Original user input that matched this skill */
  input: string;
  /** Any named groups from the trigger regex match */
  params: Record<string, string>;
  /** Optional: task ID if called from within a task */
  taskId?: string;
}

export interface SkillResult {
  success: boolean;
  output: string;
  /** Optional structured data */
  data?: unknown;
}

// SECURITY: SEC-03 — Provenance metadata for skill supply chain tracking
export interface SkillProvenance {
  /** Who created this skill */
  createdBy: "distiller" | "synthesizer" | "manual" | "unknown";
  /** Task that produced this skill (if auto-generated) */
  sourceTaskId?: string;
  /** When the skill was created */
  createdAt?: string;
  /** How the skill was verified */
  verifiedBy?: "scanner" | "llm" | "human";
}

export interface SkillDefinition {
  /** Unique identifier, e.g. "send-email" */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semantic version, e.g. "1.0.0" */
  version?: string;
  /** Author info */
  author?: string;
  /**
   * Trigger patterns — can be:
   * - Simple string (substring match, case-insensitive)
   * - Regex string (if starts/ends with /)
   * Examples: "pošli email", "/faktury? (vystavit|zaplatit)/i"
   */
  triggerPatterns: string[];
  /** The actual skill implementation */
  handler: (ctx: SkillContext) => Promise<SkillResult>;
  /** Optional: tags for categorization */
  tags?: string[];
  /** SECURITY: SEC-03 — Tools this skill is allowed to use. Empty = no tool access */
  requiredTools?: string[];
  /** SECURITY: SEC-03 — Provenance tracking */
  provenance?: SkillProvenance;
}

// ─── Internal registry entry ──────────────────────────────────

interface RegistryEntry {
  skill: SkillDefinition;
  filePath: string;
  loadedAt: string;
  scanResult: ScanResult;
  /** Compiled trigger matchers */
  matchers: Array<(input: string) => Record<string, string> | null>;
}

// ─── SkillRegistry class ──────────────────────────────────────

export class SkillRegistry {
  private entries = new Map<string, RegistryEntry>();

  /** Initialize skills directory */
  async init(): Promise<void> {
    await mkdir(SKILLS_DIR, { recursive: true });

    // Create example skill on first run
    const examplePath = join(SKILLS_DIR, "example-hello.js");
    if (!existsSync(examplePath)) {
      await this.writeExampleSkill(examplePath);
    }
  }

  /**
   * Scan and load all .js skill files from the skills directory.
   * Skips files that fail the security scan.
   */
  async loadAll(): Promise<{ loaded: number; skipped: number }> {
    await this.init();
    let loaded = 0;
    let skipped = 0;

    let files: string[];
    try {
      files = await readdir(SKILLS_DIR);
    } catch {
      return { loaded, skipped };
    }

    // SEC-10: Include .mjs files in addition to .js so that ESM-only skill files
    // are subject to the same security scan. Omitting .mjs would let a malicious
    // skill bypass SkillScanner simply by using that extension.
    const jsFiles = files.filter(f => (extname(f) === ".js" || extname(f) === ".mjs") && !f.startsWith("_"));

    for (const file of jsFiles) {
      const filePath = join(SKILLS_DIR, file);
      try {
        const ok = await this.loadFile(filePath);
        if (ok) loaded++; else skipped++;
      } catch (err) {
        // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
        logger.warn("Cannot load skill file", { file, err: String(err) });
        skipped++;
      }
    }

    logger.info("SkillRegistry loaded", { loaded, skipped, total: jsFiles.length });
    return { loaded, skipped };
  }

  /**
   * Load a single skill file.
   * Runs security scan first — rejects files with high/critical risk.
   */
  async loadFile(filePath: string): Promise<boolean> {
    // Verify integrity (tamper detection) before re-scanning
    const intact = await verifySkillIntegrity(filePath);
    if (!intact) {
      logger.warn("Skill rejected — integrity check failed (file changed since approval)", { filePath });
      // SECURITY: SEC-03 — Emit event and audit log on integrity failure
      eventBus.emit({ type: "security:skill_blocked", skill: filePath, reason: "integrity_violation" });
      await auditLog({ actionType: "skill_blocked", details: `Integrity check failed: ${filePath}`, outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
      return false;
    }

    const scanResult = await scanSkillFile(filePath);
    if (!scanResult.approved) {
      logger.warn("Skill rejected", { filePath, risk: scanResult.riskLevel });
      // SECURITY: SEC-03 — Emit event on scan failure
      eventBus.emit({ type: "security:skill_blocked", skill: filePath, reason: `scan_risk_${scanResult.riskLevel}` });
      await auditLog({ actionType: "skill_blocked", details: `Scan rejected (${scanResult.riskLevel}): ${filePath}`, outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
      return false;
    }

    // Sign the approved skill (record checksum for future tamper detection)
    await signSkill(filePath).catch(e => logger.debug("FIX: skill signing failed", { error: String(e) }));

    // Dynamic import via file:// URL
    const fileUrl = new URL(`file://${filePath}`).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(fileUrl) as { default?: SkillDefinition } | { skill?: SkillDefinition };

    const skill: SkillDefinition | undefined =
      ("default" in mod ? mod.default : undefined) ??
      ("skill" in mod ? mod.skill : undefined);

    if (!skill || typeof skill.handler !== "function") {
      logger.warn("Skill file does not export a SkillDefinition", { filePath });
      return false;
    }

    if (!skill.name || !skill.triggerPatterns?.length) {
      logger.warn("Skill missing name or triggerPatterns", { filePath, name: skill.name });
      return false;
    }

    const matchers = this.compileTriggers(skill.triggerPatterns);

    this.entries.set(skill.name, {
      skill,
      filePath,
      loadedAt: new Date().toISOString(),
      scanResult,
      matchers,
    });

    logger.info("Skill loaded", { name: skill.name, version: skill.version, triggers: skill.triggerPatterns.length });
    return true;
  }

  /** Compile trigger pattern strings into matcher functions */
  private compileTriggers(patterns: string[]): Array<(input: string) => Record<string, string> | null> {
    return patterns.map(p => {
      // Regex pattern: "/pattern/flags"
      const regexMatch = p.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        try {
          const re = new RegExp(regexMatch[1]!, regexMatch[2] ?? "i");
          return (input: string) => {
            const m = input.match(re);
            if (!m) return null;
            return { ...m.groups ?? {}, _match: m[0] ?? "" };
          };
        } catch {
          return () => null;
        }
      }
      // Simple substring match (case-insensitive)
      const lower = p.toLowerCase();
      return (input: string) =>
        input.toLowerCase().includes(lower) ? { _match: p } : null;
    });
  }

  /**
   * Find a skill that matches the given input.
   * Returns the first match (matchers are checked in order of registration).
   */
  findMatch(input: string): { skill: SkillDefinition; params: Record<string, string> } | null {
    for (const entry of this.entries.values()) {
      for (const matcher of entry.matchers) {
        const params = matcher(input);
        if (params !== null) {
          return { skill: entry.skill, params };
        }
      }
    }
    return null;
  }

  /**
   * Execute a skill by name or by matching input.
   * @param input - User input to match against triggers
   * @param taskId - Optional task ID for context
   */
  async execute(input: string, taskId?: string): Promise<SkillResult | null> {
    const match = this.findMatch(input);
    if (!match) return null;

    logger.info("Executing skill", { name: match.skill.name, input: input.slice(0, 80) });

    // SECURITY: SEC-03 — Audit log every skill execution
    await auditLog({
      taskId,
      actionType: "skill_execute",
      details: `Skill: ${match.skill.name}, input: ${input.slice(0, 100)}`,
      outcome: "allowed",
    }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));

    try {
      const result = await match.skill.handler({
        input,
        params: match.params,
        taskId,
      });
      logger.info("Skill completed", { name: match.skill.name, success: result.success });
      return result;
    } catch (err) {
      logger.error("Skill failed", { name: match.skill.name, err: String(err) });
      return { success: false, output: `Skill "${match.skill.name}" selhal: ${String(err)}` };
    }
  }

  /** List all loaded skills */
  list(): Array<{ name: string; description: string; triggers: string[]; tags?: string[] }> {
    return Array.from(this.entries.values()).map(e => ({
      name: e.skill.name,
      description: e.skill.description,
      triggers: e.skill.triggerPatterns,
      tags: e.skill.tags,
    }));
  }

  /** Unload a skill by name */
  unload(name: string): boolean {
    return this.entries.delete(name);
  }

  get size(): number { return this.entries.size; }

  /** Create an example skill so the user knows the format */
  private async writeExampleSkill(path: string): Promise<void> {
    const example = `// PEPAGI Skill — Example Hello World
// Place your own .js skill files in ~/.pepagi/skills/
// Each file must export a default SkillDefinition object.

export default {
  name: "hello-pepagi",
  description: "Responds to hello/ahoj greetings",
  version: "1.0.0",
  triggerPatterns: ["hello pepagi skill", "ahoj pepagi skill"],
  tags: ["demo"],

  async handler(ctx) {
    return {
      success: true,
      output: \`👋 Ahoj! Jsem PEPAGI skill. Dostál jsem vstup: "\${ctx.input}"\`,
    };
  },
};
`;
    // OPUS: writeFile is now a top-level import
    await readFile(path, "utf8").catch(async () => {
      await writeFile(path, example, "utf8");
      logger.info("Example skill created", { path });
    });
  }
}

/** Singleton instance */
export const skillRegistry = new SkillRegistry();
