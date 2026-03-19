// ═══════════════════════════════════════════════════════════════
// PEPAGI — Credential Lifecycle Manager (SEC-25)
// Task-scoped token lifecycle, PKCE challenge generation,
// and credential delegation governance.
// ═══════════════════════════════════════════════════════════════

import { randomBytes, createHash } from "node:crypto";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("CredentialLifecycle");

// SECURITY: SEC-25 — Maximum token lifetime (30 minutes)
const MAX_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
// SECURITY: SEC-25 — Default task-scoped token lifetime (10 minutes)
const DEFAULT_TASK_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export interface TaskScopedToken {
  tokenId: string;
  taskId: string;
  provider: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface PKCEChallenge {
  codeVerifier: string;       // 43-128 char random string
  codeChallenge: string;      // SHA-256 of verifier, base64url encoded
  method: "S256";
}

/**
 * SECURITY: SEC-25 — Credential Lifecycle Manager
 * Manages task-scoped tokens with automatic expiration and PKCE support.
 */
export class CredentialLifecycleManager {
  private tokens: Map<string, TaskScopedToken> = new Map();
  private taskTokens: Map<string, string[]> = new Map(); // taskId → tokenIds
  // FIX: periodic cleanup of expired tokens to prevent unbounded Map growth
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // FIX: run cleanup every 5 minutes; unref so it doesn't prevent process exit
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  /** Stop the periodic cleanup timer */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * SECURITY: SEC-25 — Generate PKCE challenge pair.
   * Uses S256 method (SHA-256 hash of verifier).
   */
  generatePKCE(): PKCEChallenge {
    // Generate 32 bytes of randomness for verifier (base64url = 43 chars)
    const verifierBytes = randomBytes(32);
    const codeVerifier = verifierBytes
      .toString("base64url")
      .replace(/[^a-zA-Z0-9\-._~]/g, "");

    // S256: SHA-256 hash of verifier, base64url encoded
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    return {
      codeVerifier,
      codeChallenge,
      method: "S256",
    };
  }

  /**
   * SECURITY: SEC-25 — Verify PKCE challenge against verifier.
   */
  verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
    const computed = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return computed === codeChallenge;
  }

  /**
   * SECURITY: SEC-25 — Issue a task-scoped token.
   * Token automatically expires when task completes or after timeout.
   */
  issueTaskToken(
    taskId: string,
    provider: string,
    lifetimeMs = DEFAULT_TASK_TOKEN_LIFETIME_MS,
  ): TaskScopedToken {
    // Enforce maximum lifetime
    const effectiveLifetime = Math.min(lifetimeMs, MAX_TOKEN_LIFETIME_MS);

    const token: TaskScopedToken = {
      tokenId: `tok-${randomBytes(16).toString("hex")}`,
      taskId,
      provider,
      issuedAt: Date.now(),
      expiresAt: Date.now() + effectiveLifetime,
      revoked: false,
    };

    this.tokens.set(token.tokenId, token);

    // Track by task
    const existing = this.taskTokens.get(taskId) ?? [];
    existing.push(token.tokenId);
    this.taskTokens.set(taskId, existing);

    logger.debug("SEC-25: Task-scoped token issued", {
      tokenId: token.tokenId.slice(0, 8),
      taskId,
      provider,
      expiresIn: `${Math.round(effectiveLifetime / 1000)}s`,
    });

    return token;
  }

  /**
   * SECURITY: SEC-25 — Validate a task-scoped token.
   * Checks expiration, revocation, and task binding.
   */
  validateToken(tokenId: string, taskId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    if (token.revoked) return false;
    if (token.taskId !== taskId) return false;
    if (Date.now() > token.expiresAt) {
      // Auto-revoke expired tokens
      token.revoked = true;
      return false;
    }
    return true;
  }

  /**
   * SECURITY: SEC-25 — Revoke a specific token.
   */
  revokeToken(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    token.revoked = true;
    logger.debug("SEC-25: Token revoked", { tokenId: tokenId.slice(0, 8) });
    return true;
  }

  /**
   * SECURITY: SEC-25 — Revoke all tokens for a completed task.
   * Must be called when a task finishes (success or failure).
   */
  revokeTaskTokens(taskId: string): number {
    const tokenIds = this.taskTokens.get(taskId);
    if (!tokenIds) return 0;

    let revoked = 0;
    for (const tokenId of tokenIds) {
      const token = this.tokens.get(tokenId);
      if (token && !token.revoked) {
        token.revoked = true;
        revoked++;
      }
    }

    this.taskTokens.delete(taskId);

    if (revoked > 0) {
      logger.info("SEC-25: Task tokens revoked on completion", {
        taskId,
        revokedCount: revoked,
      });
    }

    return revoked;
  }

  /**
   * SECURITY: SEC-25 — Cleanup expired tokens from memory.
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [tokenId, token] of this.tokens) {
      if (token.revoked || now > token.expiresAt) {
        this.tokens.delete(tokenId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * SECURITY: SEC-25 — Check if a task has any active (non-expired, non-revoked) tokens.
   */
  hasActiveTokens(taskId: string): boolean {
    const tokenIds = this.taskTokens.get(taskId);
    if (!tokenIds) return false;

    const now = Date.now();
    return tokenIds.some(id => {
      const token = this.tokens.get(id);
      return token && !token.revoked && now <= token.expiresAt;
    });
  }

  /** Get count of active tokens */
  getActiveTokenCount(): number {
    const now = Date.now();
    let count = 0;
    for (const token of this.tokens.values()) {
      if (!token.revoked && now <= token.expiresAt) count++;
    }
    return count;
  }
}

/** Singleton instance */
export const credentialLifecycle = new CredentialLifecycleManager();
