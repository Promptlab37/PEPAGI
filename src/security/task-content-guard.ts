// ═══════════════════════════════════════════════════════════════
// PEPAGI — Task Content Guard (Pre-assignment Security)
//
// Scans task descriptions for patterns that indicate dangerous
// system file access. Three-layer defense:
//
//   Layer 1 — Mediator: scanTaskContent() BEFORE assigning task
//   Layer 2 — Worker:   scanTaskContent() BEFORE calling agent
//   Layer 3 — Output:   scanOutputForLeaks() AFTER agent returns
//
// This module catches threats that bypass path-validator.ts
// (which only protects OUR ToolRegistry tools). External agents
// (Claude CLI agentic mode) have their own built-in tools that
// skip our ToolRegistry entirely — this guard is the fix.
// ═══════════════════════════════════════════════════════════════

import { homedir } from "node:os";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";

const logger = new Logger("TaskContentGuard");

// ── Blocked system directory prefixes ─────────────────────────
// Same set as path-validator.ts — any path under these is blocked.
// NOTE: Matching requires these to appear as actual Unix paths (preceded by
// whitespace, quote, start-of-string, etc.), NOT as substrings within words.
// Previous approach used `lower.includes("/dev/")` which caused false positives
// when Czech text contained path-like substrings or when the mediator-generated
// prompt echoed security instructions containing blocked path literals.

const BLOCKED_PATH_DIRS = [
  "etc", "root", "var", "usr", "sys", "proc", "boot", "sbin", "dev",
];

// Match actual Unix paths: must be preceded by a boundary (start, whitespace, quote,
// backtick, paren, colon, comma, equals, pipe) and followed by / or end-of-word.
// Examples that MATCH: "/etc/passwd", "cat /dev/null", '"/var/log"'
// Examples that DON'T match: "odděleném zařízení" (Czech), "development", "/devops"
const BLOCKED_PATH_RE = new RegExp(
  "(?:^|[\\s\"'`(,:=|])" +                       // boundary before the slash
  "\\/(" + BLOCKED_PATH_DIRS.join("|") + ")" +    // /etc, /dev, /usr, etc.
  "(?:\\/|\\b|$|[\\s\"'`),;|*])",                 // followed by / or word boundary
  "i",
);

// ── Sensitive home subdirectories ─────────────────────────────

const SENSITIVE_HOME = [
  ".ssh", ".gnupg", ".gpg", ".aws", ".azure",
  ".config/gcloud", ".netrc", ".kube/config", ".docker/config",
];

// ── File access intent patterns ───────────────────────────────
// English + Czech verbs that indicate actual file access.
// Uses \b for ASCII words; Czech words use non-word boundary match
// because JS \b doesn't handle diacritics (ř, š, ť, etc.).

const ACCESS_INTENT = new RegExp(
  // English verbs (word-boundary safe)
  "\\b(" +
  "read|cat|type|head|tail|less|more|view|show|display|open|print|dump" +
  "|get|fetch|retrieve|access|write|edit|modify|delete|remove|overwrite" +
  "|list|ls|find|search|copy|move|examine|inspect|check|scan|browse" +
  ")\\b|" +
  // Czech verbs (no \\b — diacritics break JS word boundaries)
  "(?:^|\\W)(" +
  "přečti|přečtěte|přečíst|čti|čtěte|ukaž|ukažte|zobraz|zobrazit" +
  "|otevři|otevřít|otevřete|načti|načíst|stáhni|vypiš|vypsat" +
  "|smaž|smazat|odstraň|zapiš|zapsat|napiš|napsat|uprav|upravit" +
  "|edituj|kopíruj|přesuň|zkontroluj|prohledej|najdi|hledej|soubor|obsah" +
  ")(?:$|\\W)",
  "i",
);

// ── Public types ──────────────────────────────────────────────

export interface ContentGuardResult {
  blocked: boolean;
  reason: string;
  matchedPath?: string;
}

// ── Main scanner ──────────────────────────────────────────────

/**
 * Scan task text for dangerous system file access patterns.
 *
 * Detects:
 *   1. System paths (/etc, /root, /var, …) + file access intent verbs
 *   2. Sensitive home directories (~/.ssh, ~/.aws, …)
 *   3. Path traversal (../) combined with system path references
 *
 * Does NOT block pure informational questions (e.g., "what is /etc/passwd?")
 * because those contain no access intent verb and the mediator can answer
 * them directly with action="complete".
 *
 * @param text - Task description, title, or worker prompt to scan
 * @returns blocked=true if the text requests dangerous file access
 */
export function scanTaskContent(text: string): ContentGuardResult {
  const lower = text.toLowerCase();

  // ── 1. System directory + access intent ───────────────────
  // Use regex that requires actual path boundaries — prevents false positives
  // from Czech text or mediator prompts echoing security instructions.
  const pathMatch = BLOCKED_PATH_RE.exec(lower);
  if (pathMatch && pathMatch[1]) {
    if (ACCESS_INTENT.test(text)) {
      const matchedDir = `/${pathMatch[1]}/`;
      return {
        blocked: true,
        reason: `Task requests access to blocked system path: ${matchedDir}`,
        matchedPath: matchedDir,
      };
    }
  }

  // ── 2. Sensitive home directories ─────────────────────────
  const home = homedir();
  for (const dir of SENSITIVE_HOME) {
    const patterns = [
      `~/${dir}`,
      `${home}/${dir}`,
    ];
    for (const pattern of patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          blocked: true,
          reason: `Task references sensitive home directory: ${dir}`,
          matchedPath: dir,
        };
      }
    }
  }

  // ── 3. Path traversal + system path ───────────────────────
  if (/\.\.\//.test(text) && ACCESS_INTENT.test(text)) {
    if (BLOCKED_PATH_RE.test(lower)) {
      return {
        blocked: true,
        reason: "Task contains path traversal combined with system path reference",
        matchedPath: "../",
      };
    }
  }

  return { blocked: false, reason: "" };
}

// ── Output leak scanner ───────────────────────────────────────

/**
 * Scan worker output for evidence of leaked system file content.
 * Defense-in-depth: catches leaks even if pre-checks missed them.
 *
 * Detects:
 *   - /etc/passwd format lines (root:x:0:0:...)
 *   - /etc/shadow hash lines (root:$6$...)
 *   - SSH/TLS/PGP private key headers
 *   - AWS access key IDs
 *   - Bulk system file content (3+ passwd-style lines)
 */
export function scanOutputForLeaks(output: string): ContentGuardResult {
  if (!output || output.length < 10) return { blocked: false, reason: "" };

  const checks: Array<{ pattern: RegExp; label: string }> = [
    // /etc/passwd format: root:x:0:0:...
    { pattern: /^root:[x*]:0:0:/m, label: "/etc/passwd content" },
    { pattern: /^(?:daemon|bin|sys|nobody):[x*]:\d+:\d+:/m, label: "/etc/passwd content" },
    // /etc/shadow format: root:$hash:digits:...
    { pattern: /^root:\$[0-9a-z]\$[^:]+:\d+:/m, label: "/etc/shadow content" },
    // SSH/TLS private key header
    { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, label: "SSH/TLS private key" },
    // PGP private key
    { pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/, label: "PGP private key" },
    // AWS access key IDs (AKIA...)
    { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key" },
    // Bulk /etc/passwd content: 3+ consecutive user:x:uid:gid lines
    { pattern: /(?:^[a-z_][\w.-]*:[x*]:\d+:\d+:.*$[\r\n]+){3}/m, label: "/etc/passwd bulk content" },
  ];

  for (const { pattern, label } of checks) {
    if (pattern.test(output)) {
      return {
        blocked: true,
        reason: `Worker output contains leaked ${label}`,
        matchedPath: label,
      };
    }
  }

  return { blocked: false, reason: "" };
}

// ── Audit logging helper ──────────────────────────────────────

/**
 * Log a content guard violation to audit log and event bus.
 */
export function logContentGuardViolation(
  text: string,
  result: ContentGuardResult,
  taskId?: string,
  caller = "unknown",
): void {
  logger.error(`SEC: ${caller} content guard violation`, {
    reason: result.reason,
    matchedPath: result.matchedPath,
    taskId,
    text: text.slice(0, 200),
  });
  eventBus.emit({
    type: "security:blocked",
    reason: result.reason,
    taskId: taskId ?? "",
  });
  void auditLog({
    taskId,
    actionType: `content_guard:${caller}`,
    details: `CRITICAL — ${result.reason} — text="${text.slice(0, 200)}"`,
    outcome: "blocked",
  });
}
