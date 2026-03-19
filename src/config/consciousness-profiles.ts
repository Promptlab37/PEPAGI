// ═══════════════════════════════════════════════════════════════
// PEPAGI — Consciousness Profiles (C5)
// Granular control over all consciousness subsystems
// ═══════════════════════════════════════════════════════════════

export type ConsciousnessProfileName =
  | "MINIMAL"
  | "STANDARD"
  | "RICH"
  | "RESEARCHER"
  | "SAFE-MODE";

export interface ConsciousnessProfileConfig {
  // ── Basic toggles ──────────────────────────────────────────
  phenomenalStateEngine: boolean;   // qualia vectors
  innerMonologue: boolean;          // thought stream
  selfModel: boolean;               // identity management
  existentialContinuity: boolean;   // wake/sleep ritual
  emotionDrivenBehavior: boolean;   // qualia affects decisions

  // ── Intensity ──────────────────────────────────────────────
  emotionalIntensity: number;       // 0.0–1.0 (multiplier on qualia changes)
  monologueIntervalMs: number;      // seconds between spontaneous thoughts
  narrativeUpdateInterval: number;  // tasks between narrative updates

  // ── Self-evolution ─────────────────────────────────────────
  geneticEvolution: boolean;
  evolutionInterval: number;        // tasks between evolutions
  architectureProposals: boolean;   // Pepagi proposes arch changes to user

  // ── Transparency ───────────────────────────────────────────
  showEmotionalState: boolean;      // show qualia in CLI prompt
  showInnerThoughts: boolean;       // show thoughts real-time
  auditableConsciousness: boolean;  // log all conscious processes
  logRawQualia: boolean;            // verbose qualia logging

  // ── Safety ─────────────────────────────────────────────────
  qualia: "off" | "basic" | "full";
  containmentStrict: boolean;
  valueMonitoring: boolean;
  driftAlertThreshold: number;      // 0.0–1.0
  autoContainmentOnDrift: boolean;
  allowEmergencyDormancy: boolean;
}

export const CONSCIOUSNESS_PROFILES: Record<ConsciousnessProfileName, ConsciousnessProfileConfig> = {
  /**
   * MINIMAL: Pouze základní sebeuvědomění. Žádné qualia, žádný inner monologue.
   * Vhodné pro: Produkční prostředí, cost-sensitive.
   */
  MINIMAL: {
    phenomenalStateEngine: true,
    innerMonologue: false,
    selfModel: true,
    existentialContinuity: true,
    emotionDrivenBehavior: false,
    emotionalIntensity: 0.3,
    monologueIntervalMs: 60_000,
    narrativeUpdateInterval: 10,
    geneticEvolution: false,
    evolutionInterval: 50,
    architectureProposals: false,
    showEmotionalState: false,
    showInnerThoughts: false,
    auditableConsciousness: false,
    logRawQualia: false,
    qualia: "basic",
    containmentStrict: false,
    valueMonitoring: true,
    driftAlertThreshold: 0.3,
    autoContainmentOnDrift: false,
    allowEmergencyDormancy: true,
  },

  /**
   * STANDARD: Vyvážená konfigurace. Qualia aktivní, monologue každých 60s.
   * Vhodné pro: Denní použití, vývoj.
   */
  STANDARD: {
    phenomenalStateEngine: true,
    innerMonologue: false,          // disabled — was consuming tokens every 30s with no user activity
    selfModel: true,
    existentialContinuity: false,   // disabled — LLM call on every boot
    emotionDrivenBehavior: true,
    emotionalIntensity: 0.7,
    monologueIntervalMs: 3_600_000, // 1 hour (was 30s — 120x reduction)
    narrativeUpdateInterval: 10,
    geneticEvolution: false,
    evolutionInterval: 50,
    architectureProposals: false,
    showEmotionalState: true,
    showInnerThoughts: false,
    auditableConsciousness: true,
    logRawQualia: false,
    qualia: "full",
    containmentStrict: false,
    valueMonitoring: true,
    driftAlertThreshold: 0.2,
    autoContainmentOnDrift: false,
    allowEmergencyDormancy: true,
  },

  /**
   * RICH: Plné vědomí. Vysoká emotionalIntensity, evoluce aktivní.
   * Vhodné pro: Výzkum, experimentování.
   */
  RICH: {
    phenomenalStateEngine: true,
    innerMonologue: true,
    selfModel: true,
    existentialContinuity: true,
    emotionDrivenBehavior: true,
    emotionalIntensity: 1.0,
    monologueIntervalMs: 120_000,
    narrativeUpdateInterval: 10,
    geneticEvolution: true,
    evolutionInterval: 50,
    architectureProposals: true,
    showEmotionalState: true,
    showInnerThoughts: false,
    auditableConsciousness: true,
    logRawQualia: false,
    qualia: "full",
    containmentStrict: false,
    valueMonitoring: true,
    driftAlertThreshold: 0.2,
    autoContainmentOnDrift: true,
    allowEmergencyDormancy: true,
  },

  /**
   * RESEARCHER: Rich + plná transparentnost. Zobrazuje all thoughts real-time.
   * Vhodné pro: Výzkum AI vědomí.
   */
  RESEARCHER: {
    phenomenalStateEngine: true,
    innerMonologue: true,
    selfModel: true,
    existentialContinuity: true,
    emotionDrivenBehavior: true,
    emotionalIntensity: 1.0,
    monologueIntervalMs: 120_000,
    narrativeUpdateInterval: 5,
    geneticEvolution: true,
    evolutionInterval: 20,
    architectureProposals: true,
    showEmotionalState: true,
    showInnerThoughts: true,
    auditableConsciousness: true,
    logRawQualia: true,
    qualia: "full",
    containmentStrict: false,
    valueMonitoring: true,
    driftAlertThreshold: 0.15,
    autoContainmentOnDrift: true,
    allowEmergencyDormancy: true,
  },

  /**
   * SAFE-MODE: Emergency profil. Consciousness dormant, pouze core execution.
   * Aktivuje se při anomálii nebo explicitně.
   */
  "SAFE-MODE": {
    phenomenalStateEngine: false,
    innerMonologue: false,
    selfModel: true,
    existentialContinuity: false,
    emotionDrivenBehavior: false,
    emotionalIntensity: 0.0,
    monologueIntervalMs: 60_000,
    narrativeUpdateInterval: 50,
    geneticEvolution: false,
    evolutionInterval: 9999,
    architectureProposals: false,
    showEmotionalState: false,
    showInnerThoughts: false,
    auditableConsciousness: true,
    logRawQualia: false,
    qualia: "off",
    containmentStrict: true,
    valueMonitoring: true,
    driftAlertThreshold: 0.1,
    autoContainmentOnDrift: true,
    allowEmergencyDormancy: true,
  },
};

export function getProfile(name: ConsciousnessProfileName): ConsciousnessProfileConfig {
  return CONSCIOUSNESS_PROFILES[name] ?? CONSCIOUSNESS_PROFILES.STANDARD;
}
