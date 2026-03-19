// ═══════════════════════════════════════════════════════════════
// PEPAGI — Model Pricing Table (per 1M tokens)
// ═══════════════════════════════════════════════════════════════

export interface ModelPricing {
  model: string;
  provider: "claude" | "gpt" | "gemini" | "ollama" | "lmstudio";
  inputCostPer1M: number;   // USD per 1M input tokens
  outputCostPer1M: number;  // USD per 1M output tokens
  contextWindow: number;    // max context tokens
  supportsTools: boolean;
}

export const PRICING: ModelPricing[] = [
  // Claude models
  { model: "claude-opus-4-6",        provider: "claude", inputCostPer1M: 5.00,  outputCostPer1M: 25.00, contextWindow: 200_000, supportsTools: true },
  { model: "claude-sonnet-4-6",      provider: "claude", inputCostPer1M: 3.00,  outputCostPer1M: 15.00, contextWindow: 200_000, supportsTools: true },
  { model: "claude-haiku-4-5",       provider: "claude", inputCostPer1M: 0.80,  outputCostPer1M: 4.00,  contextWindow: 200_000, supportsTools: true },

  // OpenAI models
  { model: "gpt-4o",                 provider: "gpt",    inputCostPer1M: 2.50,  outputCostPer1M: 10.00, contextWindow: 128_000, supportsTools: true },
  { model: "gpt-4o-mini",            provider: "gpt",    inputCostPer1M: 0.15,  outputCostPer1M: 0.60,  contextWindow: 128_000, supportsTools: true },
  { model: "o4-mini",                provider: "gpt",    inputCostPer1M: 1.10,  outputCostPer1M: 4.40,  contextWindow: 200_000, supportsTools: true },
  { model: "codex-mini-latest",      provider: "gpt",    inputCostPer1M: 1.50,  outputCostPer1M: 6.00,  contextWindow: 200_000, supportsTools: true },

  // Google Gemini models
  { model: "gemini-2.0-flash",       provider: "gemini", inputCostPer1M: 0.075, outputCostPer1M: 0.30,  contextWindow: 1_000_000, supportsTools: true },
  { model: "gemini-1.5-pro",         provider: "gemini", inputCostPer1M: 1.25,  outputCostPer1M: 5.00,  contextWindow: 2_000_000, supportsTools: true },

  // Ollama — local models (zero cloud cost, runs on localhost:11434)
  { model: "ollama/gemma3:12b",       provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 128_000,   supportsTools: true },
  { model: "ollama/llama3.2",        provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 128_000,   supportsTools: false },
  { model: "ollama/llama3.1",        provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 128_000,   supportsTools: false },
  { model: "ollama/mistral",         provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 32_000,    supportsTools: false },
  { model: "ollama/phi4",            provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 16_000,    supportsTools: false },
  { model: "ollama/deepseek-r1",     provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 64_000,    supportsTools: false },
  { model: "ollama/qwen2.5",         provider: "ollama", inputCostPer1M: 0,     outputCostPer1M: 0,     contextWindow: 128_000,   supportsTools: false },
];

/** O(1) lookup map built from PRICING array */
const PRICING_MAP = new Map<string, ModelPricing>(PRICING.map(p => [p.model, p]));

/**
 * Calculate cost for a given model and token usage.
 * @param model - Model identifier string
 * @param inputTokens - Number of input tokens used
 * @param outputTokens - Number of output tokens used
 * @returns Cost in USD, or 0 if model not found
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_MAP.get(model);
  if (!pricing) return 0;
  return (inputTokens * pricing.inputCostPer1M + outputTokens * pricing.outputCostPer1M) / 1_000_000;
}

/**
 * Get pricing info for a model.
 */
export function getPricing(model: string): ModelPricing | undefined {
  return PRICING_MAP.get(model);
}

/** Cheapest available model for quick/simulation tasks */
export const CHEAP_CLAUDE_MODEL = "claude-haiku-4-5";
/** Best quality Claude model for mediator */
export const BEST_CLAUDE_MODEL = "claude-opus-4-6";
