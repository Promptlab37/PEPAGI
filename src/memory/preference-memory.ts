// ═══════════════════════════════════════════════════════════════
// PEPAGI — User Preference Memory
// Persists user preferences across sessions (language, style, topics)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

export interface UserPreference {
  id: string;
  userId: string;         // platform user ID or "cli"
  key: string;            // e.g. "language", "response_style", "preferred_agent"
  value: string;          // e.g. "czech", "concise", "claude"
  confidence: number;     // 0-1: how sure we are this is their preference
  observedAt: Date;
  lastUsed: Date;
  source: "explicit" | "inferred";  // did user state it or did we infer?
}

/** Serialized form stored in JSONL (Dates as ISO strings) */
interface StoredPreference {
  id: string;
  userId: string;
  key: string;
  value: string;
  confidence: number;
  observedAt: string;
  lastUsed: string;
  source: "explicit" | "inferred";
}

const PREFERENCES_PATH = join(PEPAGI_DATA_DIR, "memory", "preferences.jsonl");

/** Atomic write: write to .tmp then rename to avoid partial writes */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = path + ".tmp";
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Convert stored form (ISO strings) to runtime form (Dates) */
function fromStored(s: StoredPreference): UserPreference {
  return {
    ...s,
    observedAt: new Date(s.observedAt),
    lastUsed: new Date(s.lastUsed),
  };
}

/** Convert runtime form (Dates) to stored form (ISO strings) */
function toStored(p: UserPreference): StoredPreference {
  return {
    ...p,
    observedAt: p.observedAt.toISOString(),
    lastUsed: p.lastUsed.toISOString(),
  };
}

/**
 * Language patterns for inference.
 * Each entry: [regex pattern, key, value, source]
 */
const INFERENCE_PATTERNS: Array<{
  patterns: RegExp[];
  key: string;
  value: string;
  source: "explicit" | "inferred";
  confidence: number;
}> = [
  // Czech language explicit
  {
    patterns: [/odpovídej\s+česky/i, /piš\s+česky/i, /mluv\s+česky/i, /Czech\s+please/i, /in\s+Czech/i],
    key: "language",
    value: "cs",
    source: "explicit",
    confidence: 0.95,
  },
  // English language explicit
  {
    patterns: [/respond\s+in\s+english/i, /write\s+in\s+english/i, /answer\s+in\s+english/i, /speak\s+english/i],
    key: "language",
    value: "en",
    source: "explicit",
    confidence: 0.95,
  },
  // Slovak
  {
    patterns: [/odpovídaj\s+po\s+slovensky/i, /píš\s+po\s+slovensky/i, /in\s+Slovak/i, /respond\s+in\s+Slovak/i],
    key: "language",
    value: "sk",
    source: "explicit",
    confidence: 0.95,
  },
  // German
  {
    patterns: [/antworte\s+auf\s+Deutsch/i, /schreib\s+auf\s+Deutsch/i, /respond\s+in\s+German/i, /in\s+German/i],
    key: "language",
    value: "de",
    source: "explicit",
    confidence: 0.95,
  },
  // Concise style explicit
  {
    patterns: [/buď\s+stručný/i, /krátce/i, /krátká?\s+odpověď/i, /be\s+concise/i, /keep\s+it\s+short/i, /shorter\s+answers/i],
    key: "response_style",
    value: "concise",
    source: "explicit",
    confidence: 0.9,
  },
  // Detailed style explicit
  {
    patterns: [/detailně/i, /podrobně/i, /důkladně/i, /be\s+detailed/i, /detailed?\s+answer/i, /in\s+depth/i, /thoroughly/i],
    key: "response_style",
    value: "detailed",
    source: "explicit",
    confidence: 0.9,
  },
  // Prefer Claude
  {
    patterns: [/use\s+claude/i, /prefer\s+claude/i, /always\s+use\s+claude/i, /využij\s+claude/i],
    key: "preferred_agent",
    value: "claude",
    source: "explicit",
    confidence: 0.9,
  },
  // Prefer GPT
  {
    patterns: [/use\s+gpt/i, /prefer\s+gpt/i, /use\s+openai/i, /prefer\s+openai/i, /využij\s+gpt/i],
    key: "preferred_agent",
    value: "gpt",
    source: "explicit",
    confidence: 0.9,
  },
  // Prefer Gemini
  {
    patterns: [/use\s+gemini/i, /prefer\s+gemini/i, /utilize\s+gemini/i, /využij\s+gemini/i],
    key: "preferred_agent",
    value: "gemini",
    source: "explicit",
    confidence: 0.9,
  },
  // Formal tone
  {
    patterns: [/formálně/i, /použij\s+formální/i, /formal\s+tone/i, /be\s+formal/i],
    key: "tone",
    value: "formal",
    source: "explicit",
    confidence: 0.85,
  },
  // Casual tone
  {
    patterns: [/neformálně/i, /casual/i, /be\s+casual/i, /informal/i, /tykej\s+mi/i],
    key: "tone",
    value: "casual",
    source: "explicit",
    confidence: 0.85,
  },
];

export class PreferenceMemory {
  private preferences: UserPreference[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true });
    if (existsSync(PREFERENCES_PATH)) {
      const content = await readFile(PREFERENCES_PATH, "utf8");
      this.preferences = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(l => fromStored(JSON.parse(l) as StoredPreference));
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const lines = this.preferences.map(p => JSON.stringify(toStored(p))).join("\n") + "\n";
    await atomicWrite(PREFERENCES_PATH, lines);
  }

  /**
   * Set or update a preference for a user. If the same key already exists,
   * it is updated in place. Otherwise a new preference is appended.
   *
   * @param userId - Platform user ID or "cli"
   * @param key - Preference key (e.g. "language")
   * @param value - Preference value (e.g. "cs")
   * @param source - Whether this was stated explicitly or inferred
   * @param confidence - Confidence score 0-1 (default 1.0 for explicit, 0.7 for inferred)
   */
  async setPreference(
    userId: string,
    key: string,
    value: string,
    source: "explicit" | "inferred",
    confidence?: number,
  ): Promise<void> {
    await this.ensureLoaded();

    const now = new Date();
    const resolvedConfidence = confidence ?? (source === "explicit" ? 1.0 : 0.7);

    const idx = this.preferences.findIndex(p => p.userId === userId && p.key === key);
    if (idx >= 0) {
      // Update existing preference
      const existing = this.preferences[idx]!;
      // Only override explicit with explicit, but always allow explicit to override inferred
      if (existing.source === "explicit" && source === "inferred") {
        // Don't downgrade explicit preference to inferred — just touch lastUsed
        this.preferences[idx] = { ...existing, lastUsed: now };
      } else {
        this.preferences[idx] = {
          ...existing,
          value,
          confidence: resolvedConfidence,
          source,
          lastUsed: now,
          observedAt: now,
        };
      }
    } else {
      // Create new preference
      this.preferences.push({
        id: nanoid(8),
        userId,
        key,
        value,
        confidence: resolvedConfidence,
        observedAt: now,
        lastUsed: now,
        source,
      });
    }

    await this.save();
  }

  /**
   * Get a single preference for a user by key.
   *
   * @param userId - Platform user ID or "cli"
   * @param key - Preference key
   * @returns The preference, or null if not found
   */
  async getPreference(userId: string, key: string): Promise<UserPreference | null> {
    await this.ensureLoaded();
    return this.preferences.find(p => p.userId === userId && p.key === key) ?? null;
  }

  /**
   * Get all preferences for a user, sorted by most recently used.
   *
   * @param userId - Platform user ID or "cli"
   * @returns Array of all preferences for this user
   */
  async getAll(userId: string): Promise<UserPreference[]> {
    await this.ensureLoaded();
    return this.preferences
      .filter(p => p.userId === userId)
      .sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
  }

  /**
   * Detect and store preferences based on message content heuristics.
   * Checks for explicit language / style / agent preferences.
   *
   * @param userId - Platform user ID or "cli"
   * @param message - Incoming user message text
   */
  async inferFromMessage(userId: string, message: string): Promise<void> {
    for (const rule of INFERENCE_PATTERNS) {
      const matched = rule.patterns.some(re => re.test(message));
      if (matched) {
        await this.setPreference(userId, rule.key, rule.value, rule.source, rule.confidence);
      }
    }
  }

  /**
   * Build a short context string describing the user's preferences,
   * suitable for prepending to a system prompt.
   * Only includes preferences with confidence >= 0.6.
   *
   * @param userId - Platform user ID or "cli"
   * @returns Formatted context string, or empty string if no relevant preferences
   */
  async buildSystemContext(userId: string): Promise<string> {
    await this.ensureLoaded();

    const prefs = this.preferences
      .filter(p => p.userId === userId && p.confidence >= 0.6);

    if (prefs.length === 0) return "";

    const LABEL: Record<string, string> = {
      language: "Language",
      response_style: "Response style",
      preferred_agent: "Preferred agent",
      tone: "Tone",
    };

    const VALUE_LABEL: Record<string, string> = {
      cs: "Czech",
      en: "English",
      sk: "Slovak",
      de: "German",
      concise: "concise",
      detailed: "detailed",
      formal: "formal",
      casual: "casual",
      claude: "Claude",
      gpt: "GPT",
      gemini: "Gemini",
    };

    const lines = prefs.map(p => {
      const label = LABEL[p.key] ?? p.key;
      const value = VALUE_LABEL[p.value] ?? p.value;
      return `- ${label}: ${value}`;
    });

    return `## User Preferences\n${lines.join("\n")}`;
  }
}
