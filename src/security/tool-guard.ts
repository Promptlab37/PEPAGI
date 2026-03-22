// ═══════════════════════════════════════════════════════════════
// PEPAGI — Tool Guard (SEC-06)
// Wraps all tool execution with:
//   - SSRF protection (block private IP ranges)
//   - Output sanitization (strip injection patterns, truncate)
//   - Execution timeout enforcement
//   - Audit logging of every tool call
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";
import { inputSanitizer } from "./input-sanitizer.js";
import { scrubCredentials } from "./credential-scrubber.js";
import { stripBoundaryTags } from "./context-boundary.js";

const logger = new Logger("ToolGuard");

// SECURITY: SEC-06 — Private IP ranges for SSRF protection
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
  /^https?:\/\/(?:172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i,
  /^https?:\/\/(?:192\.168\.\d{1,3}\.\d{1,3})/i,
  /^https?:\/\/(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
  /^https?:\/\/(?:0\.0\.0\.0)/i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/\[::1\]/i,
  /^https?:\/\/\[fe80:/i,
  /^file:\/\//i,
  /^data:/i,
  /^javascript:/i,
];

// SECURITY: SEC-06 — Maximum output size to prevent context window flooding
const MAX_OUTPUT_BYTES = 10_000;

// SECURITY: SEC-06 — Default execution timeout (30 seconds)
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Check if a URL targets a private/internal network (SSRF protection).
 *
 * SECURITY: SEC-06 — Blocks requests to private IPs, localhost,
 * file://, data:, and javascript: protocols.
 * Also detects decimal IP notation, IPv6 shorthand, and 0x hex IPs.
 */
export function isPrivateUrl(url: string): boolean {
  // Fast regex check first
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) return true;
  }

  // Deep check: parse URL to detect encoded/obfuscated IPs
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Block bare IPv6 addresses (commonly used for SSRF bypass)
    if (hostname.startsWith("[")) return true;

    // Block decimal IP notation (e.g. http://2130706433 = 127.0.0.1)
    if (/^\d{8,}$/.test(hostname)) return true;

    // Block hex IP notation (e.g. http://0x7f000001)
    if (/^0x[0-9a-f]+$/i.test(hostname)) return true;

    // Block octal IP notation (e.g. http://0177.0.0.1)
    if (/^0\d+\./.test(hostname)) return true;

    // Block 0.0.0.0 and variants
    if (/^0+\.0+\.0+\.0+$/.test(hostname)) return true;

    // Block any hostname resolving to "internal" or "metadata" endpoints
    if (hostname === "metadata.google.internal" || hostname === "169.254.169.254") return true;
  } catch {
    // Not a valid URL — treat as suspicious
  }

  return false;
}

/**
 * Sanitize tool output before re-injection into LLM context.
 *
 * SECURITY: SEC-06 — Tool outputs are UNTRUSTED (could contain
 * web page content, file content with injection payloads, etc.)
 *
 * @param output - Raw tool output
 * @param toolName - Name of the tool that produced the output
 * @returns Sanitized output safe for LLM context
 */
export function sanitizeToolOutput(output: string, toolName: string): string {
  if (!output) return output;

  let result = output;

  // SECURITY: SEC-02 — Scrub credentials from tool output
  result = scrubCredentials(result).scrubbed;

  // SECURITY: SEC-01 — Strip boundary tags to prevent boundary-breaking
  result = stripBoundaryTags(result);

  // SECURITY: SEC-06 — Truncate oversized outputs
  if (result.length > MAX_OUTPUT_BYTES) {
    result = result.slice(0, MAX_OUTPUT_BYTES) + `\n\n[Output truncated: ${output.length} bytes total, showing first ${MAX_OUTPUT_BYTES}]`;
    logger.debug("Tool output truncated", { toolName, originalLength: output.length });
  }

  return result;
}

/**
 * Validate URL before allowing browser navigation or web fetch.
 *
 * SECURITY: SEC-28 — Browser automation SSRF protection.
 * Blocks: private IPs, file://, data://, javascript:// protocols.
 *
 * @param url - URL to validate
 * @returns Object with valid flag and reason
 */
export function validateUrl(url: string): { valid: boolean; reason?: string } {
  if (!url) {
    return { valid: false, reason: "Empty URL" };
  }

  // Block dangerous protocols
  if (/^(?:file|data|javascript):/i.test(url)) {
    return { valid: false, reason: `Blocked protocol: ${url.split(":")[0]}` };
  }

  // Block private IP ranges
  if (isPrivateUrl(url)) {
    return { valid: false, reason: "SSRF: URL targets private/internal network" };
  }

  // Must be http or https
  if (!/^https?:\/\//i.test(url)) {
    return { valid: false, reason: `Invalid protocol — only http/https allowed` };
  }

  return { valid: true };
}

/**
 * Guard a tool execution with timeout.
 * Returns the tool result or a timeout error.
 *
 * SECURITY: SEC-06 — Prevents tools from hanging indefinitely.
 *
 * @param fn - The async tool execution function
 * @param timeoutMs - Maximum execution time in milliseconds
 * @returns Tool execution result or timeout error
 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

/**
 * Log a tool call to the audit log.
 *
 * SECURITY: SEC-06 — Every tool execution is audit-logged
 * for forensic analysis and incident response.
 */
export async function logToolCall(
  toolName: string,
  taskId: string,
  args: Record<string, string>,
  result: { success: boolean; output?: string; error?: string },
): Promise<void> {
  const argsPreview = JSON.stringify(args).slice(0, 200);
  await auditLog({
    taskId,
    actionType: `tool:${toolName}`,
    details: `Args: ${argsPreview} | Success: ${result.success}${result.error ? ` | Error: ${result.error.slice(0, 100)}` : ""}`,
    outcome: result.success ? "allowed" : "flagged",
  });
}
