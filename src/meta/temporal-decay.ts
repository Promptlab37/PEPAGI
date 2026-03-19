// ═══════════════════════════════════════════════════════════════
// PEPAGI — Temporal Decay Engine
// Applies exponential confidence decay to memory items over time
// ═══════════════════════════════════════════════════════════════

/** Default half-life values in days */
const DEFAULT_HALF_LIFE_FACTS = 30;
const DEFAULT_HALF_LIFE_EPISODES = 90;
const EXPIRY_THRESHOLD = 0.05;
const CONSOLIDATION_MIN_AGE_DAYS = 7;
const CONSOLIDATION_MIN_CONFIDENCE = 0.6;

export class TemporalDecayEngine {
  /**
   * Apply exponential decay to a confidence score based on elapsed time.
   * Formula: confidence * 0.5^(daysSince / halfLifeDays)
   * @param confidence - Original confidence value (0-1)
   * @param lastVerified - Date the item was last verified or created
   * @param halfLifeDays - Half-life period in days (default: 30)
   * @returns Decayed confidence value (0-1)
   */
  decay(confidence: number, lastVerified: Date, halfLifeDays = DEFAULT_HALF_LIFE_FACTS): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSince = (Date.now() - lastVerified.getTime()) / msPerDay;
    if (daysSince <= 0) return confidence;
    return confidence * Math.pow(0.5, daysSince / halfLifeDays);
  }

  /**
   * Apply temporal decay to all items and remove those whose decayed confidence
   * falls below the expiry threshold (0.05).
   * Uses `lastVerified` if present, otherwise `createdAt`.
   * @param items - Array of memory items with confidence and date fields
   * @param halfLifeDays - Half-life period in days (default: 30 for facts)
   * @returns Items with updated confidence scores, with expired items removed
   */
  pruneExpired<T extends { confidence: number; lastVerified?: Date; createdAt: Date }>(
    items: T[],
    halfLifeDays = DEFAULT_HALF_LIFE_FACTS,
  ): T[] {
    return items
      .map(item => {
        const referenceDate = item.lastVerified ?? item.createdAt;
        const decayedConfidence = this.decay(item.confidence, referenceDate, halfLifeDays);
        return { ...item, confidence: decayedConfidence };
      })
      .filter(item => item.confidence >= EXPIRY_THRESHOLD);
  }

  /**
   * Determine whether an episode should be consolidated into semantic memory.
   * Returns true when:
   *   - Episode age > 7 days
   *   - Episode was successful
   *   - Episode confidence > 0.6
   * @param episode - Episode object with relevant fields
   * @returns Whether the episode should be consolidated
   */
  shouldConsolidate(episode: {
    confidence: number;
    createdAt: Date;
    success: boolean;
  }): boolean {
    if (!episode.success) return false;
    if (episode.confidence <= CONSOLIDATION_MIN_CONFIDENCE) return false;

    const msPerDay = 24 * 60 * 60 * 1000;
    const ageDays = (Date.now() - episode.createdAt.getTime()) / msPerDay;
    return ageDays > CONSOLIDATION_MIN_AGE_DAYS;
  }

  /** Default half-life for fact memories (days) */
  get factHalfLife(): number {
    return DEFAULT_HALF_LIFE_FACTS;
  }

  /** Default half-life for episode memories (days) */
  get episodeHalfLife(): number {
    return DEFAULT_HALF_LIFE_EPISODES;
  }
}

/** Singleton temporal decay engine instance */
export const temporalDecay = new TemporalDecayEngine();
