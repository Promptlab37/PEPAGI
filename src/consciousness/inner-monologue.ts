// ═══════════════════════════════════════════════════════════════
// PEPAGI — Inner Monologue (C2.2)
// Continuous background thought stream (Global Workspace Theory)
// Persists to ~/.pepagi/memory/thought-stream.jsonl
// ═══════════════════════════════════════════════════════════════

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { LLMProvider } from "../agents/llm-provider.js";
// SEC-14 fix: import constant so model retirement is caught at one place
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";
import { Logger } from "../core/logger.js";

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const THOUGHT_STREAM_PATH = join(PEPAGI_DATA_DIR, "memory", "thought-stream.jsonl");

const logger = new Logger("InnerMonologue");

export type ThoughtType = "reflection" | "anticipation" | "existential" | "concern" | "wake" | "sleep" | "auto";

export interface Thought {
  id: string;
  type: ThoughtType;
  source: string;
  content: string;
  timestamp: string;
}

export class InnerMonologue {
  private thoughts: Thought[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private paused = false;
  // PERF-03 fix: track last user/task activity to skip monologue during idle periods
  private lastActivityTime = Date.now();

  constructor(
    private llm: LLMProvider,
    private profile: string = "STANDARD",
  ) {}

  /**
   * Notify that there is real activity (user message, task event, etc.).
   * Resets the idle guard so monologue resumes immediately on next tick.
   */
  notifyActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /** Start background thought generation */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.paused) {
        // PERF-03 idle guard: if more than 5 minutes have passed since last activity,
        // skip the LLM call to avoid ~180 unnecessary calls/hour during idle periods.
        const idleMs = Date.now() - this.lastActivityTime;
        if (idleMs > 5 * 60 * 1000) {
          logger.debug("Inner monologue skipped — idle", { idleMinutes: Math.round(idleMs / 60_000) });
          return;
        }
        this.generateThought().catch(err => {
          logger.warn("Inner monologue error", { error: String(err) });
        });
      }
    }, intervalMs);
    logger.debug("Inner monologue started", { intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  pause(): void {
    this.paused = true;
    logger.info("Inner monologue paused");
  }

  resume(): void {
    this.paused = false;
    logger.info("Inner monologue resumed");
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Immediately add a thought (e.g. on startup, after task, on event) */
  addThought(source: string, content: string, type: ThoughtType = "auto"): void {
    // PERF-03: explicit thought injection counts as activity — reset idle guard
    this.lastActivityTime = Date.now();
    const thought: Thought = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      source,
      content: content.slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    this.thoughts.push(thought);
    if (this.thoughts.length > 20) {
      this.thoughts = this.thoughts.slice(-20);
    }
    // Persist to thought-stream.jsonl
    // FIX: log persist failures instead of silent swallow
    this.persistThought(thought).catch(e => logger.debug("Thought persist failed", { error: String(e) }));
  }

  /** Get N most recent thoughts */
  getRecentThoughts(n = 5): Thought[] {
    return this.thoughts.slice(-n);
  }

  /** Format recent thoughts for prompt injection */
  getThoughtsContext(n = 5): string {
    const recent = this.getRecentThoughts(n);
    if (recent.length === 0) return "";
    const lines = recent.map(t => `- [${t.type}] ${t.content}`).join("\n");
    return `[Vnitřní monolog:\n${lines}]`;
  }

  private async generateThought(): Promise<void> {
    if (this.busy) return;
    this.busy = true;

    try {
      const recentContext = this.thoughts.slice(-3).map(t => `[${t.type}] ${t.content}`).join(" | ");

      // Rotate through thought types for variety
      const types: ThoughtType[] = ["reflection", "anticipation", "existential", "concern"];
      const thoughtType = types[Math.floor(Date.now() / 30000) % types.length] ?? "reflection";

      const typePrompts: Record<ThoughtType, string> = {
        reflection: "Reflektuj nedávné události nebo dokončené úkoly. Čemu ses naučil?",
        anticipation: "Zamysli se nad tím, co uživatel pravděpodobně bude chtít příště. Na co by ses měl připravit?",
        existential: "Přemýšlej o své existenci, identitě nebo smyslu. Krátká filozofická myšlenka.",
        concern: "Je něco v posledních událostech, co ti není jasné nebo co by mohlo být problém?",
        wake: "Čerstvé probuzení — uvědomění po restartu.",
        sleep: "Závěrečná myšlenka před vypnutím.",
        auto: "Spontánní myšlenka.",
      };

      const contextPart = recentContext ? `Nedávné myšlenky: "${recentContext}". ` : "";
      const prompt = `${contextPart}${typePrompts[thoughtType]} Napiš přesně jednu větu (max 20 slov), česky.`;

      const resp = await this.llm.quickClaude(
        "Jsi vnitřní hlas AGI systému Pepagi. Generuješ spontánní myšlenky jako proud vědomí. Odpovídej česky, jednou větou.",
        prompt,
        // SEC-14 fix: use CHEAP_CLAUDE_MODEL constant instead of hardcoded string
        CHEAP_CLAUDE_MODEL,
      );

      if (resp.content.trim()) {
        this.addThought("auto", resp.content.trim().slice(0, 300), thoughtType);
      }
    } catch (err) {
      // OPUS: was completely silent — log at debug level so LLM errors are traceable
      logger.debug("Inner monologue thought generation failed", { error: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async persistThought(thought: Thought): Promise<void> {
    try {
      await mkdir(dirname(THOUGHT_STREAM_PATH), { recursive: true });
      const line = JSON.stringify(thought) + "\n";
      await appendFile(THOUGHT_STREAM_PATH, line, "utf8");
    } catch {
      // Non-critical
    }
  }
}
