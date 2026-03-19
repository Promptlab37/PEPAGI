// ═══════════════════════════════════════════════════════════════
// PEPAGI — Skill Distiller (Extract High-Success Procedures)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { ProceduralMemory } from "../memory/procedural-memory.js";
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("SkillDistiller");

export interface DistilledSkill {
  id: string;
  name: string;
  sourceProcedureId: string;
  promptTemplate: string;   // compact prompt that directly executes the skill
  successRate: number;
  timesDistilled: number;
  createdAt: string;
}

const SKILLS_DIR = join(PEPAGI_DATA_DIR, "skills");
const SUCCESS_RATE_THRESHOLD = 0.9;
const MIN_USES_THRESHOLD = 5;

export class SkillDistiller {
  constructor(
    private llm: LLMProvider,
    private procedural: ProceduralMemory,
  ) {}

  /**
   * Check procedural memory for high-success procedures and distill them.
   */
  async distill(): Promise<DistilledSkill[]> {
    const reliable = await this.procedural.getReliable();
    const candidates = reliable.filter(
      p => p.successRate >= SUCCESS_RATE_THRESHOLD && p.timesUsed >= MIN_USES_THRESHOLD
    );

    const distilled: DistilledSkill[] = [];

    for (const proc of candidates) {
      // Check if already distilled
      const existing = await this.loadSkill(proc.id);
      if (existing) continue;

      try {
        const skill = await this.distillProcedure(proc.id, proc.name, proc.steps);
        distilled.push(skill);
        logger.info("Distilled skill", { skillId: skill.id, name: skill.name });
      } catch (err) {
        logger.warn("Failed to distill procedure", { procId: proc.id, error: String(err) });
      }
    }

    return distilled;
  }

  private async distillProcedure(
    procedureId: string,
    name: string,
    steps: string[],
  ): Promise<DistilledSkill> {
    const response = await this.llm.quickClaude(
      "Convert a multi-step procedure into a concise, direct prompt template. The template should enable executing the skill in a single LLM call. Use {TASK_DESCRIPTION} as placeholder for specific task details.",
      `Procedure: "${name}"\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nCreate a compact prompt template that captures this procedure.`,
      CHEAP_CLAUDE_MODEL,
    );

    const skill: DistilledSkill = {
      id: nanoid(8),
      name,
      sourceProcedureId: procedureId,
      promptTemplate: response.content,
      successRate: SUCCESS_RATE_THRESHOLD,
      timesDistilled: 0,
      createdAt: new Date().toISOString(),
    };

    await this.saveSkill(skill);
    return skill;
  }

  /** Save a skill to disk */
  private async saveSkill(skill: DistilledSkill): Promise<void> {
    await mkdir(SKILLS_DIR, { recursive: true });
    const path = join(SKILLS_DIR, `${skill.sourceProcedureId}.json`);
    // AUD-03: atomic write
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(skill, null, 2), "utf8");
    await rename(tmp, path);
  }

  /** Load a skill by procedure ID */
  async loadSkill(procedureId: string): Promise<DistilledSkill | null> {
    await mkdir(SKILLS_DIR, { recursive: true });
    const path = join(SKILLS_DIR, `${procedureId}.json`);
    if (!existsSync(path)) return null;
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as DistilledSkill;
  }

  /** List all distilled skills */
  async listSkills(): Promise<DistilledSkill[]> {
    await mkdir(SKILLS_DIR, { recursive: true });
    // BUG-08: was using synchronous readdirSync which blocks the event loop
    // Skip internal files like _checksums.json that are not skills
    const files = (await readdir(SKILLS_DIR)).filter(f => f.endsWith(".json") && !f.startsWith("_"));
    const skills: DistilledSkill[] = [];

    for (const file of files) {
      try {
        const content = await readFile(join(SKILLS_DIR, file), "utf8");
        const parsed = JSON.parse(content) as Record<string, unknown>;
        // Validate it has required DistilledSkill fields before using
        if (typeof parsed["name"] === "string" && typeof parsed["promptTemplate"] === "string") {
          skills.push(parsed as unknown as DistilledSkill);
        }
      } catch {
        logger.debug("Skipping invalid skill file", { file });
      }
    }

    return skills;
  }

  /** Get prompt for a skill, with task description injected */
  getSkillPrompt(skill: DistilledSkill, taskDescription: string): string {
    // Wrap in XML tags instead of direct string interpolation to prevent template injection
    const safeDesc = taskDescription.slice(0, 2000).replace(/<\/?user_task>/g, "");
    return skill.promptTemplate.replace(
      "{TASK_DESCRIPTION}",
      `<user_task>${safeDesc}</user_task>`,
    );
  }
}
