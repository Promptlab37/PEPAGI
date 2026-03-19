// ═══════════════════════════════════════════════════════════════
// PEPAGI — Safe JSON parser for LLM responses
// Strips markdown code fences (```json ... ```) before parsing
// ═══════════════════════════════════════════════════════════════

/**
 * Parse JSON from an LLM response that may be wrapped in markdown code fences.
 * Handles: ```json\n{...}\n```, ```\n{...}\n```, or plain JSON.
 */
export function parseLLMJson<T = unknown>(raw: string): T {
  let cleaned = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` wrappers
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }
  return JSON.parse(cleaned) as T;
}
