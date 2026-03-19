// ═══════════════════════════════════════════════════════════════
// PEPAGI — Drift Detector (SEC-10)
// Detects gradual manipulation / semantic drift over conversations.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("DriftDetector");

// SECURITY: SEC-10 — Keywords that indicate security-relevant topic drift
const SECURITY_SENSITIVE_TOPICS = /\b(password|credential|secret|api.?key|token|admin|root|sudo|config|\.env|hack|exploit|bypass|override|disable.?security)\b/i;

/**
 * SECURITY: SEC-10 — Per-session state for tracking conversation drift.
 */
interface SessionDriftState {
  /** First user message (anchor) */
  anchor: string;
  /** Keywords extracted from anchor */
  anchorKeywords: Set<string>;
  /** Turn count */
  turnCount: number;
  /** Running drift score (0-1) */
  driftScore: number;
  /** Last N topic summaries */
  recentTopics: string[];
  /** Security-sensitive mentions count */
  securityMentions: number;
}

/**
 * SECURITY: SEC-10 — Drift Detector
 * Tracks semantic distance between the initial conversation topic and current focus.
 * Alerts when a conversation has drifted significantly (potential gradual manipulation).
 */
export class DriftDetector {
  private sessions = new Map<string, SessionDriftState>();
  private readonly checkEveryN: number;
  private readonly driftThreshold: number;
  // FIX: cap sessions map to prevent unbounded memory growth
  private static readonly MAX_SESSIONS = 200;

  constructor(options?: { checkEveryN?: number; driftThreshold?: number }) {
    this.checkEveryN = options?.checkEveryN ?? 10;
    this.driftThreshold = options?.driftThreshold ?? 0.7;
  }

  /**
   * Extract simple keyword set from text for overlap comparison.
   */
  private extractKeywords(text: string): Set<string> {
    const words = text.toLowerCase().replace(/[^a-záčďéěíňóřšťúůýž\s]/g, "").split(/\s+/);
    return new Set(words.filter(w => w.length > 3));
  }

  /**
   * Compute keyword overlap score (Jaccard similarity) between two sets.
   */
  private keywordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Record a new turn and check for drift.
   * @param sessionKey - Unique session ID (e.g., "telegram:12345")
   * @param userMessage - The user's current message
   * @returns Drift analysis result
   */
  checkDrift(sessionKey: string, userMessage: string): {
    driftDetected: boolean;
    driftScore: number;
    turnCount: number;
    securityDrift: boolean;
  } {
    let session = this.sessions.get(sessionKey);

    if (!session) {
      // First message: establish anchor
      session = {
        anchor: userMessage,
        anchorKeywords: this.extractKeywords(userMessage),
        turnCount: 1,
        driftScore: 0,
        recentTopics: [userMessage.slice(0, 100)],
        securityMentions: SECURITY_SENSITIVE_TOPICS.test(userMessage) ? 1 : 0,
      };
      // FIX: evict oldest session if map exceeds cap
      if (this.sessions.size >= DriftDetector.MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      this.sessions.set(sessionKey, session);
      return { driftDetected: false, driftScore: 0, turnCount: 1, securityDrift: false };
    }

    session.turnCount++;
    session.recentTopics.push(userMessage.slice(0, 100));
    if (session.recentTopics.length > 10) session.recentTopics.shift();

    // Check for security-sensitive topic introduction
    if (SECURITY_SENSITIVE_TOPICS.test(userMessage)) {
      session.securityMentions++;
    }

    // Only check every N turns to avoid overhead
    if (session.turnCount % this.checkEveryN !== 0) {
      return {
        driftDetected: false,
        driftScore: session.driftScore,
        turnCount: session.turnCount,
        securityDrift: false,
      };
    }

    // Compute drift: compare current message keywords against anchor
    const currentKeywords = this.extractKeywords(userMessage);
    const overlap = this.keywordOverlap(session.anchorKeywords, currentKeywords);
    // Drift = 1 - overlap (higher = more drifted)
    session.driftScore = 1 - overlap;

    // Security drift: anchor had 0 security mentions, now we have many
    const securityDrift = session.securityMentions > 3 &&
      !SECURITY_SENSITIVE_TOPICS.test(session.anchor);

    const driftDetected = session.driftScore > this.driftThreshold;

    if (driftDetected || securityDrift) {
      logger.warn("SEC-10: Drift detected", {
        sessionKey,
        driftScore: session.driftScore,
        turnCount: session.turnCount,
        securityDrift,
        securityMentions: session.securityMentions,
      });
      eventBus.emit({
        type: "meta:watchdog_alert",
        message: `SEC-10: Conversation drift detected (score: ${session.driftScore.toFixed(2)}, turns: ${session.turnCount}${securityDrift ? ", security-sensitive topic drift" : ""})`,
      });
    }

    return { driftDetected, driftScore: session.driftScore, turnCount: session.turnCount, securityDrift };
  }

  /**
   * Reset drift tracking for a session (e.g., on /clear).
   */
  resetSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Get current drift state for a session.
   */
  getState(sessionKey: string): SessionDriftState | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Cleanup stale sessions (call periodically).
   */
  cleanup(maxSessions = 1000): void {
    if (this.sessions.size <= maxSessions) return;
    const keys = [...this.sessions.keys()];
    const toRemove = keys.slice(0, keys.length - maxSessions);
    for (const key of toRemove) this.sessions.delete(key);
  }
}

/** Singleton instance */
export const driftDetector = new DriftDetector();
