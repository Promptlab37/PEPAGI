// ═══════════════════════════════════════════════════════════════
// PEPAGI — TLS & Infrastructure Security (SEC-27)
// TLS certificate verification, API endpoint validation,
// and infrastructure security checks.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("TLSVerifier");

// SECURITY: SEC-27 — Allowed API endpoints (cloud LLM providers)
const ALLOWED_API_HOSTS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "localhost",
  "127.0.0.1",
]);

// SECURITY: SEC-27 — Ports allowed for local inference
const LOCAL_ALLOWED_PORTS = new Set([11434, 1234]); // Ollama, LM Studio

export interface EndpointValidation {
  valid: boolean;
  isLocal: boolean;
  useTLS: boolean;
  host: string;
  warnings: string[];
}

/**
 * SECURITY: SEC-27 — Validate an API endpoint URL.
 * Ensures only known cloud providers or localhost are contacted.
 */
export function validateEndpoint(urlStr: string): EndpointValidation {
  const warnings: string[] = [];

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { valid: false, isLocal: false, useTLS: false, host: urlStr, warnings: ["Invalid URL"] };
  }

  const host = url.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const useTLS = url.protocol === "https:";

  // Cloud APIs must use TLS
  if (!isLocal && !useTLS) {
    warnings.push("SEC-27: Cloud API endpoint not using TLS");
    return { valid: false, isLocal, useTLS, host, warnings };
  }

  // Check if host is in allowed list
  if (!ALLOWED_API_HOSTS.has(host) && !isLocal) {
    warnings.push(`SEC-27: Unknown API host '${host}' — not in allowed list`);
    return { valid: false, isLocal, useTLS, host, warnings };
  }

  // Local endpoints: check port
  if (isLocal) {
    const port = url.port ? parseInt(url.port, 10) : (useTLS ? 443 : 80);
    if (!LOCAL_ALLOWED_PORTS.has(port)) {
      warnings.push(`SEC-27: Local port ${port} not in allowed list (${[...LOCAL_ALLOWED_PORTS].join(",")})`);
    }
  }

  return { valid: true, isLocal, useTLS, host, warnings };
}

/**
 * SECURITY: SEC-27 — Ensure fetch calls enforce TLS.
 * Returns headers that should be used for cloud API calls.
 */
export function getSecureFetchOptions(): Record<string, unknown> {
  return {
    // Node.js fetch respects system CA certificates by default
    // Explicitly ensure we don't disable TLS validation
    // Note: NODE_TLS_REJECT_UNAUTHORIZED should NEVER be set to '0'
  };
}

/**
 * SECURITY: SEC-27 — Check if NODE_TLS_REJECT_UNAUTHORIZED is insecurely set.
 */
export function checkTLSEnvironment(): { secure: boolean; warning?: string } {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    logger.error("SEC-27: NODE_TLS_REJECT_UNAUTHORIZED=0 detected — TLS validation disabled!");
    return {
      secure: false,
      warning: "SEC-27: TLS certificate validation is disabled! Set NODE_TLS_REJECT_UNAUTHORIZED=1 or remove it.",
    };
  }
  return { secure: true };
}

/**
 * SECURITY: SEC-27 — Validate that a request URL is safe to call.
 * Use this before every outbound LLM API call.
 */
export function guardOutboundRequest(url: string): boolean {
  const validation = validateEndpoint(url);

  if (!validation.valid) {
    logger.warn("SEC-27: Outbound request blocked", {
      url: url.slice(0, 80),
      warnings: validation.warnings,
    });
    return false;
  }

  if (validation.warnings.length > 0) {
    logger.warn("SEC-27: Outbound request warnings", {
      url: url.slice(0, 80),
      warnings: validation.warnings,
    });
  }

  return true;
}

logger.debug("SEC-27: TLS verifier module loaded");
