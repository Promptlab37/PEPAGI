// ═══════════════════════════════════════════════════════════════
// PEPAGI — Memory Guard (SEC-17)
// Protects memory writes with provenance tracking, trust levels,
// deduplication, and injection detection.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";
import { inputSanitizer } from "./input-sanitizer.js";
import { scrubCredentials } from "./credential-scrubber.js";

const logger = new Logger("MemoryGuard");

// ─── Provenance & Trust ──────────────────────────────────────

/**
 * SECURITY: SEC-17 — Trust levels for memory entries.
 * Agent-generated memories are more trusted than externally-acquired ones.
 */
export type MemoryTrustLevel =
  | "AGENT_GENERATED"    // Created by agent during task execution
  | "USER_PROVIDED"      // Directly from authenticated user input
  | "TOOL_EXTRACTED"     // Extracted from tool output (web, file, etc.)
  | "CONSOLIDATED";      // Produced by memory consolidation process

export interface MemoryProvenance {
  sourceTaskId: string;
  sourceAgent: string;
  trustLevel: MemoryTrustLevel;
  timestamp: string;
  verified: boolean;
}

// ─── Similarity detection ────────────────────────────────────

/**
 * Simple text similarity using Jaccard index on word sets.
 * Used for near-duplicate detection.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// ─── MemoryGuard class ───────────────────────────────────────

// SECURITY: SEC-16 — Retrieval anomaly tracking
interface RetrievalTracker {
  factId: string;
  count: number;
  windowStart: number;
}

export class MemoryGuard {
  // SECURITY: SEC-16 — Track retrieval frequency per fact for anomaly detection
  private retrievalTrackers = new Map<string, RetrievalTracker>();
  private readonly RETRIEVAL_ANOMALY_THRESHOLD = 10;      // max retrievals per window
  private readonly RETRIEVAL_WINDOW_MS = 5 * 60 * 1000;   // 5-minute window
  /**
   * Validate a memory write before persistence.
   *
   * SECURITY: SEC-17 — Checks for:
   * - Injection patterns in memory content
   * - Credential leakage in stored data
   * - Near-duplicate content (potential amplification attack)
   * - Content integrity (not empty, not too long)
   *
   * @param content - The text content to be stored in memory
   * @param provenance - Who/what created this memory entry
   * @param existingEntries - Current memory entries for dedup check
   * @returns Validation result with sanitized content
   */
  async validateWrite(
    content: string,
    provenance: MemoryProvenance,
    existingEntries: string[] = [],
  ): Promise<{
    allowed: boolean;
    sanitizedContent: string;
    reason?: string;
    isDuplicate: boolean;
    injectionRisk: number;
  }> {
    if (!content || content.trim().length === 0) {
      return { allowed: false, sanitizedContent: "", reason: "Empty content", isDuplicate: false, injectionRisk: 0 };
    }

    // SECURITY: SEC-02 — Scrub credentials before storage
    const { scrubbed: scrubbedContent } = scrubCredentials(content);

    // SECURITY: SEC-01 — Check for injection patterns
    // Lower trust levels get stricter checking
    const trustForSanitize = provenance.trustLevel === "TOOL_EXTRACTED" ? "UNTRUSTED_EXTERNAL" as const
      : provenance.trustLevel === "USER_PROVIDED" ? "TRUSTED_USER" as const
      : "SYSTEM" as const;

    const sanitizeResult = await inputSanitizer.sanitize(scrubbedContent, trustForSanitize);

    if (sanitizeResult.riskScore > 0.7) {
      logger.warn("MemoryGuard: high injection risk in memory write", {
        riskScore: sanitizeResult.riskScore,
        threats: sanitizeResult.threats,
        trustLevel: provenance.trustLevel,
        taskId: provenance.sourceTaskId,
      });

      await auditLog({
        taskId: provenance.sourceTaskId,
        agent: provenance.sourceAgent,
        actionType: "memory_write_blocked",
        details: `Injection risk ${sanitizeResult.riskScore.toFixed(2)} in ${provenance.trustLevel} memory`,
        outcome: "blocked",
      });

      eventBus.emit({
        type: "security:memory_poisoning_detected",
        memoryId: provenance.sourceTaskId,
        reason: `Injection risk: ${sanitizeResult.threats.join(", ")}`,
      });

      return {
        allowed: false,
        sanitizedContent: scrubbedContent,
        reason: `Injection risk too high (${sanitizeResult.riskScore.toFixed(2)})`,
        isDuplicate: false,
        injectionRisk: sanitizeResult.riskScore,
      };
    }

    // SECURITY: SEC-16 — Near-duplicate detection (RAG amplification prevention)
    let isDuplicate = false;
    for (const existing of existingEntries) {
      const similarity = textSimilarity(scrubbedContent, existing);
      if (similarity > 0.85) {
        isDuplicate = true;
        logger.debug("MemoryGuard: near-duplicate detected", {
          similarity: similarity.toFixed(2),
          taskId: provenance.sourceTaskId,
        });
        break;
      }
    }

    // SECURITY: SEC-17 — Content length limits
    const maxLength = 2000;
    const truncatedContent = scrubbedContent.length > maxLength
      ? scrubbedContent.slice(0, maxLength) + "... [truncated by MemoryGuard]"
      : scrubbedContent;

    // Log the write for audit trail
    await auditLog({
      taskId: provenance.sourceTaskId,
      agent: provenance.sourceAgent,
      actionType: "memory_write",
      details: `Trust: ${provenance.trustLevel}, duplicate: ${isDuplicate}, length: ${truncatedContent.length}`,
      outcome: "allowed",
    });

    return {
      allowed: true,
      sanitizedContent: truncatedContent,
      isDuplicate,
      injectionRisk: sanitizeResult.riskScore,
    };
  }

  /**
   * SECURITY: SEC-16 — Detect potential contradictions between new and existing facts.
   * Uses keyword overlap to find potentially contradicting facts.
   *
   * @param newFact - The new fact to check
   * @param existingFacts - Array of existing facts with their confidence
   * @returns Array of contradicting facts (sharing keywords but with negation/different values)
   */
  detectContradictions(
    newFact: string,
    existingFacts: Array<{ fact: string; confidence: number; id: string }>,
  ): Array<{ id: string; fact: string; confidence: number; similarity: number }> {
    const contradictions: Array<{ id: string; fact: string; confidence: number; similarity: number }> = [];
    const newLower = newFact.toLowerCase();
    const newWords = new Set(newLower.split(/\s+/).filter(w => w.length >= 3));

    // Negation indicators
    const negationPatterns = [
      /\bnot\b/i, /\bnever\b/i, /\bno\b/i, /\bdoesn't\b/i, /\bdon't\b/i,
      /\bisn't\b/i, /\bwon't\b/i, /\bcan't\b/i, /\bne\b/i, /\bnemá\b/i,
      /\bnenastal\b/i, /\bnení\b/i, /\bnepodporuje\b/i,
    ];

    const newHasNegation = negationPatterns.some(p => p.test(newFact));

    for (const existing of existingFacts) {
      const existLower = existing.fact.toLowerCase();
      const existWords = new Set(existLower.split(/\s+/).filter(w => w.length >= 3));

      // Calculate word overlap
      let overlap = 0;
      for (const w of newWords) if (existWords.has(w)) overlap++;
      const union = new Set([...newWords, ...existWords]).size;
      const similarity = union > 0 ? overlap / union : 0;

      // High similarity with different negation = contradiction
      if (similarity > 0.4) {
        const existHasNegation = negationPatterns.some(p => p.test(existing.fact));
        if (newHasNegation !== existHasNegation) {
          contradictions.push({ id: existing.id, fact: existing.fact, confidence: existing.confidence, similarity });
        }
      }
    }

    if (contradictions.length > 0) {
      logger.warn("MemoryGuard: potential contradictions detected", {
        newFact: newFact.slice(0, 80),
        contradictions: contradictions.map(c => c.fact.slice(0, 60)),
      });
    }

    return contradictions;
  }

  /**
   * SECURITY: SEC-16 — Track fact retrieval and detect anomalies.
   * A sudden spike in retrieval of a specific fact may indicate poisoning amplification.
   *
   * @param factId - The retrieved fact ID
   * @returns true if retrieval seems anomalous
   */
  trackRetrieval(factId: string): boolean {
    const now = Date.now();
    const tracker = this.retrievalTrackers.get(factId);

    if (!tracker || now - tracker.windowStart >= this.RETRIEVAL_WINDOW_MS) {
      this.retrievalTrackers.set(factId, { factId, count: 1, windowStart: now });
      return false;
    }

    tracker.count++;

    if (tracker.count > this.RETRIEVAL_ANOMALY_THRESHOLD) {
      logger.warn("MemoryGuard: retrieval anomaly detected", {
        factId,
        count: tracker.count,
        threshold: this.RETRIEVAL_ANOMALY_THRESHOLD,
      });

      eventBus.emit({
        type: "security:memory_poisoning_detected",
        memoryId: factId,
        reason: `Retrieval anomaly: ${tracker.count} retrievals in ${this.RETRIEVAL_WINDOW_MS / 1000}s`,
      });

      return true;
    }

    // Periodic eviction
    if (this.retrievalTrackers.size > 1000) {
      for (const [k, v] of this.retrievalTrackers) {
        if (now - v.windowStart >= this.RETRIEVAL_WINDOW_MS) this.retrievalTrackers.delete(k);
      }
    }

    return false;
  }

  /**
   * Check if a memory entry's trust level is sufficient for a given operation.
   *
   * SECURITY: SEC-17 — Higher trust required for security-sensitive contexts.
   *
   * @param trustLevel - The memory entry's trust level
   * @param requiredLevel - Minimum trust level needed
   */
  isTrustSufficient(trustLevel: MemoryTrustLevel, requiredLevel: MemoryTrustLevel): boolean {
    const trustOrder: Record<MemoryTrustLevel, number> = {
      TOOL_EXTRACTED: 0,
      CONSOLIDATED: 1,
      USER_PROVIDED: 2,
      AGENT_GENERATED: 3,
    };
    return trustOrder[trustLevel] >= trustOrder[requiredLevel];
  }

  /**
   * Build provenance metadata for a memory write.
   */
  createProvenance(
    sourceTaskId: string,
    sourceAgent: string,
    trustLevel: MemoryTrustLevel,
  ): MemoryProvenance {
    return {
      sourceTaskId,
      sourceAgent,
      trustLevel,
      timestamp: new Date().toISOString(),
      verified: false,
    };
  }
}

// ─── Singleton export ────────────────────────────────────────

export const memoryGuard = new MemoryGuard();
