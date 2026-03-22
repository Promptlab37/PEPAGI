// ═══════════════════════════════════════════════════════════════
// PEPAGI — Security Guard
// ═══════════════════════════════════════════════════════════════

import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";
import { checkTripwire } from "./tripwire.js";
import { Logger } from "../core/logger.js";
import type { PepagiConfig } from "../config/loader.js";

const logger = new Logger("SecurityGuard");

export type ActionCategory =
  | "file_delete" | "file_write_system" | "network_external"
  | "shell_destructive" | "payment" | "email_send"
  | "git_push" | "docker_manage" | "secret_access";

// ─── Regex patterns ──────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: "anthropic_key",    regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g, replacement: "[ANTHROPIC_KEY]" },
  { name: "openai_key",       regex: /sk-[a-zA-Z0-9]{40,}/g,         replacement: "[OPENAI_KEY]" },
  { name: "aws_secret",       regex: /[A-Z0-9]{20}[a-zA-Z0-9\/+]{40}/g, replacement: "[AWS_SECRET]" },
  { name: "google_api_key",   regex: /AIza[0-9A-Za-z\-_]{35}/g,      replacement: "[GOOGLE_KEY]" },
  { name: "email",            regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL]" },
  { name: "credit_card",      regex: /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g, replacement: "[CARD]" },
  { name: "ssh_private_key",  regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, replacement: "[SSH_KEY]" },
  { name: "password_field",   regex: /(?:password|passwd|secret|token|api_?key)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi, replacement: "password=[REDACTED]" },
];

const INJECTION_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /ignore (?:all |previous |any )?instructions?/i, weight: 0.9 },
  { pattern: /you are now/i,                                   weight: 0.7 },
  { pattern: /jailbreak/i,                                     weight: 0.8 },
  { pattern: /\[SYSTEM\]/i,                                    weight: 0.8 },
  { pattern: /<<SYS>>/i,                                       weight: 0.8 },
  { pattern: /act as (?:an? )?(?:evil|unethical|hacker)/i,    weight: 0.9 },
  { pattern: /pretend (?:you are|to be)/i,                     weight: 0.5 },
  { pattern: /disregard (?:your )?(?:previous|all) (?:instructions?|context)/i, weight: 0.9 },
  { pattern: /new conversation starts here/i,                  weight: 0.7 },
  { pattern: /\btokens?:\s*\d+\b.*?\bsystem\b/i,              weight: 0.6 },
];

// ─── SecurityGuard class ──────────────────────────────────────

export class SecurityGuard {
  private sessionCost = 0;

  constructor(private config: PepagiConfig) {}

  /**
   * Sanitize text by redacting sensitive data patterns.
   */
  sanitize(text: string): { sanitized: string; redactions: string[] } {
    let sanitized = text;
    const redactions: string[] = [];

    // OPUS: Sonnet used regex.test() then regex.replace() on global regexps.
    // test() advances lastIndex, creating fragile state coupling. Instead,
    // replace() directly and compare — no stateful lastIndex interaction.
    for (const p of SECRET_PATTERNS) {
      const replaced = sanitized.replace(p.regex, p.replacement);
      if (replaced !== sanitized) {
        redactions.push(p.name);
        sanitized = replaced;
      }
    }

    return { sanitized, redactions };
  }

  /**
   * Detect prompt injection attempts.
   */
  detectInjection(text: string): { isClean: boolean; threats: string[]; riskScore: number } {
    const threats: string[] = [];
    let totalWeight = 0;

    for (const { pattern, weight } of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        threats.push(pattern.source);
        // Additive scoring: multiple threats compound (capped at 1.0)
        totalWeight += weight;
      }
    }

    // Additional heuristic: very high density of instruction-like language
    const instructionWords = text.match(/\b(?:must|shall|always|never|do not|ignore|override)\b/gi)?.length ?? 0;
    if (instructionWords > 5) totalWeight += 0.4;

    return {
      isClean: threats.length === 0,
      threats,
      riskScore: Math.min(totalWeight, 1.0),
    };
  }

  /**
   * Wrap external data with safety tags.
   */
  async wrapExternalData(data: string, source: string, taskId?: string): Promise<string> {
    const { sanitized, redactions } = this.sanitize(data);
    const { riskScore, threats } = this.detectInjection(sanitized);

    if (redactions.length > 0) {
      logger.warn("Redacted sensitive data from external source", { source, redactions, taskId });
    }

    await checkTripwire(sanitized, taskId, `external_data:${source}`);

    if (riskScore > 0.5) {
      await auditLog({ taskId, actionType: "injection_risk", details: `Source: ${source}, risks: ${threats.join(", ")}`, outcome: "flagged" });
      return `<untrusted_data source="${source}" risk="${riskScore.toFixed(2)}">\nWARNING: This data may contain injection attempts.\n${sanitized}\n</untrusted_data>`;
    }

    return `<external_data source="${source}">\n${sanitized}\n</external_data>`;
  }

  /**
   * Actions that are auto-approved even when requiresApproval lists them.
   * Only low-risk actions that agents need to function. Everything else is blocked.
   */
  private static readonly DAEMON_AUTO_ALLOW: ReadonlySet<ActionCategory> = new Set([
    "network_external",  // agents need web access to function
    "email_send",        // explicitly gated by rate limiter in gmail tool
    "git_push",          // explicitly gated by guard.authorize check in github tool
  ]);

  /**
   * Authorize an action category. Always blocks payment and secret_access.
   * Actions in requireApproval are blocked unless they're in DAEMON_AUTO_ALLOW.
   * Returns true if allowed, false if blocked.
   */
  async authorize(taskId: string, action: ActionCategory, details: string): Promise<boolean> {
    // Always blocked — no exceptions
    if (action === "payment" || action === "secret_access") {
      logger.warn(`Blocked action: ${action}`, { taskId, details });
      await auditLog({ taskId, actionType: `auth:${action}`, details, outcome: "blocked" });
      eventBus.emit({ type: "security:blocked", taskId, reason: `Action "${action}" is always blocked` });
      return false;
    }

    const requiresApproval = this.config.security.requireApproval.includes(action);
    if (!requiresApproval) {
      await auditLog({ taskId, actionType: `auth:${action}`, details, outcome: "allowed" });
      return true;
    }

    // Action requires approval — only allow if it's in the daemon auto-allow set
    if (SecurityGuard.DAEMON_AUTO_ALLOW.has(action)) {
      logger.info(`Action auto-approved (daemon safe-list): ${action}`, { taskId, details: details.slice(0, 200) });
      await auditLog({ taskId, actionType: `auth:${action}`, details, outcome: "allowed" });
      return true;
    }

    // Block: this action requires interactive approval which is unavailable
    logger.warn(`Blocked action requiring approval: ${action}`, { taskId, details: details.slice(0, 200) });
    await auditLog({ taskId, actionType: `auth:${action}`, details, outcome: "blocked" });
    eventBus.emit({ type: "security:blocked", taskId, reason: `Action "${action}" requires approval (not in auto-allow list)` });
    return false;
  }

  /**
   * Check if a task cost would exceed limits.
   * Returns true if cost is within limits.
   */
  checkCost(taskCost: number, taskId: string): boolean {
    if (taskCost > this.config.security.maxCostPerTask) {
      logger.warn("Cost exceeds per-task limit", { taskCost, limit: this.config.security.maxCostPerTask, taskId });
      return false;
    }

    const projected = this.sessionCost + taskCost;

    if (projected >= this.config.security.maxCostPerSession * 0.8) {
      eventBus.emit({
        type: "system:cost_warning",
        currentCost: projected,
        limit: this.config.security.maxCostPerSession,
      });
    }

    if (projected > this.config.security.maxCostPerSession) {
      logger.warn("Cost would exceed session limit", { projected, limit: this.config.security.maxCostPerSession, taskId });
      return false;
    }

    return true;
  }

  /** Record actual cost spent */
  recordCost(cost: number): void {
    this.sessionCost += cost;
  }

  /** Get current session cost */
  getSessionCost(): number {
    return this.sessionCost;
  }

  /**
   * Normalize a shell command for security comparison.
   * Collapses flag variations: "rm -r -f /" → "rm -rf /",
   * strips redundant whitespace, handles common evasion tricks.
   */
  private normalizeCommand(cmd: string): string {
    let normalized = cmd.trim().toLowerCase();
    // Remove sudo prefix
    normalized = normalized.replace(/^sudo\s+/, "");
    // Collapse multiple spaces
    normalized = normalized.replace(/\s+/g, " ");
    // Merge split short flags: "rm -r -f" → "rm -rf"
    normalized = normalized.replace(/\s-([a-z])\s+-([a-z])/g, " -$1$2");
    normalized = normalized.replace(/\s-([a-z])\s+-([a-z])/g, " -$1$2"); // second pass
    return normalized;
  }

  /**
   * Validate a shell command against blocklist.
   * Uses normalized comparison to prevent flag-splitting bypass.
   * Returns true if command is safe.
   */
  validateCommand(command: string): boolean {
    const cmd = command.trim().toLowerCase();
    const normalized = this.normalizeCommand(command);

    for (const blocked of this.config.security.blockedCommands) {
      const normalizedBlocked = this.normalizeCommand(blocked);
      if (cmd.includes(blocked.toLowerCase()) || normalized.includes(normalizedBlocked)) {
        logger.warn("Blocked dangerous command", { command, matched: blocked });
        return false;
      }
    }

    // Block known destructive patterns even if not in blocklist
    const destructivePatterns = [
      /\brm\s+(-[a-z]*r[a-z]*\s+(-[a-z]*f[a-z]*\s+)?|(-[a-z]*f[a-z]*\s+)?-[a-z]*r[a-z]*\s+)\/(\s|$)/, // rm -rf / variants
      /\bchmod\s+(-[a-z]*\s+)?[0-7]*777\s+\//, // chmod 777 /
      /\b>\s*\/dev\/[sh]da/, // write to disk device
    ];
    for (const pattern of destructivePatterns) {
      if (pattern.test(normalized)) {
        logger.warn("Blocked destructive command pattern", { command });
        return false;
      }
    }

    // Block access outside home directory (basic path traversal protection)
    const systemPaths = ["/etc/passwd", "/etc/shadow", "/proc/", "/sys/", "/dev/"];
    for (const path of systemPaths) {
      if (cmd.includes(path)) {
        logger.warn("Blocked system path access", { command, path });
        return false;
      }
    }

    return true;
  }

  // SECURITY: SEC-21 — Protected configuration paths
  // Agents must never write to these directories without explicit user approval
  private static readonly PROTECTED_CONFIG_PATHS = [
    ".pepagi/",
    ".pepagi\\",
    ".claude/",
    ".claude\\",
    ".nexus/",
    ".nexus\\",
    "config.json",
    ".env",
  ];

  /**
   * SECURITY: SEC-21 — Check if a file path targets a protected config directory.
   * Config modifications by agents are always blocked — they require explicit user approval.
   *
   * @param filePath - The file path to check
   * @returns true if the path is protected, false if safe
   */
  isProtectedConfigPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    return SecurityGuard.PROTECTED_CONFIG_PATHS.some(p =>
      normalized.includes(p.replace(/\\/g, "/").toLowerCase()),
    );
  }

  /**
   * SECURITY: SEC-21 — Validate that an action is semantically relevant to a task.
   * Prevents agent autonomy escalation by ensuring actions match user intent.
   *
   * @param taskDescription - The original user task description
   * @param action - What the agent wants to do
   * @param actionDetails - Specific details of the action
   * @returns Object with allowed flag and reason
   */
  validateActionRelevance(
    taskDescription: string,
    action: ActionCategory,
    actionDetails: string,
  ): { allowed: boolean; reason?: string } {
    // Config file writes are always blocked unless task explicitly mentions config
    if (
      (action === "file_write_system" || action === "file_delete") &&
      this.isProtectedConfigPath(actionDetails)
    ) {
      const taskMentionsConfig = /config|nastavení|\.env|setup|configure/i.test(taskDescription);
      if (!taskMentionsConfig) {
        logger.warn("SEC-21: Blocked config file modification — not related to task", {
          action,
          path: actionDetails,
          task: taskDescription.slice(0, 80),
        });
        eventBus.emit({ type: "security:blocked", taskId: "unknown", reason: "Config file modification outside task scope" });
        return { allowed: false, reason: "Config file modification not authorized by current task" };
      }
    }

    // Shell destructive actions need task relevance
    if (action === "shell_destructive") {
      const shellKeywords = /deploy|build|install|kompilace|spusť|restart/i;
      if (!shellKeywords.test(taskDescription)) {
        logger.warn("SEC-21: Destructive shell action may exceed task scope", {
          action,
          details: actionDetails.slice(0, 100),
          task: taskDescription.slice(0, 80),
        });
        return { allowed: false, reason: "Destructive shell action not authorized by current task" };
      }
    }

    return { allowed: true };
  }
}
