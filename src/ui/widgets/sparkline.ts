// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Sparkline Utility
// ═══════════════════════════════════════════════════════════════
//
// Reusable inline sparkline renderer using Unicode block chars.
// Returns a blessed-tagged string ready for use in any panel.

import { BLOCK_CHARS } from "../theme.js";

export interface SparklineOptions {
  width:     number;   // number of columns
  maxValue?: number;   // auto-computed if omitted
  color?:    string;   // blessed color tag, e.g. "cyan" or "#ffd93d"
  label?:    string;   // optional prefix label
}

/**
 * Render a sparkline from an array of numbers.
 * Returns a blessed-tagged string with the sparkline.
 */
export function renderSparkline(data: number[], opts: SparklineOptions): string {
  const { width, color = "#ffd93d", label = "" } = opts;
  if (data.length === 0) return label + " ".repeat(width);

  const maxValue = opts.maxValue ?? Math.max(...data, 0.001);
  const points   = data.slice(-width);
  const pad      = width - points.length;
  const chars    = " ".repeat(pad) + points.map(v => {
    const idx = Math.round((Math.max(0, v) / maxValue) * (BLOCK_CHARS.length - 1));
    return BLOCK_CHARS[Math.min(idx, BLOCK_CHARS.length - 1)] ?? BLOCK_CHARS[BLOCK_CHARS.length - 1]!;
  }).join("");

  const labelStr = label ? `{#888899-fg}${label}{/} ` : "";
  return `${labelStr}{${color}-fg}${chars}{/}`;
}

/**
 * Render a labelled multi-row sparkline section.
 * Each entry: { label, data, color }
 */
export function renderSparklineGroup(
  entries: Array<{ label: string; data: number[]; color: string }>,
  width: number,
): string[] {
  return entries.map(e =>
    `  {#666677-fg}${e.label.padEnd(14)}{/} ${renderSparkline(e.data, { width, color: e.color })}`,
  );
}
