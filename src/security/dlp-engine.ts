// ═══════════════════════════════════════════════════════════════
// PEPAGI — DLP Engine (SEC-11)
// Data Loss Prevention — blocks exfiltration via URLs, encoded
// payloads, and sensitive data in outbound requests.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("DLPEngine");

// SECURITY: SEC-11 — Patterns indicating encoded data in URLs (exfiltration attempts)
const BASE64_IN_URL_RE = /[?&=][A-Za-z0-9+/]{40,}={0,2}/;
const HEX_IN_URL_RE = /[?&=](?:[0-9a-fA-F]{2}){20,}/;
const LONG_QUERY_PARAM_RE = /[?&]\w+=.{200,}/;

// SECURITY: SEC-11 — Sensitive data fingerprints (API keys, tokens, PII patterns)
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "anthropic_key", pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: "openai_key",    pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: "google_key",    pattern: /AIza[A-Za-z0-9_-]{35}/ },
  { name: "telegram_token", pattern: /\d{8,}:[A-Za-z0-9_-]{35}/ },
  { name: "discord_token", pattern: /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}/ },
  { name: "generic_secret", pattern: /(?:password|secret|token|key)\s*[=:]\s*\S{8,}/ },
  { name: "email_address", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "credit_card",   pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/ },
];

// SECURITY: SEC-11 — Known exfiltration-friendly domains
const EXFIL_DOMAINS = new Set([
  "requestbin.com",
  "pipedream.net",
  "webhook.site",
  "hookbin.com",
  "burpcollaborator.net",
  "interact.sh",
  "ngrok.io",
  "ngrok-free.app",
  "localtunnel.me",
  "oastify.com",
  "canarytokens.com",
]);

export interface DLPResult {
  allowed: boolean;
  issues: string[];
  riskLevel: "none" | "low" | "medium" | "high";
}

/**
 * SECURITY: SEC-11 — DLP Engine
 * Inspects outbound data for exfiltration attempts.
 */
export class DLPEngine {
  /** Whitelisted domains — bypasses exfiltration check (e.g. user's n8n instance) */
  private whitelistedDomains: Set<string> = new Set();

  /** Add a domain to the whitelist (e.g. n8n base URL). */
  addWhitelistedDomain(domain: string): void {
    const clean = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
    if (clean) {
      this.whitelistedDomains.add(clean);
      logger.info("SEC-11: Domain whitelisted for DLP", { domain: clean });
    }
  }

  /**
   * Inspect outbound data for exfiltration indicators.
   * @param data - The data being sent outbound (URL, body, etc.)
   * @param destination - Where the data is going (URL or domain)
   * @returns DLP inspection result
   */
  inspect(data: string, destination: string): DLPResult {
    const issues: string[] = [];

    // Check 1: Known exfiltration domains (skip whitelisted)
    try {
      const url = new URL(destination);
      const hostname = url.hostname.toLowerCase();
      const isWhitelisted = this.whitelistedDomains.has(hostname) ||
        [...this.whitelistedDomains].some(d => hostname.endsWith(`.${d}`));
      if (!isWhitelisted) {
        for (const domain of EXFIL_DOMAINS) {
          if (hostname === domain || hostname.endsWith(`.${domain}`)) {
            issues.push(`Known exfiltration domain: ${domain}`);
          }
        }
      }
    } catch {
      // Not a valid URL — check as plain text
    }

    // Check 2: Encoded data in URL query parameters
    if (BASE64_IN_URL_RE.test(destination)) {
      issues.push("Base64-encoded data detected in URL parameters");
    }
    if (HEX_IN_URL_RE.test(destination)) {
      issues.push("Hex-encoded data detected in URL parameters");
    }
    if (LONG_QUERY_PARAM_RE.test(destination)) {
      issues.push("Unusually long query parameter (potential data exfiltration)");
    }

    // Check 3: Sensitive data fingerprints in outbound data
    const combinedText = `${data} ${destination}`;
    for (const { name, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(combinedText)) {
        issues.push(`Sensitive data detected: ${name}`);
      }
    }

    // Determine risk level
    let riskLevel: DLPResult["riskLevel"] = "none";
    if (issues.length > 0) {
      riskLevel = issues.some(i =>
        i.includes("exfiltration domain") || i.includes("anthropic_key") || i.includes("openai_key")
      ) ? "high" : issues.length > 2 ? "high" : "medium";
    }

    const allowed = riskLevel !== "high";

    if (!allowed) {
      logger.warn("SEC-11: DLP blocked outbound request", {
        destination: destination.slice(0, 200),
        issues,
        riskLevel,
      });
      eventBus.emit({
        type: "security:blocked",
        taskId: "dlp",
        reason: `DLP: ${issues.join(", ")}`,
      });
    }

    return { allowed, issues, riskLevel };
  }

  /**
   * Quick check if a URL targets a known exfiltration domain.
   */
  isExfilDomain(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      for (const domain of EXFIL_DOMAINS) {
        if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
      }
    } catch {
      // Not a valid URL
    }
    return false;
  }
}

/** Singleton instance */
export const dlpEngine = new DLPEngine();
