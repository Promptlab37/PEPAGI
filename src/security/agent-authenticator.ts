// ═══════════════════════════════════════════════════════════════
// PEPAGI — Agent Authenticator (SEC-18)
// Zero-trust inter-agent authentication with HMAC-signed messages,
// circuit breakers, and delegation depth limits.
// ═══════════════════════════════════════════════════════════════

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";

const logger = new Logger("AgentAuth");

// SECURITY: SEC-20 — Session token rotation interval (15 minutes)
const TOKEN_ROTATION_INTERVAL_MS = 15 * 60 * 1000;

/** SECURITY: SEC-20 — Agent identity with cryptographic UUID and session token */
export interface AgentIdentity {
  agentId: string;        // UUID v4 (cryptographic)
  provider: string;       // Human-readable provider name
  sessionToken: string;   // Short-lived session token
  issuedAt: number;       // Token issue timestamp
  expiresAt: number;      // Token expiry timestamp
}

// ─── Types ───────────────────────────────────────────────────

/**
 * SECURITY: SEC-18 — Signed inter-agent message format.
 * Every message between mediator and workers includes
 * HMAC-SHA256 signature for integrity and authenticity.
 */
export interface SignedMessage {
  taskId: string;
  nonce: string;           // Random nonce for replay protection
  timestamp: number;        // Unix timestamp (ms)
  senderId: string;         // Agent identity (e.g., "mediator", "worker-claude")
  payload: string;          // The actual message content
  hmac: string;             // HMAC-SHA256 of all above fields
  delegationDepth: number;  // How many hops from original user request
}

/**
 * Circuit breaker state per agent.
 * Tracks suspicious outputs and isolates misbehaving agents.
 */
interface CircuitBreakerState {
  suspiciousCount: number;
  lastSuspicious: number;
  isolated: boolean;
  isolatedAt: number;
}

// ─── Constants ───────────────────────────────────────────────

// SECURITY: SEC-18 — Maximum delegation depth to prevent infinite chains
const MAX_DELEGATION_DEPTH = 3;

// SECURITY: SEC-18 — Message validity window (5 minutes)
const MESSAGE_VALIDITY_MS = 5 * 60 * 1000;

// SECURITY: SEC-18 — Circuit breaker: isolate after N suspicious outputs
const CIRCUIT_BREAKER_THRESHOLD = 3;

// SECURITY: SEC-18 — Circuit breaker recovery time (15 minutes)
const CIRCUIT_BREAKER_RECOVERY_MS = 15 * 60 * 1000;

// ─── AgentAuthenticator class ────────────────────────────────

export class AgentAuthenticator {
  private secretKey: string;
  private usedNonces: Set<string> = new Set();
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  // SECURITY: SEC-20 — Agent identity registry
  private agentIdentities: Map<string, AgentIdentity> = new Map();

  constructor(secretKey?: string) {
    // SECURITY: SEC-18 — Generate random session key if not provided
    this.secretKey = secretKey ?? randomBytes(32).toString("hex");
  }

  // ─── SEC-20: Agent Identity Management ──────────────────

  /**
   * SECURITY: SEC-20 — Register an agent with a cryptographic UUID.
   * @param provider - Provider name (e.g., "claude", "gpt")
   * @returns Assigned agent identity
   */
  registerAgent(provider: string): AgentIdentity {
    const agentId = randomUUID();
    const now = Date.now();
    const identity: AgentIdentity = {
      agentId,
      provider,
      sessionToken: randomBytes(32).toString("hex"),
      issuedAt: now,
      expiresAt: now + TOKEN_ROTATION_INTERVAL_MS,
    };
    this.agentIdentities.set(agentId, identity);
    logger.info("SEC-20: Agent registered", { agentId: agentId.slice(0, 8), provider });
    return identity;
  }

  /**
   * SECURITY: SEC-20 — Validate an agent's session token.
   * Returns false if token is expired or invalid.
   */
  validateSessionToken(agentId: string, token: string): boolean {
    const identity = this.agentIdentities.get(agentId);
    if (!identity) return false;
    if (identity.sessionToken !== token) return false;
    if (Date.now() > identity.expiresAt) {
      logger.warn("SEC-20: Session token expired", { agentId: agentId.slice(0, 8) });
      return false;
    }
    return true;
  }

  /**
   * SECURITY: SEC-20 — Rotate an agent's session token.
   * @returns New identity with fresh token, or null if agent unknown
   */
  rotateToken(agentId: string): AgentIdentity | null {
    const identity = this.agentIdentities.get(agentId);
    if (!identity) return null;
    const now = Date.now();
    identity.sessionToken = randomBytes(32).toString("hex");
    identity.issuedAt = now;
    identity.expiresAt = now + TOKEN_ROTATION_INTERVAL_MS;
    logger.debug("SEC-20: Token rotated", { agentId: agentId.slice(0, 8) });
    return identity;
  }

  /**
   * SECURITY: SEC-20 — Get agent identity by provider name.
   */
  getIdentityByProvider(provider: string): AgentIdentity | undefined {
    for (const identity of this.agentIdentities.values()) {
      if (identity.provider === provider) return identity;
    }
    return undefined;
  }

  /**
   * Sign a message for inter-agent communication.
   *
   * SECURITY: SEC-18 — Creates HMAC-SHA256 signature over all message fields.
   * The signature proves message integrity and authenticity.
   *
   * @param taskId - The task this message relates to
   * @param senderId - Identity of the sending agent
   * @param payload - The message content
   * @param delegationDepth - Current delegation depth (0 = direct from user)
   * @returns Signed message with HMAC
   */
  sign(taskId: string, senderId: string, payload: string, delegationDepth = 0): SignedMessage {
    const nonce = randomBytes(16).toString("hex");
    const timestamp = Date.now();

    const dataToSign = `${taskId}|${nonce}|${timestamp}|${senderId}|${delegationDepth}|${payload}`;
    const hmac = createHmac("sha256", this.secretKey)
      .update(dataToSign)
      .digest("hex");

    return { taskId, nonce, timestamp, senderId, payload, hmac, delegationDepth };
  }

  /**
   * Verify a signed inter-agent message.
   *
   * SECURITY: SEC-18 — Checks:
   * 1. HMAC signature validity
   * 2. Message not expired (5-minute window)
   * 3. Nonce not reused (replay protection)
   * 4. Delegation depth within limits
   * 5. Sender not isolated by circuit breaker
   *
   * @param message - The signed message to verify
   * @returns Verification result
   */
  verify(message: SignedMessage): { valid: boolean; reason?: string } {
    // Check delegation depth
    if (message.delegationDepth > MAX_DELEGATION_DEPTH) {
      logger.warn("Message rejected: delegation depth exceeded", {
        sender: message.senderId,
        depth: message.delegationDepth,
        max: MAX_DELEGATION_DEPTH,
      });
      return { valid: false, reason: `Delegation depth ${message.delegationDepth} exceeds max ${MAX_DELEGATION_DEPTH}` };
    }

    // Check message freshness
    const age = Date.now() - message.timestamp;
    if (age > MESSAGE_VALIDITY_MS || age < -30_000) {
      return { valid: false, reason: `Message expired or from future (age: ${age}ms)` };
    }

    // Check nonce (replay protection)
    if (this.usedNonces.has(message.nonce)) {
      logger.warn("Message rejected: nonce reuse (replay attack?)", {
        sender: message.senderId,
        nonce: message.nonce,
      });
      return { valid: false, reason: "Nonce already used (replay detected)" };
    }

    // Verify HMAC
    const dataToSign = `${message.taskId}|${message.nonce}|${message.timestamp}|${message.senderId}|${message.delegationDepth}|${message.payload}`;
    const expectedHmac = createHmac("sha256", this.secretKey)
      .update(dataToSign)
      .digest("hex");

    if (expectedHmac !== message.hmac) {
      logger.warn("Message rejected: HMAC mismatch", {
        sender: message.senderId,
        taskId: message.taskId,
      });
      return { valid: false, reason: "HMAC signature invalid" };
    }

    // Check circuit breaker
    const cb = this.circuitBreakers.get(message.senderId);
    if (cb?.isolated) {
      const recoveryTime = cb.isolatedAt + CIRCUIT_BREAKER_RECOVERY_MS;
      if (Date.now() < recoveryTime) {
        return { valid: false, reason: `Agent ${message.senderId} is isolated by circuit breaker` };
      }
      // Recovery time passed — reset circuit breaker
      cb.isolated = false;
      cb.suspiciousCount = 0;
    }

    // Mark nonce as used
    this.usedNonces.add(message.nonce);

    // Prevent nonce set from growing unbounded
    if (this.usedNonces.size > 10_000) {
      const entries = [...this.usedNonces].slice(-5000);
      this.usedNonces = new Set(entries);
    }

    return { valid: true };
  }

  /**
   * Report a suspicious output from an agent.
   * After CIRCUIT_BREAKER_THRESHOLD suspicious outputs, the agent is isolated.
   *
   * SECURITY: SEC-18 — Circuit breaker prevents compromised agents from
   * continuing to poison the pipeline.
   *
   * @param agentId - The suspicious agent
   * @param reason - Why the output is suspicious
   */
  async reportSuspicious(agentId: string, reason: string): Promise<void> {
    let state = this.circuitBreakers.get(agentId);
    if (!state) {
      state = { suspiciousCount: 0, lastSuspicious: 0, isolated: false, isolatedAt: 0 };
      this.circuitBreakers.set(agentId, state);
    }

    state.suspiciousCount++;
    state.lastSuspicious = Date.now();

    logger.warn("Suspicious agent output reported", {
      agentId,
      reason,
      count: state.suspiciousCount,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
    });

    if (state.suspiciousCount >= CIRCUIT_BREAKER_THRESHOLD && !state.isolated) {
      state.isolated = true;
      state.isolatedAt = Date.now();

      logger.error("Agent isolated by circuit breaker", { agentId, reason });

      eventBus.emit({
        type: "security:agent_isolated",
        agent: agentId,
        reason: `Circuit breaker: ${state.suspiciousCount} suspicious outputs. Last: ${reason}`,
      });

      await auditLog({
        agent: agentId,
        actionType: "agent_isolated",
        details: `Circuit breaker triggered after ${state.suspiciousCount} suspicious outputs. Reason: ${reason}`,
        outcome: "blocked",
      });
    }
  }

  /**
   * Check if an agent is currently isolated by the circuit breaker.
   */
  isIsolated(agentId: string): boolean {
    const state = this.circuitBreakers.get(agentId);
    if (!state?.isolated) return false;

    // Check if recovery time has passed
    if (Date.now() >= state.isolatedAt + CIRCUIT_BREAKER_RECOVERY_MS) {
      state.isolated = false;
      state.suspiciousCount = 0;
      return false;
    }

    return true;
  }

  /**
   * Get current delegation depth limit.
   */
  getMaxDelegationDepth(): number {
    return MAX_DELEGATION_DEPTH;
  }
}

// ─── Singleton export ────────────────────────────────────────

export const agentAuthenticator = new AgentAuthenticator();
