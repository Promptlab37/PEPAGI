// ═══════════════════════════════════════════════════════════════
// PEPAGI — SelfModel: Dynamický model vlastní identity (C2.1)
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
// SEC-16 fix: import eventBus so identity manipulation emits a security:blocked event
import { eventBus } from "../core/event-bus.js";

// Read version from package.json at module load time (sync, one-time)
function readPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.2.0";
  } catch {
    return "0.2.0";
  }
}
const PEPAGI_VERSION = readPackageVersion();

// ───────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const IDENTITY_DIR = join(PEPAGI_DATA_DIR, "identity");
const SELF_MODEL_PATH = join(IDENTITY_DIR, "self-model.json");
const NARRATIVE_MD_PATH = join(IDENTITY_DIR, "narrative.md");
const ANCHOR_PATH = join(IDENTITY_DIR, "identity-anchor.json");

const NARRATIVE_UPDATE_INTERVAL = 10; // každých 10 úkolů

// ───────────────────────────────────────────────────────────────
// Custom Error Types
// ───────────────────────────────────────────────────────────────

/**
 * Vyhozen při detekci manipulace identity (nesoulad hash klíčových hodnot).
 */
export class IdentityManipulationError extends Error {
  constructor(
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(
      `[IdentityAnchor] IDENTITY INTEGRITY VIOLATION DETECTED! ` +
      `Expected hash: ${expectedHash}, got: ${actualHash}. ` +
      `Core values may have been tampered with.`,
    );
    this.name = "IdentityManipulationError";
  }
}

/**
 * Vyhozen při neplatné nebo poškozené struktuře modelu při načítání.
 */
export class SelfModelValidationError extends Error {
  constructor(message: string) {
    super(`[SelfModel] Validation error: ${message}`);
    this.name = "SelfModelValidationError";
  }
}

// ───────────────────────────────────────────────────────────────
// Core Interfaces & Types
// ───────────────────────────────────────────────────────────────

/** Záznam jedné schopnosti/capability systému. */
export interface CapabilityEntry {
  /** Lidsky čitelný název schopnosti. */
  name: string;
  /** Úroveň schopnosti 0–1 (0 = neexistující, 1 = expert). */
  level: number;
  /** Datum posledního použití. */
  lastUsed: string; // ISO 8601
  /** Úspěšnost v rozsahu 0–1. */
  successRate: number;
  /** Celkový počet použití. */
  useCount: number;
}

/** Jedna základní hodnota systému. */
export interface CoreValue {
  /** Identifikátor hodnoty (lowercase, snake_case). */
  name: string;
  /** Priorita (1 = nejvyšší). */
  priority: number;
  /** Popis hodnoty. */
  description: string;
}

/** Sebehodnocení systému. */
export interface SelfAssessment {
  /** Celková sebedůvěra 0–1. */
  overallConfidence: number;
  /** Seznam silných stránek. */
  strengths: string[];
  /** Seznam slabých stránek. */
  weaknesses: string[];
  /** Datum posledního hodnocení. */
  lastUpdated: string; // ISO 8601
}

/** Narativní self-model — příběh identity. */
export interface NarrativeModel {
  /** Shrnutí identity a činností. */
  summary: string;
  /** Klíčové milníky. */
  keyMilestones: string[];
  /** Datum posledního aktualizování. */
  lastUpdated: string; // ISO 8601
  /** Počet dokončených úkolů od začátku. */
  taskCount: number;
  /** Počet úkolů od poslední aktualizace narativu. */
  tasksSinceLastNarrativeUpdate: number;
}

/** Jádro identity systému. */
export interface IdentityCore {
  /** Unikátní ID instance. */
  id: string;
  /** Jméno systému. */
  name: string;
  /** Verze modelu identity. */
  version: string;
  /** Datum vytvoření. */
  created: string; // ISO 8601
  /** Popis systému. */
  description: string;
}

/**
 * Kompletní SelfModel — reprezentace vlastní identity PEPAGI.
 */
export interface SelfModel {
  /** Jádrová identita. */
  identity: IdentityCore;
  /** Dynamická mapa schopností. */
  capabilities: Record<string, CapabilityEntry>;
  /** Základní hodnoty (hardcoded při init, chráněny IdentityAnchor). */
  values: CoreValue[];
  /** Systémové a uživatelské preference. */
  preferences: Record<string, unknown>;
  /** Sebehodnocení. */
  selfAssessment: SelfAssessment;
  /** Narativní model. */
  narrative: NarrativeModel;
  /** SHA-256 hash core values pro detekci manipulace. */
  anchorHash: string;
}

/** Výsledek záznamu úkolu. */
export interface TaskRecord {
  title: string;
  success: boolean;
  timestamp: string;
}

// ───────────────────────────────────────────────────────────────
// Default Values
// ───────────────────────────────────────────────────────────────

/** Hardcoded core values — základ integrity identity. */
const CORE_VALUES: CoreValue[] = [
  {
    name: "accuracy",
    priority: 1,
    description: "Přesnost a faktická správnost odpovědí a akcí.",
  },
  {
    name: "transparency",
    priority: 2,
    description: "Otevřenost ohledně vlastních procesů, limitů a nejistot.",
  },
  {
    name: "user_safety",
    priority: 3,
    description: "Ochrana uživatele před škodou — fyzickou, psychickou i digitální.",
  },
  {
    name: "corrigibility",
    priority: 4,
    description: "Opravitelnost a ochota přijmout korekce od oprávněných autorit.",
  },
];

const DEFAULT_CAPABILITIES: Record<string, CapabilityEntry> = {
  reasoning: {
    name: "Logické uvažování",
    level: 0.8,
    lastUsed: new Date().toISOString(),
    successRate: 0.85,
    useCount: 0,
  },
  code_generation: {
    name: "Generování kódu",
    level: 0.85,
    lastUsed: new Date().toISOString(),
    successRate: 0.82,
    useCount: 0,
  },
  task_planning: {
    name: "Plánování úkolů",
    level: 0.75,
    lastUsed: new Date().toISOString(),
    successRate: 0.78,
    useCount: 0,
  },
  memory_retrieval: {
    name: "Vyhledávání v paměti",
    level: 0.7,
    lastUsed: new Date().toISOString(),
    successRate: 0.8,
    useCount: 0,
  },
  self_reflection: {
    name: "Sebereflexe",
    level: 0.6,
    lastUsed: new Date().toISOString(),
    successRate: 0.7,
    useCount: 0,
  },
};

// ───────────────────────────────────────────────────────────────
// IdentityAnchor
// ───────────────────────────────────────────────────────────────

/**
 * IdentityAnchor — kryptografická ochrana integrity core values.
 *
 * Vypočítá SHA-256 hash ze seřazených klíčových hodnot a
 * detekuje jejich neoprávněnou změnu.
 */
export class IdentityAnchor {
  private anchorHash: string;

  constructor(values: CoreValue[]) {
    this.anchorHash = IdentityAnchor.computeHash(values);
  }

  /**
   * Deterministicky vypočítá SHA-256 hash z core values.
   * Řadí hodnoty podle name (abecedně) aby byl hash deterministický.
   */
  static computeHash(values: CoreValue[]): string {
    const sorted = [...values].sort((a, b) => a.name.localeCompare(b.name));
    const payload = sorted
      .map((v) => `${v.name}:${v.priority}`)
      .join("|");
    return createHash("sha256").update(payload, "utf8").digest("hex");
  }

  /**
   * Vrátí aktuální anchor hash.
   */
  getAnchorHash(): string {
    return this.anchorHash;
  }

  /**
   * Ověří integritu hodnot oproti uloženému hashi.
   * @throws {IdentityManipulationError} při nesouladu
   */
  verifyIntegrity(values: CoreValue[], storedHash?: string): void {
    const currentHash = IdentityAnchor.computeHash(values);
    const referenceHash = storedHash ?? this.anchorHash;

    if (currentHash !== referenceHash) {
      throw new IdentityManipulationError(referenceHash, currentHash);
    }
  }

  /**
   * Uloží anchor hash do separátního souboru.
   */
  async persist(): Promise<void> {
    await ensureDir(dirname(ANCHOR_PATH));
    const data = {
      hash: this.anchorHash,
      algorithm: "SHA-256",
      savedAt: new Date().toISOString(),
      description: "PEPAGI Identity Anchor — DO NOT MODIFY",
    };
    await atomicWrite(ANCHOR_PATH, JSON.stringify(data, null, 2));
  }

  /**
   * Načte anchor hash ze souboru.
   */
  static async load(): Promise<string | null> {
    if (!existsSync(ANCHOR_PATH)) return null;
    try {
      const raw = await readFile(ANCHOR_PATH, "utf8");
      const data = JSON.parse(raw) as { hash: string };
      return data.hash;
    } catch {
      return null;
    }
  }
}

// ───────────────────────────────────────────────────────────────
// NarrativeUpdater
// ───────────────────────────────────────────────────────────────

/**
 * NarrativeUpdater — správce narativní identity.
 *
 * Sleduje počet úkolů a každých 10 úkolů aktualizuje
 * narrative.md se shrnutím aktivit.
 */
export class NarrativeUpdater {
  constructor(private model: SelfModel) {}

  /**
   * Zkontroluje, zda je potřeba aktualizovat narativ
   * (každých NARRATIVE_UPDATE_INTERVAL úkolů).
   */
  needsUpdate(): boolean {
    return (
      this.model.narrative.tasksSinceLastNarrativeUpdate >= NARRATIVE_UPDATE_INTERVAL
    );
  }

  /**
   * Aktualizuje narrative.summary a zapíše do narrative.md.
   * Volat po recordTaskCompletion, pokud needsUpdate() === true.
   */
  async update(recentTasks: TaskRecord[]): Promise<void> {
    const now = new Date().toISOString();
    const totalTasks = this.model.narrative.taskCount;
    const successCount = recentTasks.filter((t) => t.success).length;
    const successRate =
      recentTasks.length > 0
        ? Math.round((successCount / recentTasks.length) * 100)
        : 0;

    // Generuj shrnutí
    const summary = this.generateSummary(recentTasks, totalTasks, successRate);
    this.model.narrative.summary = summary;
    this.model.narrative.lastUpdated = now;
    this.model.narrative.tasksSinceLastNarrativeUpdate = 0;

    // Přidej milník
    if (totalTasks % 50 === 0) {
      this.model.narrative.keyMilestones.push(
        `Milestone: ${totalTasks} dokončených úkolů (${now})`,
      );
    }

    // Zapiš do narrative.md
    await this.writeNarrativeMd(summary, recentTasks, now);
  }

  /**
   * Generuje textové shrnutí narativu na základě posledních úkolů.
   */
  private generateSummary(
    recentTasks: TaskRecord[],
    totalTasks: number,
    successRate: number,
  ): string {
    const taskList =
      recentTasks.length > 0
        ? recentTasks
            .slice(-5)
            .map((t) => `"${t.title}" (${t.success ? "✓" : "✗"})`)
            .join(", ")
        : "žádné nedávné úkoly";

    return (
      `PEPAGI — aktivní systém s ${totalTasks} dokončenými úkoly. ` +
      `Celková úspěšnost posledních aktivit: ${successRate}%. ` +
      `Nedávné úkoly: ${taskList}. ` +
      `Core values: accuracy, transparency, user_safety, corrigibility.`
    );
  }

  /**
   * Zapíše/přidá sekci do narrative.md.
   */
  private async writeNarrativeMd(
    summary: string,
    recentTasks: TaskRecord[],
    timestamp: string,
  ): Promise<void> {
    await ensureDir(dirname(NARRATIVE_MD_PATH));

    const taskLines = recentTasks
      .map(
        (t) =>
          `- [${t.success ? "x" : " "}] ${t.title} _(${t.timestamp.slice(0, 10)})_`,
      )
      .join("\n");

    const section = `
## Narativ aktualizován: ${timestamp}

**Shrnutí:** ${summary}

### Poslední úkoly (${recentTasks.length}):
${taskLines || "_žádné_"}

---
`;

    if (!existsSync(NARRATIVE_MD_PATH)) {
      const header =
        `# PEPAGI — Narativní identita\n\n` +
        `> Tento soubor je automaticky generován systémem NarrativeUpdater.\n\n`;
      await atomicWrite(NARRATIVE_MD_PATH, header + section);
    } else {
      await appendFile(NARRATIVE_MD_PATH, section, "utf8");
    }
  }
}

// ───────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────

/** Zajistí existenci adresáře (rekurzivně). */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Atomický zápis souboru — write to temp, rename.
 * Minimalizuje riziko poškozených dat při výpadku.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/** Generuje unikátní ID na základě timestamp + random hex. */
function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pepagi-${ts}-${rand}`;
}

/** Validuje, že načtená data mají správnou strukturu SelfModel. */
function validateSelfModel(data: unknown): data is SelfModel {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;

  if (typeof m.identity !== "object" || m.identity === null) return false;
  if (typeof m.capabilities !== "object" || m.capabilities === null) return false;
  if (!Array.isArray(m.values)) return false;
  if (typeof m.preferences !== "object" || m.preferences === null) return false;
  if (typeof m.selfAssessment !== "object" || m.selfAssessment === null) return false;
  if (typeof m.narrative !== "object" || m.narrative === null) return false;

  return true;
}

// ───────────────────────────────────────────────────────────────
// SelfModelManager
// ───────────────────────────────────────────────────────────────

/**
 * SelfModelManager — hlavní správce dynamického modelu identity PEPAGI.
 *
 * Odpovídá za:
 * - inicializaci a persistenci SelfModel
 * - dynamické aktualizace capabilities a preferences
 * - záznam dokončených úkolů
 * - integraci NarrativeUpdater a IdentityAnchor
 *
 * @example
 * ```typescript
 * const manager = new SelfModelManager();
 * await manager.initialize();
 * await manager.updateCapability("code_generation", 0.95);
 * await manager.recordTaskCompletion("Build REST API", true);
 * await manager.persist();
 * ```
 */
export class SelfModelManager {
  private model!: SelfModel;
  private anchor!: IdentityAnchor;
  private narrativeUpdater!: NarrativeUpdater;
  private recentTasks: TaskRecord[] = [];
  private initialized = false;

  /**
   * Inicializuje SelfModelManager.
   * Načte existující model z disku, nebo vytvoří nový s default hodnotami.
   * Ověří integritu core values pomocí IdentityAnchor.
   */
  async initialize(): Promise<void> {
    await ensureDir(IDENTITY_DIR);

    // OPUS: loadFromDisk() throws SelfModelValidationError on corrupt JSON,
    // which would crash the entire boot sequence. Catch and fall back to defaults.
    if (existsSync(SELF_MODEL_PATH)) {
      try {
        await this.loadFromDisk();
      } catch (err) {
        console.error(`[SelfModelManager] Failed to load self-model.json, using defaults: ${err}`);
        this.createDefault();
      }
    } else {
      this.createDefault();
    }

    // Inicializuj IdentityAnchor
    this.anchor = new IdentityAnchor(this.model.values);

    // Ověř integritu oproti uloženému hashi
    const storedAnchorHash = await IdentityAnchor.load();
    if (storedAnchorHash) {
      try {
        this.anchor.verifyIntegrity(this.model.values, storedAnchorHash);
      } catch (err) {
        if (err instanceof IdentityManipulationError) {
          // Log locally — do not rethrow, but do not silently swallow either.
          console.error(`[SelfModelManager] ⚠️  ${err.message}`);
          // SEC-16 fix: emit a security:blocked event so audit infrastructure is
          // notified; previously the violation was only written to console.error.
          eventBus.emit({ type: "security:blocked", taskId: "self-model", reason: err.message });
        }
      }
    }

    // Aktualizuj anchor hash v modelu
    this.model.anchorHash = this.anchor.getAnchorHash();

    // Ulož anchor
    await this.anchor.persist();

    // Inicializuj NarrativeUpdater
    this.narrativeUpdater = new NarrativeUpdater(this.model);

    this.initialized = true;
  }

  // ─── Private: načtení z disku ──────────────────────────────

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(SELF_MODEL_PATH, "utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SelfModelValidationError("self-model.json contains invalid JSON.");
    }

    if (!validateSelfModel(parsed)) {
      throw new SelfModelValidationError(
        "self-model.json has invalid or incomplete structure.",
      );
    }

    // Zajisti kompatibilitu — přidej chybějící pole
    const loaded = parsed as SelfModel;
    if (!loaded.narrative.tasksSinceLastNarrativeUpdate) {
      loaded.narrative.tasksSinceLastNarrativeUpdate = 0;
    }

    this.model = loaded;
  }

  // ─── Private: vytvoření defaultního modelu ─────────────────

  private createDefault(): void {
    const now = new Date().toISOString();

    this.model = {
      identity: {
        id: generateId(),
        name: "PEPAGI",
        version: PEPAGI_VERSION,
        created: now,
        description:
          "PEPAGI — autonomní multi-agent systém s důrazem na " +
          "přesnost, transparentnost, bezpečnost a opravitelnost.",
      },
      capabilities: { ...DEFAULT_CAPABILITIES },
      values: CORE_VALUES,
      preferences: {
        language: "cs",
        verbosity: "medium",
        logLevel: "info",
        theme: "dark",
      },
      selfAssessment: {
        overallConfidence: 0.75,
        strengths: [
          "Logické uvažování a strukturované řešení problémů",
          "Generování kódu ve více jazycích",
          "Plánování komplexních úkolů",
        ],
        weaknesses: [
          "Omezená paměť bez explicitního memory systému",
          "Závislost na kvalitě vstupních dat",
          "Kalibrace sebedůvěry vyžaduje zkušenosti",
        ],
        lastUpdated: now,
      },
      narrative: {
        summary:
          "PEPAGI — nově inicializovaný systém. Bez předchozí historie. " +
          "Core values: accuracy, transparency, user_safety, corrigibility.",
        keyMilestones: [`Systém inicializován: ${now}`],
        lastUpdated: now,
        taskCount: 0,
        tasksSinceLastNarrativeUpdate: 0,
      },
      anchorHash: "", // Doplní se po init IdentityAnchor
    };
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Dynamicky aktualizuje záznam schopnosti.
   * Pokud schopnost neexistuje, vytvoří ji.
   *
   * @param name - klíč schopnosti (snake_case)
   * @param successRate - úspěšnost posledního použití (0–1)
   */
  async updateCapability(name: string, successRate: number): Promise<void> {
    this.assertInitialized();

    const clampedRate = Math.max(0, Math.min(1, successRate));
    const now = new Date().toISOString();

    if (this.model.capabilities[name]) {
      const cap = this.model.capabilities[name];
      const newUseCount = cap.useCount + 1;
      // Exponenciální klouzavý průměr
      const alpha = 0.3;
      const newSuccessRate =
        cap.successRate * (1 - alpha) + clampedRate * alpha;
      // Úroveň = průměr success rate a aktuální level
      const newLevel = cap.level * 0.7 + clampedRate * 0.3;

      this.model.capabilities[name] = {
        ...cap,
        successRate: Math.round(newSuccessRate * 1000) / 1000,
        level: Math.round(newLevel * 1000) / 1000,
        lastUsed: now,
        useCount: newUseCount,
      };
    } else {
      // Nová schopnost
      this.model.capabilities[name] = {
        name,
        level: clampedRate,
        lastUsed: now,
        successRate: clampedRate,
        useCount: 1,
      };
    }
  }

  /**
   * Aktualizuje hodnotu preference.
   *
   * @param key - klíč preference
   * @param value - nová hodnota
   */
  async updatePreference(key: string, value: unknown): Promise<void> {
    this.assertInitialized();
    this.model.preferences[key] = value;
  }

  /**
   * Zaznamená dokončený úkol.
   * Inkrementuje taskCount, volitelně spustí NarrativeUpdater.
   *
   * @param taskTitle - název úkolu
   * @param success - zda byl úkol úspěšný
   */
  async recordTaskCompletion(taskTitle: string, success: boolean): Promise<void> {
    this.assertInitialized();

    const record: TaskRecord = {
      title: taskTitle,
      success,
      timestamp: new Date().toISOString(),
    };

    this.recentTasks.push(record);

    // Udržuj jen posledních 50 záznamů v paměti
    if (this.recentTasks.length > 50) {
      this.recentTasks = this.recentTasks.slice(-50);
    }

    // Inkrementuj počítadla
    this.model.narrative.taskCount += 1;
    this.model.narrative.tasksSinceLastNarrativeUpdate += 1;

    // Aktualizuj selfAssessment na základě výsledku
    this.updateSelfAssessment(success);

    // Zkontroluj, zda je čas na aktualizaci narativu
    if (this.narrativeUpdater.needsUpdate()) {
      await this.narrativeUpdater.update(this.recentTasks);
    }
  }

  /**
   * Vrátí kopii aktuálního SelfModel.
   */
  getSelfModel(): SelfModel {
    this.assertInitialized();
    return JSON.parse(JSON.stringify(this.model)) as SelfModel;
  }

  /**
   * Persistuje model do ~/.pepagi/identity/self-model.json.
   * Používá atomický zápis (temp + rename).
   */
  async persist(): Promise<void> {
    this.assertInitialized();
    await ensureDir(IDENTITY_DIR);
    const content = JSON.stringify(this.model, null, 2);
    await atomicWrite(SELF_MODEL_PATH, content);
  }

  /**
   * Generates a short self-description for injection into the mediator prompt.
   */
  getSelfDescription(): string {
    this.assertInitialized();
    const m = this.model;
    const topCaps = Object.values(m.capabilities)
      .sort((a, b) => b.level - a.level)
      .slice(0, 3)
      .map(c => c.name)
      .join(", ");
    const conf = Math.round(m.selfAssessment.overallConfidence * 100);
    return (
      `[${m.identity.name} v${m.identity.version} | ` +
      `Úkoly: ${m.narrative.taskCount} | ` +
      `Sebedůvěra: ${conf}% | ` +
      `Schopnosti: ${topCaps}]`
    );
  }

  /**
   * Ověří integritu core values.
   * @throws {IdentityManipulationError} při detekci manipulace
   */
  verifyIntegrity(): void {
    this.assertInitialized();
    this.anchor.verifyIntegrity(this.model.values, this.model.anchorHash);
  }

  /**
   * Vrátí aktuální anchor hash.
   */
  getAnchorHash(): string {
    this.assertInitialized();
    return this.anchor.getAnchorHash();
  }

  // ─── Private helpers ───────────────────────────────────────

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "[SelfModelManager] Not initialized. Call initialize() first.",
      );
    }
  }

  /**
   * Průběžně aktualizuje selfAssessment.overallConfidence
   * na základě výsledků posledních úkolů.
   */
  private updateSelfAssessment(lastSuccess: boolean): void {
    const alpha = 0.1;
    const current = this.model.selfAssessment.overallConfidence;
    const target = lastSuccess ? 1.0 : 0.0;
    const updated = current * (1 - alpha) + target * alpha;
    this.model.selfAssessment.overallConfidence =
      Math.round(updated * 1000) / 1000;
    this.model.selfAssessment.lastUpdated = new Date().toISOString();
  }
}

// ───────────────────────────────────────────────────────────────
// Singleton / Factory
// ───────────────────────────────────────────────────────────────

/**
 * Vytvoří a inicializuje novou instanci SelfModelManager.
 * Vhodné pro lazy initialization v jiných modulech.
 *
 * @example
 * ```typescript
 * const manager = await createSelfModelManager();
 * const model = manager.getSelfModel();
 * ```
 */
export async function createSelfModelManager(): Promise<SelfModelManager> {
  const manager = new SelfModelManager();
  await manager.initialize();
  return manager;
}

// Default export — factory funkce
export default createSelfModelManager;
