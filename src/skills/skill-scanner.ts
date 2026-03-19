// ═══════════════════════════════════════════════════════════════
// PEPAGI — SkillScanner
// Security scanner for dynamically loaded skill files.
// Scans source code before import to detect dangerous patterns.
// ═══════════════════════════════════════════════════════════════

// OPUS: stat was dynamically imported inside scanSkillFile() — moved to top-level
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { parseLLMJson } from "../core/parse-llm-json.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Logger } from "../core/logger.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
// API-01 fix: import LLMProvider type so deepScanWithLLM signature matches the real class
import type { LLMProvider } from "../agents/llm-provider.js";
// SEC-13 fix: import constant so model retirement is caught in one place
import { CHEAP_CLAUDE_MODEL } from "../agents/pricing.js";

const logger = new Logger("SkillScanner");

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";

export interface ScanFinding {
  pattern: string;
  description: string;
  risk: RiskLevel;
  line?: number;
}

export interface ScanResult {
  filePath: string;
  riskLevel: RiskLevel;
  findings: ScanFinding[];
  approved: boolean;
  scannedAt: string;
}

interface DangerPattern {
  regex: RegExp;
  description: string;
  risk: RiskLevel;
}

// Ordered from most to least severe
const DANGER_PATTERNS: DangerPattern[] = [
  // Critical — can destroy data or exfiltrate
  { regex: /child_process|exec\s*\(|execSync\s*\(|spawnSync\s*\(/,   description: "Přímé spouštění shell příkazů",               risk: "critical" },
  { regex: /rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot/,                 description: "Destruktivní shell příkazy",                   risk: "critical" },
  { regex: /process\.exit\s*\(/,                                       description: "Vynucené ukončení procesu",                    risk: "critical" },

  // High — network, filesystem writes outside allowed dirs
  { regex: /fetch\s*\(|axios\.|got\.|http\.request|https\.request/,  description: "Přímé síťové volání",                          risk: "high" },
  { regex: /writeFile|writeFileSync|appendFile|createWriteStream/,   description: "Zápis do souborů",                             risk: "high" },
  { regex: /unlink\s*\(|rmdir\s*\(|rm\s*\(/,                         description: "Mazání souborů",                               risk: "high" },
  { regex: /process\.env\b/,                                          description: "Přístup k env proměnným (možné API klíče)",    risk: "high" },

  // Medium — dynamic code execution, sensitive imports
  { regex: /eval\s*\(/,                                                description: "Použití eval()",                              risk: "critical" },
  { regex: /new\s+Function\s*\(/,                                      description: "Dynamická tvorba funkcí (new Function)",      risk: "critical" },
  { regex: /import\s*\(.*process|require\s*\(.*process/,             description: "Dynamický import citlivých modulů",            risk: "medium" },
  { regex: /Buffer\.from\s*\(.*base64/i,                              description: "Base64 dekódování (možný obfuskovaný kód)",   risk: "medium" },
  { regex: /crypto\.|createCipher|createDecipher/,                   description: "Kryptografické operace",                      risk: "medium" },

  // Low — unusual but not necessarily dangerous
  { regex: /setInterval\s*\(|setTimeout\s*\(/,                        description: "Časovač (může způsobit přetížení)",            risk: "low" },
  { regex: /global\s*\[|globalThis\s*\[/,                             description: "Přístup ke global scope",                     risk: "low" },
  { regex: /\/\/\s*@ts-nocheck|\/\/\s*@ts-ignore/,                   description: "Vypnuté TypeScript kontroly",                  risk: "low" },
];

// SECURITY: SEC-03 — Obfuscation detection patterns
// Detects attempts to bypass DANGER_PATTERNS via string manipulation
const OBFUSCATION_PATTERNS: DangerPattern[] = [
  // Bracket notation property access (e.g., obj["ev"+"al"]())
  { regex: /\[\s*["'`][a-zA-Z]+["'`]\s*\+\s*["'`][a-zA-Z]+["'`]\s*\]/,  description: "String concatenation in bracket notation (obfuscation)", risk: "high" },
  // Template literal interpolation for calls (e.g., `${something}`)
  { regex: /\[\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\]/,                          description: "Template literal in bracket notation (obfuscation)",    risk: "high" },
  // Reversed / encoded strings being decoded
  { regex: /\.split\s*\(\s*["'`]["'`]\s*\)\s*\.reverse\s*\(\s*\)/,        description: "String reverse (potential obfuscation)",                risk: "medium" },
  // atob / btoa for encoding
  { regex: /\batob\s*\(|\bbtoa\s*\(/,                                      description: "Base64 encode/decode via atob/btoa",                   risk: "medium" },
  // String.fromCharCode for dynamic string construction
  { regex: /String\.fromCharCode\s*\(/,                                     description: "Dynamic string construction via charCode",             risk: "high" },
  // Dynamic property access on process/require/import
  { regex: /(?:process|require|import)\s*\[\s*[^"'`\]]+\s*\]/,            description: "Dynamic property access on sensitive object",           risk: "high" },
  // Proxy or Reflect for interception
  { regex: /new\s+Proxy\s*\(|Reflect\.(?:apply|construct)\s*\(/,           description: "Proxy/Reflect usage (potential interception)",          risk: "medium" },
  // with() statement (scoping abuse)
  { regex: /\bwith\s*\(/,                                                   description: "with() statement (scope manipulation)",                risk: "high" },
];

/** Maximum allowed file size for a skill (100 KB) */
const MAX_SKILL_SIZE_BYTES = 100 * 1024;

/**
 * Scan a skill file for dangerous patterns before loading.
 * @param filePath - Absolute path to the skill file
 * @returns ScanResult with risk assessment
 */
export async function scanSkillFile(filePath: string): Promise<ScanResult> {
  const result: ScanResult = {
    filePath,
    riskLevel: "safe",
    findings: [],
    approved: false,
    scannedAt: new Date().toISOString(),
  };

  let source: string;
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_SKILL_SIZE_BYTES) {
      result.findings.push({
        pattern: "file_size",
        description: `Soubor je příliš velký (${Math.round(stats.size / 1024)} KB > 100 KB)`,
        risk: "high",
      });
      result.riskLevel = "high";
      result.approved = false;
      return result;
    }
    source = await readFile(filePath, "utf8");
  } catch (err) {
    result.findings.push({ pattern: "read_error", description: `Nelze přečíst soubor: ${err}`, risk: "critical" });
    result.riskLevel = "critical";
    return result;
  }

  const lines = source.split("\n");

  // SECURITY: SEC-03 — Scan for both standard danger patterns and obfuscation patterns
  for (const dp of [...DANGER_PATTERNS, ...OBFUSCATION_PATTERNS]) {
    for (let i = 0; i < lines.length; i++) {
      if (dp.regex.test(lines[i]!)) {
        result.findings.push({
          pattern: dp.regex.source.slice(0, 40),
          description: dp.description,
          risk: dp.risk,
          line: i + 1,
        });
        break; // one finding per pattern type
      }
    }
  }

  // Determine overall risk level (highest found)
  const RISK_ORDER: RiskLevel[] = ["safe", "low", "medium", "high", "critical"];
  let maxRisk: RiskLevel = "safe";
  for (const f of result.findings) {
    if (RISK_ORDER.indexOf(f.risk) > RISK_ORDER.indexOf(maxRisk)) {
      maxRisk = f.risk;
    }
  }
  result.riskLevel = maxRisk;

  // Approve only if risk ≤ medium (no network calls, no child_process, no eval)
  result.approved = RISK_ORDER.indexOf(maxRisk) <= RISK_ORDER.indexOf("medium");

  // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
  if (!result.approved) {
    logger.warn("Skill rejected by security scanner", {
      filePath,
      riskLevel: result.riskLevel,
      findings: result.findings.map(f => `${f.risk}: ${f.description} (line ${f.line})`),
    });
  } else if (result.findings.length > 0) {
    logger.info("Skill approved with warnings", { filePath, findings: result.findings.length });
  } else {
    logger.debug("Skill passed scan with no findings", { filePath });
  }

  return result;
}

// ─── Checksum / tamper detection ─────────────────────────────

const CHECKSUM_STORE = join(PEPAGI_DATA_DIR, "skills", "_checksums.json");

// SEC-11 fix: serialize all checksum store writes through a queue so concurrent
// calls to signSkill() cannot interleave their read→modify→write cycles and
// silently overwrite each other's updates.
let checksumWriteQueue: Promise<void> = Promise.resolve();

/** Compute SHA-256 checksum of skill source code */
export function computeSkillChecksum(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Record the approved checksum for a skill file.
 * Call after a skill passes the scan and is first loaded.
 * SEC-11 fix: the read AND write are performed inside a queued function so
 * concurrent calls cannot interleave and overwrite each other's updates.
 */
export async function signSkill(filePath: string): Promise<string> {
  // Read the source outside the queue — it only touches the skill file, not the store.
  const source = await readFile(filePath, "utf8");
  const checksum = computeSkillChecksum(source);

  // Chain onto the existing queue so writes are strictly serialized.
  const writeTask = checksumWriteQueue.then(async () => {
    let store: Record<string, string> = {};
    try {
      const raw = await readFile(CHECKSUM_STORE, "utf8");
      store = JSON.parse(raw) as Record<string, string>;
    } catch { /* first time — store is empty */ }

    store[filePath] = checksum;
    // AUD-03: atomic write — checksum store is security-relevant
    const tmp = `${CHECKSUM_STORE}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await rename(tmp, CHECKSUM_STORE);
  });

  // Update the module-level queue pointer so the next call waits for this one.
  checksumWriteQueue = writeTask.catch(() => { /* errors must not poison the queue */ });
  await writeTask;
  return checksum;
}

/**
 * Verify a skill file hasn't been tampered with since approval.
 * @returns `true` if checksum matches (or no record — first time)
 */
export async function verifySkillIntegrity(filePath: string): Promise<boolean> {
  let store: Record<string, string> = {};
  try {
    const raw = await readFile(CHECKSUM_STORE, "utf8");
    store = JSON.parse(raw) as Record<string, string>;
  } catch {
    return true; // no store yet — assume ok
  }

  const expected = store[filePath];
  if (!expected) return true; // never signed — first time

  const source = await readFile(filePath, "utf8");
  const actual = computeSkillChecksum(source);

  if (actual !== expected) {
    logger.warn("Skill integrity violation! File modified since approval", { filePath });
    return false;
  }
  return true;
}

// ─── LLM deep scan ───────────────────────────────────────────

export interface DeepScanResult {
  safe: boolean;
  issues: string[];
  summary: string;
}

/**
 * Optional LLM-based deep security analysis for medium-risk skills.
 * Sends skill source to a cheap LLM model for semantic analysis.
 * @param source - Skill source code (will be truncated to 4000 chars)
 * @param llm - LLMProvider instance
 */
export async function deepScanWithLLM(
  source: string,
  // API-01 fix: use the actual LLMProvider type instead of an ad-hoc inline interface
  llm: LLMProvider,
): Promise<DeepScanResult> {
  const truncated = source.slice(0, 4000);

  try {
    const resp = await llm.quickClaude(
      "You are a security analyst reviewing dynamically loaded JavaScript/TypeScript skill code for an AI agent system. " +
      "Identify any security issues: data exfiltration, prompt injection, privilege escalation, obfuscation, or harmful behavior. " +
      "Return ONLY JSON: { \"safe\": boolean, \"issues\": string[], \"summary\": string }",
      `Analyze this skill code:\n\`\`\`\n${truncated}\n\`\`\``,
      // SEC-13 fix: use CHEAP_CLAUDE_MODEL constant instead of hardcoded string
      CHEAP_CLAUDE_MODEL,
      true,
    );

    const parsed = parseLLMJson<{ safe?: boolean; issues?: string[]; summary?: string }>(resp.content);
    return {
      safe: parsed.safe ?? true,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "No issues found.",
    };
  } catch {
    return { safe: true, issues: [], summary: "Deep scan unavailable." };
  }
}
