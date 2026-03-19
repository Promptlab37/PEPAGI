// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Gauge Widget
// ═══════════════════════════════════════════════════════════════
//
// Renders single-line and arc-style gauges as blessed strings.

import { renderBar } from "../theme.js";

export interface GaugeOptions {
  value:    number;   // 0–1
  width?:   number;   // bar width, default 20
  label?:   string;
  showPct?: boolean;
  colorFn?: (v: number) => string;  // returns blessed color name
}

const defaultColorFn = (v: number): string =>
  v >= 0.75 ? "green" : v >= 0.45 ? "yellow" : "red";

/**
 * Render a horizontal gauge bar as a blessed-tagged string.
 */
export function renderGauge(opts: GaugeOptions): string {
  const { value, width = 20, label = "", showPct = true, colorFn = defaultColorFn } = opts;
  const clamped = Math.max(0, Math.min(1, value));
  const color   = colorFn(clamped);
  const bar     = renderBar(clamped, 1, width);
  const pctStr  = showPct ? ` {${color}-fg}${(clamped * 100).toFixed(0).padStart(3)}%{/}` : "";
  const lbl     = label ? `{#888899-fg}${label}{/} ` : "";
  return `${lbl}{${color}-fg}${bar}{/}${pctStr}`;
}

/**
 * Render a compact arc-style gauge using Unicode arc chars.
 * Suitable for small spaces (displays as ◔◑◕● etc.)
 */
export function renderArcGauge(value: number, label?: string): string {
  const clamped = Math.max(0, Math.min(1, value));
  const ARCS    = ["○", "◔", "◑", "◕", "●"];
  const idx     = Math.round(clamped * (ARCS.length - 1));
  const arc     = ARCS[idx] ?? "○";
  const color   = defaultColorFn(clamped);
  const pct     = `${(clamped * 100).toFixed(0)}%`;
  const lbl     = label ? `{#888899-fg}${label}{/} ` : "";
  return `${lbl}{${color}-fg}${arc} ${pct}{/}`;
}

/**
 * Render a row of labelled arc gauges.
 */
export function renderGaugeRow(
  gauges: Array<{ label: string; value: number }>,
): string {
  return gauges.map(g => renderArcGauge(g.value, g.label)).join("  ");
}
