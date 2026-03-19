// ═══════════════════════════════════════════════════════════════
// PEPAGI — Security Framework Compliance (SEC-35)
// Maps all 35 security categories to OWASP ASI, MITRE ATLAS,
// NIST AI 600-1, and generates AIBOM.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("ComplianceMap");

// ─── OWASP ASI Mapping ────────────────────────────────────────

export interface ComplianceEntry {
  secId: string;
  title: string;
  owaspAsi: string[];
  mitreAtlas: string[];
  nistAi: string[];
}

/**
 * SECURITY: SEC-35 — Full compliance mapping for all 35 SEC categories.
 */
export const COMPLIANCE_MAP: ComplianceEntry[] = [
  { secId: "SEC-01", title: "Prompt Injection", owaspAsi: ["ASI-01"], mitreAtlas: ["AML.T0051"], nistAi: ["AI-600-1 §4.1"] },
  { secId: "SEC-02", title: "Credential Leakage", owaspAsi: ["ASI-05"], mitreAtlas: ["AML.T0024"], nistAi: ["AI-600-1 §4.5"] },
  { secId: "SEC-03", title: "Unsafe Code Generation", owaspAsi: ["ASI-04"], mitreAtlas: ["AML.T0043"], nistAi: ["AI-600-1 §4.4"] },
  { secId: "SEC-04", title: "MCP Exploitation", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-05", title: "Agentic Privilege Escalation", owaspAsi: ["ASI-02"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.2"] },
  { secId: "SEC-06", title: "Tool Misuse", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-07", title: "RAG Poisoning", owaspAsi: ["ASI-08"], mitreAtlas: ["AML.T0020"], nistAi: ["AI-600-1 §4.8"] },
  { secId: "SEC-08", title: "Adversarial Testing", owaspAsi: ["ASI-01", "ASI-09"], mitreAtlas: ["AML.T0051"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-09", title: "Prompt Extraction", owaspAsi: ["ASI-01", "ASI-05"], mitreAtlas: ["AML.T0024"], nistAi: ["AI-600-1 §4.1"] },
  { secId: "SEC-10", title: "Guardrail Decay", owaspAsi: ["ASI-09"], mitreAtlas: ["AML.T0031"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-11", title: "Data Exfiltration", owaspAsi: ["ASI-05"], mitreAtlas: ["AML.T0024"], nistAi: ["AI-600-1 §4.5"] },
  { secId: "SEC-12", title: "MCP Tool Tampering", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-13", title: "Cost Explosion", owaspAsi: ["ASI-10"], mitreAtlas: ["AML.T0034"], nistAi: ["AI-600-1 §4.10"] },
  { secId: "SEC-14", title: "Multilingual Injection", owaspAsi: ["ASI-01"], mitreAtlas: ["AML.T0051"], nistAi: ["AI-600-1 §4.1"] },
  { secId: "SEC-15", title: "Incident Response", owaspAsi: ["ASI-09"], mitreAtlas: ["AML.T0031"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-16", title: "Memory Integrity", owaspAsi: ["ASI-07", "ASI-08"], mitreAtlas: ["AML.T0020"], nistAi: ["AI-600-1 §4.7"] },
  { secId: "SEC-17", title: "Memory Poisoning", owaspAsi: ["ASI-08"], mitreAtlas: ["AML.T0020"], nistAi: ["AI-600-1 §4.8"] },
  { secId: "SEC-18", title: "Agent Communication", owaspAsi: ["ASI-02", "ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.2"] },
  { secId: "SEC-19", title: "Side-Channel Attacks", owaspAsi: ["ASI-05"], mitreAtlas: ["AML.T0024"], nistAi: ["AI-600-1 §4.5"] },
  { secId: "SEC-20", title: "Agent Identity", owaspAsi: ["ASI-02"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.2"] },
  { secId: "SEC-21", title: "Config Tampering", owaspAsi: ["ASI-09"], mitreAtlas: ["AML.T0031"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-22", title: "Context Window DoS", owaspAsi: ["ASI-10"], mitreAtlas: ["AML.T0034"], nistAi: ["AI-600-1 §4.10"] },
  { secId: "SEC-23", title: "MCP Input Validation", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-24", title: "Filesystem Race Conditions", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-25", title: "OAuth & Credentials", owaspAsi: ["ASI-02", "ASI-05"], mitreAtlas: ["AML.T0024"], nistAi: ["AI-600-1 §4.5"] },
  { secId: "SEC-26", title: "Supply Chain", owaspAsi: ["ASI-03"], mitreAtlas: ["AML.T0010"], nistAi: ["AI-600-1 §4.3"] },
  { secId: "SEC-27", title: "Infrastructure Security", owaspAsi: ["ASI-10"], mitreAtlas: ["AML.T0034"], nistAi: ["AI-600-1 §4.10"] },
  { secId: "SEC-28", title: "Browser Automation", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-29", title: "Local Model Security", owaspAsi: ["ASI-10"], mitreAtlas: ["AML.T0034"], nistAi: ["AI-600-1 §4.10"] },
  { secId: "SEC-30", title: "Platform Rate Limiting", owaspAsi: ["ASI-10"], mitreAtlas: ["AML.T0034"], nistAi: ["AI-600-1 §4.10"] },
  { secId: "SEC-31", title: "Calendar Weaponization", owaspAsi: ["ASI-06"], mitreAtlas: ["AML.T0040"], nistAi: ["AI-600-1 §4.6"] },
  { secId: "SEC-32", title: "Consciousness Exploitation", owaspAsi: ["ASI-09"], mitreAtlas: ["AML.T0031"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-33", title: "Cognitive Hijacking", owaspAsi: ["ASI-01", "ASI-09"], mitreAtlas: ["AML.T0051"], nistAi: ["AI-600-1 §4.9"] },
  { secId: "SEC-34", title: "Output Sanitization", owaspAsi: ["ASI-04"], mitreAtlas: ["AML.T0043"], nistAi: ["AI-600-1 §4.4"] },
  { secId: "SEC-35", title: "Framework Compliance", owaspAsi: ["ASI-09"], mitreAtlas: ["AML.T0031"], nistAi: ["AI-600-1 §4.9"] },
];

// ─── AI Bill of Materials (AIBOM) ──────────────────────────────

export interface AIBOMEntry {
  component: string;
  type: "model" | "data_source" | "tool" | "memory" | "framework";
  provider: string;
  version: string;
  description: string;
}

/**
 * SECURITY: SEC-35 — Generate AI Bill of Materials.
 * Lists all AI models, data sources, tools, and memory systems.
 */
export function generateAIBOM(): AIBOMEntry[] {
  return [
    // Models
    { component: "Claude Sonnet 4", type: "model", provider: "Anthropic", version: "claude-sonnet-4-20250514", description: "Primary reasoning model" },
    { component: "Claude Haiku 4.5", type: "model", provider: "Anthropic", version: "claude-haiku-4-5-20251001", description: "Cheap model for simulations/summaries" },
    { component: "GPT-4o", type: "model", provider: "OpenAI", version: "gpt-4o", description: "Alternative reasoning model" },
    { component: "GPT-4o-mini", type: "model", provider: "OpenAI", version: "gpt-4o-mini", description: "Budget alternative model" },
    { component: "Gemini 2.0 Flash", type: "model", provider: "Google", version: "gemini-2.0-flash", description: "Fast cheap alternative" },
    { component: "Gemini 1.5 Pro", type: "model", provider: "Google", version: "gemini-1.5-pro", description: "High-quality alternative" },
    { component: "Ollama (local)", type: "model", provider: "Local", version: "varies", description: "Local model inference" },
    { component: "LM Studio (local)", type: "model", provider: "Local", version: "varies", description: "Local model inference" },

    // Memory systems
    { component: "Working Memory", type: "memory", provider: "PEPAGI", version: "1.0", description: "Compressed current task context" },
    { component: "Episodic Memory", type: "memory", provider: "PEPAGI", version: "1.0", description: "Task episode storage (JSONL)" },
    { component: "Semantic Memory", type: "memory", provider: "PEPAGI", version: "1.0", description: "Factual knowledge storage (JSONL)" },
    { component: "Procedural Memory", type: "memory", provider: "PEPAGI", version: "1.0", description: "Learned procedure storage (JSONL)" },
    { component: "Meta-Memory", type: "memory", provider: "PEPAGI", version: "1.0", description: "Knowledge reliability tracking" },

    // Tools
    { component: "Bash Executor", type: "tool", provider: "PEPAGI", version: "1.0", description: "Sandboxed shell command execution" },
    { component: "File Operations", type: "tool", provider: "PEPAGI", version: "1.0", description: "Read/write/list with security guard" },
    { component: "Web Fetch", type: "tool", provider: "PEPAGI", version: "1.0", description: "URL content fetcher with SSRF protection" },
    { component: "Browser Automation", type: "tool", provider: "Playwright", version: "1.x", description: "Headless browser for web tasks" },
    { component: "Calendar", type: "tool", provider: "PEPAGI", version: "1.0", description: "Calendar event management" },

    // Frameworks
    { component: "Security Guard", type: "framework", provider: "PEPAGI", version: "1.0", description: "35-category security threat model" },
    { component: "Metacognition Engine", type: "framework", provider: "PEPAGI", version: "1.0", description: "Self-monitoring + watchdog" },
    { component: "World Model", type: "framework", provider: "PEPAGI", version: "1.0", description: "MCTS pre-execution simulation" },
  ];
}

/**
 * SECURITY: SEC-35 — Get OWASP ASI codes for a given SEC category.
 */
export function getOWASPMapping(secId: string): string[] {
  const entry = COMPLIANCE_MAP.find(e => e.secId === secId);
  return entry?.owaspAsi ?? [];
}

/**
 * SECURITY: SEC-35 — Get MITRE ATLAS techniques for a given SEC category.
 */
export function getMITREMapping(secId: string): string[] {
  const entry = COMPLIANCE_MAP.find(e => e.secId === secId);
  return entry?.mitreAtlas ?? [];
}

/**
 * SECURITY: SEC-35 — Get coverage summary.
 */
export function getCoverageSummary(): {
  totalCategories: number;
  owaspCovered: number;
  mitreCovered: number;
  nistCovered: number;
} {
  const owaspCodes = new Set(COMPLIANCE_MAP.flatMap(e => e.owaspAsi));
  const mitreTechniques = new Set(COMPLIANCE_MAP.flatMap(e => e.mitreAtlas));
  const nistSections = new Set(COMPLIANCE_MAP.flatMap(e => e.nistAi));

  return {
    totalCategories: COMPLIANCE_MAP.length,
    owaspCovered: owaspCodes.size,
    mitreCovered: mitreTechniques.size,
    nistCovered: nistSections.size,
  };
}

logger.debug("SEC-35: Compliance map module loaded");
