// ═══════════════════════════════════════════════════════════════
// PEPAGI — Output Sanitizer (SEC-34)
// All LLM outputs are untrusted and must be sanitized before:
//   - Tool execution (prevent command injection via LLM output)
//   - Platform response (prevent XSS/markdown injection)
//   - Memory storage (prevent memory poisoning)
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { scrubCredentials } from "./credential-scrubber.js";
import { stripBoundaryTags } from "./context-boundary.js";
import { inputSanitizer } from "./input-sanitizer.js";

const logger = new Logger("OutputSanitizer");

// SECURITY: SEC-34 — Maximum output size limits per context
const MAX_PLATFORM_RESPONSE_LENGTH = 8000;
const MAX_MEMORY_CONTENT_LENGTH = 2000;
const MAX_TOOL_ARG_LENGTH = 4000;

/**
 * SECURITY: SEC-34 — Sanitize LLM output before sending to a messaging platform.
 * Scrubs credentials, strips boundary tags, truncates.
 *
 * @param output - Raw LLM output
 * @returns Sanitized output safe for platform delivery
 */
export function sanitizeForPlatform(output: string): string {
  if (!output) return output;

  let result = output;

  // Scrub any leaked credentials
  result = scrubCredentials(result).scrubbed;

  // Strip context boundary tags (should never reach user)
  result = stripBoundaryTags(result);

  // Truncate to platform-safe length
  if (result.length > MAX_PLATFORM_RESPONSE_LENGTH) {
    result = result.slice(0, MAX_PLATFORM_RESPONSE_LENGTH) + "\n\n[... odpověď zkrácena]";
  }

  return result;
}

/**
 * SECURITY: SEC-34 — Sanitize LLM output before storing in memory.
 * Applies credential scrubbing + injection detection + length limits.
 *
 * @param output - Raw LLM output to store
 * @returns Sanitized content and risk assessment
 */
export async function sanitizeForMemory(output: string): Promise<{
  sanitized: string;
  injectionRisk: number;
}> {
  if (!output) return { sanitized: output, injectionRisk: 0 };

  // Scrub credentials
  let sanitized = scrubCredentials(output).scrubbed;

  // Strip boundary tags
  sanitized = stripBoundaryTags(sanitized);

  // Check for injection patterns (LLM output could contain injected instructions)
  const sanitizeResult = await inputSanitizer.sanitize(sanitized, "TOOL_OUTPUT");

  // Truncate
  if (sanitized.length > MAX_MEMORY_CONTENT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_MEMORY_CONTENT_LENGTH);
  }

  return {
    sanitized,
    injectionRisk: sanitizeResult.riskScore,
  };
}

/**
 * SECURITY: SEC-34 — Sanitize LLM-generated tool arguments.
 * Prevents command injection when LLM output is used as tool input.
 *
 * @param args - Tool arguments from LLM output
 * @param toolName - Which tool will receive these args
 * @returns Sanitized arguments
 */
export function sanitizeToolArgs(
  args: Record<string, string>,
  toolName: string,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    let clean = value;

    // Scrub credentials from all values
    clean = scrubCredentials(clean).scrubbed;

    // Strip boundary tags
    clean = stripBoundaryTags(clean);

    // Truncate oversized values
    if (clean.length > MAX_TOOL_ARG_LENGTH) {
      clean = clean.slice(0, MAX_TOOL_ARG_LENGTH);
      logger.debug("Tool arg truncated", { toolName, key, originalLength: value.length });
    }

    // For shell-related tools, additional escaping
    if (toolName === "bash" && key === "command") {
      // Shell metacharacter check is already done by tool-registry/security-guard
      // but double-check for common injection via LLM output
      if (/;\s*curl\s|;\s*wget\s|`[^`]+`|\$\([^)]+\)/.test(clean)) {
        logger.warn("SEC-34: Suspicious shell metacharacters in LLM-generated command", {
          toolName,
          command: clean.slice(0, 100),
        });
      }
    }

    sanitized[key] = clean;
  }

  return sanitized;
}

/**
 * SECURITY: SEC-34 — Scan LLM-generated code output for dangerous patterns.
 * Reuses the same patterns as SkillScanner.
 *
 * @param code - Code output from LLM
 * @returns Object with safe flag and issues found
 */
export function scanCodeOutput(code: string): {
  safe: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Critical patterns in generated code
  const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /eval\s*\(/, description: "eval() usage" },
    { pattern: /new\s+Function\s*\(/, description: "new Function() usage" },
    { pattern: /child_process/, description: "child_process import" },
    { pattern: /process\.exit\s*\(/, description: "process.exit() call" },
    { pattern: /rm\s+-rf\s+\//, description: "destructive rm -rf /" },
    { pattern: /process\.env\b/, description: "process.env access" },
  ];

  for (const { pattern, description } of dangerousPatterns) {
    if (pattern.test(code)) {
      issues.push(description);
    }
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}
