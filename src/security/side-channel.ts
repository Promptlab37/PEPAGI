// ═══════════════════════════════════════════════════════════════
// PEPAGI — Side-Channel Attack Mitigation (SEC-19)
// Response padding, timing jitter, and metadata sanitization
// to prevent traffic analysis and timing attacks.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";

const logger = new Logger("SideChannel");

// SECURITY: SEC-19 — Fixed chunk size for response padding (512 bytes)
const PAD_CHUNK_SIZE = 512;

// SECURITY: SEC-19 — Timing jitter range in ms
const JITTER_MIN_MS = 10;
const JITTER_MAX_MS = 50;

/**
 * SECURITY: SEC-19 — Pad response content to fixed-size chunks.
 * Prevents response size from revealing prompt topics via traffic analysis.
 * Padding uses null bytes stripped by the receiver.
 */
export function padResponse(content: string): string {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const paddedSize = Math.ceil(contentBytes / PAD_CHUNK_SIZE) * PAD_CHUNK_SIZE;
  if (paddedSize <= contentBytes) return content;
  // Add whitespace padding (stripped by trim on receiver)
  const paddingNeeded = paddedSize - contentBytes;
  return content + " ".repeat(paddingNeeded);
}

/**
 * SECURITY: SEC-19 — Get padded byte length for a response.
 * External APIs should report this size instead of actual content size.
 */
export function getPaddedSize(content: string): number {
  const contentBytes = Buffer.byteLength(content, "utf8");
  return Math.ceil(contentBytes / PAD_CHUNK_SIZE) * PAD_CHUNK_SIZE;
}

/**
 * SECURITY: SEC-19 — Generate random timing jitter.
 * Prevents timing analysis that could reveal model choice or task complexity.
 * @returns Jitter in milliseconds (10-50ms)
 */
export function getTimingJitter(): number {
  return JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
}

/**
 * SECURITY: SEC-19 — Apply timing jitter as a delay.
 * Use before returning LLM responses to external consumers.
 */
export async function applyTimingJitter(): Promise<void> {
  const jitter = getTimingJitter();
  await new Promise(resolve => setTimeout(resolve, jitter));
}

/**
 * SECURITY: SEC-19 — Sanitize latency metrics for external exposure.
 * Quantizes latency to prevent timing analysis.
 * @param actualMs - Real latency in ms
 * @returns Quantized latency (rounded to nearest 100ms)
 */
export function sanitizeLatency(actualMs: number): number {
  return Math.ceil(actualMs / 100) * 100;
}

/**
 * SECURITY: SEC-19 — Sanitize LLM response metadata before external exposure.
 * Removes or generalizes fields that could reveal internal architecture.
 */
export function sanitizeResponseMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  // Allow these fields but sanitize values
  if (typeof meta["latencyMs"] === "number") {
    sanitized["latencyMs"] = sanitizeLatency(meta["latencyMs"] as number);
  }

  // Generalize model info (don't reveal exact model version)
  if (typeof meta["model"] === "string") {
    const model = meta["model"] as string;
    if (model.includes("claude")) sanitized["model"] = "claude";
    else if (model.includes("gpt")) sanitized["model"] = "gpt";
    else if (model.includes("gemini")) sanitized["model"] = "gemini";
    else sanitized["model"] = "unknown";
  }

  // Don't expose exact token counts externally
  if (meta["usage"] && typeof meta["usage"] === "object") {
    sanitized["usage"] = { approximate: true };
  }

  return sanitized;
}

/**
 * SECURITY: SEC-19 — Batch token counts to fixed ranges.
 * Prevents exact token count from revealing prompt content.
 */
export function batchTokenCount(actual: number, batchSize = 100): number {
  return Math.ceil(actual / batchSize) * batchSize;
}

logger.debug("SEC-19: Side-channel mitigation module loaded");
