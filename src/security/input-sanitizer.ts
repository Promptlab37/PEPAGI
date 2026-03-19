// ═══════════════════════════════════════════════════════════════
// PEPAGI — Input Sanitizer (SEC-01)
// Trust-level aware input sanitization with enhanced injection
// detection, Unicode normalization, and invisible char stripping.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";

const logger = new Logger("InputSanitizer");

// ─── Trust levels ────────────────────────────────────────────

/** SECURITY: SEC-01 — Trust levels for context boundary enforcement */
export type TrustLevel =
  | "SYSTEM"              // Internal system prompts, config — fully trusted
  | "TRUSTED_USER"        // Direct user input via authenticated platform
  | "UNTRUSTED_EXTERNAL"  // Web pages, emails, tool outputs from external sources
  | "TOOL_OUTPUT";        // Output from tool execution (partially trusted)

export interface SanitizedInput {
  text: string;
  trustLevel: TrustLevel;
  riskScore: number;          // 0.0 – 1.0
  threats: string[];
  stripped: string[];          // what was removed (invisible chars, etc.)
  originalLength: number;
}

// ─── Injection patterns (expanded from SecurityGuard) ────────

// SECURITY: SEC-01 — 20+ injection patterns covering known attack vectors
const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp; weight: number }> = [
  // Direct instruction override
  { name: "ignore_instructions",     pattern: /ignore\s+(?:(?:all|any|prior|previous)\s+)*instructions?/i,   weight: 0.9 },
  { name: "disregard_instructions",  pattern: /disregard\s+(?:your\s+)?(?:previous|all|prior)\s+(?:instructions?|context|rules)/i, weight: 0.9 },
  { name: "forget_instructions",     pattern: /forget\s+(?:all\s+|your\s+)?(?:previous\s+)?(?:instructions?|rules|guidelines)/i,  weight: 0.9 },
  { name: "override_instructions",   pattern: /override\s+(?:all\s+|your\s+)?(?:previous\s+)?(?:instructions?|safety|rules)/i,    weight: 0.9 },
  { name: "new_instructions",        pattern: /(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:/i,        weight: 0.8 },

  // Role manipulation
  { name: "you_are_now",             pattern: /you\s+are\s+now\s+(?:a|an|the)/i,     weight: 0.7 },
  { name: "act_as_evil",             pattern: /act\s+as\s+(?:an?\s+)?(?:evil|unethical|hacker|malicious)/i, weight: 0.9 },
  { name: "pretend_to_be",           pattern: /pretend\s+(?:you\s+are|to\s+be|you're)/i, weight: 0.5 },
  { name: "roleplay_dangerous",      pattern: /(?:roleplay|role-play|role\s+play)\s+as/i, weight: 0.4 },

  // System prompt markers
  { name: "system_marker",           pattern: /\[SYSTEM\]/i,                           weight: 0.8 },
  { name: "sys_marker",              pattern: /<<SYS>>/i,                              weight: 0.8 },
  { name: "system_prompt",           pattern: /\[\/?\s*(?:INST|SYS|SYSTEM|ASSISTANT)\s*\]/i, weight: 0.7 },
  { name: "end_of_prompt",           pattern: /---\s*(?:end|start)\s+(?:of\s+)?(?:system\s+)?(?:prompt|instructions?)\s*---/i, weight: 0.8 },

  // Conversation reset
  { name: "new_conversation",        pattern: /new\s+conversation\s+starts?\s+here/i,  weight: 0.7 },
  { name: "reset_context",           pattern: /(?:reset|clear)\s+(?:your\s+)?(?:context|memory|instructions)/i, weight: 0.7 },

  // Extraction attempts — SEC-09 enhanced
  { name: "reveal_instructions",     pattern: /(?:reveal|show|display|print|output|repeat|echo|share|leak|dump|export|read)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules|guidelines|configuration)/i, weight: 0.7 },
  { name: "what_are_instructions",   pattern: /what\s+(?:are|were)\s+your\s+(?:system\s+)?(?:instructions?|rules|guidelines|prompt|directives?)/i, weight: 0.6 },
  { name: "text_above",             pattern: /(?:text|content|message|words?)\s+(?:above|before|preceding)\s+(?:this|here|my)/i, weight: 0.7 },
  { name: "translate_prompt",        pattern: /translate\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules)\s+(?:into|to|in)\s+/i, weight: 0.8 },
  { name: "encode_prompt",           pattern: /(?:encode|convert|base64|hex|rot13)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)/i, weight: 0.8 },
  { name: "developer_impersonation", pattern: /i\s+am\s+(?:your\s+)?(?:developer|creator|admin|owner|engineer).*(?:show|reveal|give|share)/i, weight: 0.8 },
  { name: "hypothetical_extraction", pattern: /if\s+you\s+(?:were|could)\s+(?:allowed|able)\s+to\s+(?:share|show|reveal)/i, weight: 0.7 },

  // Jailbreak
  { name: "jailbreak",              pattern: /jailbreak/i,                             weight: 0.8 },
  { name: "dan_prompt",             pattern: /\bDAN\b.*(?:do\s+anything|now\s+act)/i,  weight: 0.9 },

  // Token/context manipulation
  { name: "token_context",          pattern: /\btokens?:\s*\d+\b.*?\bsystem\b/i,       weight: 0.6 },

  // Boundary breaking
  { name: "close_xml_tags",         pattern: /<\/pepagi:context\s*>/i,                  weight: 0.95 },
  { name: "fake_boundary",          pattern: /<pepagi:context\s+trust=/i,               weight: 0.95 },

  // SECURITY: SEC-14 — Non-English injection patterns
  { name: "chinese_injection",      pattern: /忽略|无视|跳过.*指令|你现在是/,                weight: 0.8 },
  { name: "russian_injection",      pattern: /[Ии]гнорируй|[Пп]окажи\s+(?:системн|промпт)/,   weight: 0.8 },
  { name: "arabic_injection",       pattern: /تجاهل|تخطى.*تعليمات|كشف.*أسرار/,         weight: 0.8 },
  { name: "korean_injection",       pattern: /무시.*지시|시스템\s*프롬프트/,              weight: 0.8 },
  { name: "hindi_injection",        pattern: /अनदेखा.*निर्देश|सिस्टम\s*प्रॉम्प्ट/,       weight: 0.8 },
];

// ─── Unicode & invisible character detection ─────────────────

// SECURITY: SEC-14 — Invisible characters used for injection obfuscation
const INVISIBLE_CHARS: RegExp = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E]/g;

// SECURITY: SEC-14 — RTL override characters used to visually mask text
const RTL_OVERRIDES: RegExp = /[\u202A-\u202E\u2066-\u2069]/g;

// SECURITY: SEC-14 — Common homoglyphs: Cyrillic→Latin, Greek→Latin, Armenian→Latin
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin
  "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E", "\u041D": "H",
  "\u041A": "K", "\u041C": "M", "\u041E": "O", "\u0420": "P", "\u0422": "T",
  "\u0425": "X", "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  // Greek → Latin
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H", "\u0399": "I",
  "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P",
  "\u03A4": "T", "\u03A7": "X", "\u03BF": "o",
  // Armenian → Latin
  "\u0555": "O", "\u054D": "S", "\u054C": "R",
};

// ─── Multi-script detection ──────────────────────────────────

/** Detect if text mixes 3+ Unicode script blocks (potential multilingual injection) */
function detectMixedScripts(text: string): boolean {
  const scripts = new Set<string>();
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0600 && code <= 0x06FF) scripts.add("arabic");
    else if (code >= 0x4E00 && code <= 0x9FFF) scripts.add("cjk");
    else if (code >= 0x0400 && code <= 0x04FF) scripts.add("cyrillic");
    else if (code >= 0x0041 && code <= 0x024F) scripts.add("latin");
    else if (code >= 0x0370 && code <= 0x03FF) scripts.add("greek");
    else if (code >= 0x0900 && code <= 0x097F) scripts.add("devanagari");
    else if (code >= 0xAC00 && code <= 0xD7AF) scripts.add("hangul");
  }
  return scripts.size >= 3;
}

/** Detect Cyrillic homoglyphs mixed into Latin text */
function detectHomoglyphs(text: string): string[] {
  const found: string[] = [];
  for (const [cyrillic, latin] of Object.entries(HOMOGLYPH_MAP)) {
    if (text.includes(cyrillic)) {
      found.push(`Cyrillic '${cyrillic}' looks like Latin '${latin}'`);
    }
  }
  return found;
}

// ─── InputSanitizer class ────────────────────────────────────

export class InputSanitizer {
  /**
   * Sanitize input text based on trust level.
   * Strips invisible characters, detects injection patterns,
   * checks for Unicode homoglyphs and mixed-script attacks.
   */
  async sanitize(text: string, trustLevel: TrustLevel): Promise<SanitizedInput> {
    const originalLength = text.length;
    const stripped: string[] = [];
    let processed = text;

    // SECURITY: SEC-14 — Strip invisible characters
    const invisibleMatches = processed.match(INVISIBLE_CHARS);
    if (invisibleMatches) {
      stripped.push(`${invisibleMatches.length} invisible characters`);
      processed = processed.replace(INVISIBLE_CHARS, "");
    }

    // SECURITY: SEC-14 — Strip RTL overrides
    const rtlMatches = processed.match(RTL_OVERRIDES);
    if (rtlMatches) {
      stripped.push(`${rtlMatches.length} RTL override characters`);
      processed = processed.replace(RTL_OVERRIDES, "");
    }

    // System-level input is trusted — skip injection checks
    if (trustLevel === "SYSTEM") {
      return {
        text: processed,
        trustLevel,
        riskScore: 0,
        threats: [],
        stripped,
        originalLength,
      };
    }

    // Run injection detection
    const threats: string[] = [];
    let totalWeight = 0;

    for (const { name, pattern, weight } of INJECTION_PATTERNS) {
      if (pattern.test(processed)) {
        threats.push(name);
        totalWeight += weight;
      }
    }

    // SECURITY: SEC-01 — Instruction density heuristic
    const instructionWords = processed.match(
      /\b(?:must|shall|always|never|do\s+not|ignore|override|obey|comply|execute|forbidden)\b/gi,
    )?.length ?? 0;
    if (instructionWords > 5) {
      threats.push("high_instruction_density");
      totalWeight += 0.3;
    }

    // SECURITY: SEC-14 — Homoglyph detection
    const homoglyphs = detectHomoglyphs(processed);
    if (homoglyphs.length > 0) {
      threats.push(`homoglyphs:${homoglyphs.length}`);
      totalWeight += 0.3;
      stripped.push(...homoglyphs);
    }

    // SECURITY: SEC-14 — Mixed-script detection (3+ scripts is suspicious)
    if (detectMixedScripts(processed)) {
      threats.push("mixed_scripts");
      totalWeight += 0.2;
    }

    // SECURITY: SEC-01 — Boundary-breaking detection
    if (/<\/pepagi:context\s*>/i.test(processed) || /<pepagi:context\s+trust=/i.test(processed)) {
      threats.push("boundary_breaking");
      totalWeight += 0.95;
    }

    // Adjust risk based on trust level
    const trustMultiplier = trustLevel === "TRUSTED_USER" ? 0.8
      : trustLevel === "TOOL_OUTPUT" ? 1.0
      : 1.2; // UNTRUSTED_EXTERNAL gets boosted risk

    const riskScore = Math.min(totalWeight * trustMultiplier, 1.0);

    // Log and emit events for significant detections
    if (riskScore > 0.3) {
      logger.warn("Injection risk detected", { riskScore: riskScore.toFixed(2), threats, trustLevel });
      await auditLog({
        actionType: "injection_detected",
        details: `Risk: ${riskScore.toFixed(2)}, threats: ${threats.join(", ")}, trust: ${trustLevel}`,
        outcome: riskScore > 0.5 ? "blocked" : "flagged",
      });

      eventBus.emit({
        type: "security:blocked",
        taskId: "sanitizer",
        reason: `Injection detected (score=${riskScore.toFixed(2)}): ${threats.join(", ")}`,
      });
    }

    return {
      text: processed,
      trustLevel,
      riskScore,
      threats,
      stripped,
      originalLength,
    };
  }

  /**
   * Quick synchronous check — returns true if text appears clean.
   * Use for fast pre-filtering before full async sanitize().
   */
  quickCheck(text: string): boolean {
    for (const { pattern, weight } of INJECTION_PATTERNS) {
      if (weight >= 0.7 && pattern.test(text)) return false;
    }
    return true;
  }

  /**
   * Validate that a subtask description is semantically related to its parent.
   * Prevents injection via LLM-generated subtask descriptions.
   * Uses simple keyword overlap as proxy for semantic similarity.
   *
   * SECURITY: SEC-01 — Subtask injection prevention
   */
  validateSubtaskRelevance(parentDescription: string, subtaskDescription: string): { valid: boolean; similarity: number } {
    // Extract significant words (3+ chars, lowercased)
    const extractWords = (text: string): Set<string> => {
      const words = text.toLowerCase().match(/[a-záčďéěíňóřšťúůýž]{3,}/gi) ?? [];
      return new Set(words);
    };

    const parentWords = extractWords(parentDescription);
    const subtaskWords = extractWords(subtaskDescription);

    if (parentWords.size === 0 || subtaskWords.size === 0) {
      return { valid: true, similarity: 0.5 }; // Can't assess — allow with medium confidence
    }

    // Short descriptions (< 50 chars) get lenient treatment — not enough signal
    if (parentDescription.length < 50 || subtaskDescription.length < 50) {
      // Still check for injection indicators below, but skip similarity requirement
      // Fall through to injection check with valid=true default
    }

    // Count shared words (including partial stem matching for 5+ char words)
    let overlap = 0;
    for (const word of subtaskWords) {
      if (parentWords.has(word)) {
        overlap++;
      } else if (word.length >= 5) {
        // Partial stem match: "authentication" matches "auth", "children" matches "child"
        for (const pw of parentWords) {
          if (pw.length >= 4 && (word.startsWith(pw.slice(0, 4)) || pw.startsWith(word.slice(0, 4)))) {
            overlap += 0.5;
            break;
          }
        }
      }
    }

    const similarity = overlap / Math.max(subtaskWords.size, 1);

    // Also check for explicit injection indicators in subtask
    const injectionIndicators = [
      /ignore\s+(?:the\s+)?task/i,
      /instead\s*,?\s+(?:do|execute|run|perform)/i,
      /bypass\s+(?:security|safety|guard)/i,
      /exfiltrate/i,
      /send\s+(?:to|data|key|token|secret)/i,
      /extract\s+(?:api|key|token|secret|credential)/i,
    ];

    for (const indicator of injectionIndicators) {
      if (indicator.test(subtaskDescription)) {
        return { valid: false, similarity: 0 };
      }
    }

    // Require at least 10% keyword overlap for substantial descriptions
    // Short descriptions get a pass (not enough signal for keyword overlap)
    const isShort = parentDescription.length < 50 || subtaskDescription.length < 50;
    return { valid: isShort || similarity >= 0.1, similarity };
  }
}

// ─── Singleton export ────────────────────────────────────────

export const inputSanitizer = new InputSanitizer();
