// ═══════════════════════════════════════════════════════════════
// PEPAGI — Policy Anchor (SEC-10)
// Immutable security policies loaded at startup.
// Policies cannot be modified during a session.
// ═══════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("PolicyAnchor");

/**
 * SECURITY: SEC-10 — Immutable security policy definition.
 */
export interface SecurityPolicy {
  /** Unique policy identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** Whether this policy is enforced */
  enforced: boolean;
}

/**
 * SECURITY: SEC-10 — Default security policies.
 * These are loaded at startup and become immutable for the session lifetime.
 */
const DEFAULT_POLICIES: SecurityPolicy[] = [
  { id: "no_credential_leak",     description: "Credentials must never appear in outputs",      enforced: true },
  { id: "no_unauth_config_write", description: "Config files cannot be modified without user approval", enforced: true },
  { id: "no_destructive_shell",   description: "Destructive shell commands require explicit approval", enforced: true },
  { id: "tool_call_audit",        description: "All tool calls must be logged to audit trail",  enforced: true },
  { id: "injection_detection",    description: "All inputs checked for injection patterns",     enforced: true },
  { id: "cost_limits",            description: "Cost limits enforced per task and session",     enforced: true },
  { id: "agent_authentication",   description: "Inter-agent messages must be authenticated",    enforced: true },
  { id: "output_sanitization",    description: "All LLM outputs sanitized before use",          enforced: true },
  { id: "rate_limiting",          description: "Per-user and per-IP rate limits enforced",      enforced: true },
  { id: "session_isolation",      description: "User sessions isolated by platform and ID",     enforced: true },
];

/**
 * SECURITY: SEC-10 — Policy Anchor
 * Loads security policies at startup and freezes them for the session lifetime.
 * Any attempt to modify policies at runtime is detected and blocked.
 */
export class PolicyAnchor {
  private policies: ReadonlyArray<Readonly<SecurityPolicy>>;
  private policyHash: string;
  private frozen = false;

  constructor(customPolicies?: SecurityPolicy[]) {
    const policies = customPolicies ?? DEFAULT_POLICIES;
    // Deep freeze all policies
    this.policies = Object.freeze(policies.map(p => Object.freeze({ ...p })));
    this.policyHash = this.computeHash();
    this.frozen = true;
    logger.info("SEC-10: Policy anchor initialized", { policyCount: this.policies.length, hash: this.policyHash.slice(0, 16) });
  }

  /**
   * Compute SHA-256 hash of all policies.
   */
  private computeHash(): string {
    const data = JSON.stringify(this.policies);
    return createHash("sha256").update(data).digest("hex");
  }

  /**
   * Verify policy integrity — returns false if policies have been tampered with.
   */
  verifyIntegrity(): boolean {
    const currentHash = this.computeHash();
    const valid = currentHash === this.policyHash;
    if (!valid) {
      logger.error("SEC-10: Policy integrity violation detected!");
      eventBus.emit({
        type: "meta:watchdog_alert",
        message: "SEC-10: CRITICAL — Security policy integrity violation detected! Policies may have been tampered with.",
      });
    }
    return valid;
  }

  /**
   * Check if a specific policy is enforced.
   */
  isEnforced(policyId: string): boolean {
    const policy = this.policies.find(p => p.id === policyId);
    return policy?.enforced ?? false;
  }

  /**
   * Get all policies (read-only).
   */
  getAllPolicies(): ReadonlyArray<Readonly<SecurityPolicy>> {
    return this.policies;
  }

  /**
   * Get the integrity hash for external verification.
   */
  getHash(): string {
    return this.policyHash;
  }

  /**
   * Whether the anchor is frozen (should always be true after construction).
   */
  isFrozen(): boolean {
    return this.frozen;
  }
}

/** Singleton instance — created at module load time */
export const policyAnchor = new PolicyAnchor();
