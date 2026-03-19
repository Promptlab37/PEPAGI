// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Adaptive Layout Engine
// ═══════════════════════════════════════════════════════════════
//
// Computes panel sizes and positions based on terminal dimensions.
// Reflow triggers when terminal is resized (SIGWINCH).

// ── Layout modes ──────────────────────────────────────────────

export type LayoutMode = "ultrawide" | "wide" | "standard" | "compact" | "minimal";

/** Returns layout mode based on terminal width */
export function detectMode(cols: number): LayoutMode {
  if (cols >= 220) return "ultrawide";
  if (cols >= 160) return "wide";
  if (cols >= 120) return "standard";
  if (cols >= 80)  return "compact";
  return "minimal";
}

// ── Panel geometry ────────────────────────────────────────────
//
// All values expressed as integer character counts (cols) or rows.
// Panels are placed with absolute top/left + width/height.

export interface PanelGeom {
  top:    number;   // row offset from screen top
  left:   number;   // col offset from screen left
  width:  number;   // cols
  height: number;   // rows
}

export interface LayoutGeometry {
  mode:       LayoutMode;
  screenCols: number;
  screenRows: number;
  topBar:     PanelGeom;
  bottomBar:  PanelGeom;
  neural:     PanelGeom;
  consciousness: PanelGeom;
  pipeline:   PanelGeom;
  agentPool:  PanelGeom;
  memoryCost: PanelGeom;
}

export function computeLayout(cols: number, rows: number): LayoutGeometry {
  const mode     = detectMode(cols);
  const topH     = 3;
  const botH     = 3;
  const mainTop  = topH;
  const mainH    = rows - topH - botH;

  const topBar:    PanelGeom = { top: 0,    left: 0,    width: cols, height: topH };
  const bottomBar: PanelGeom = { top: rows - botH, left: 0, width: cols, height: botH };

  // Right sidebar (agents + cost) width
  const sideW = mode === "ultrawide" ? 38
              : mode === "wide"      ? 34
              : mode === "standard"  ? 30
              : mode === "compact"   ? 26
              : 24;

  // Consciousness panel width
  const consW = mode === "ultrawide" ? 28
              : mode === "wide"      ? 26
              : mode === "standard"  ? 24
              : mode === "compact"   ? 22
              : 20;

  // Neural stream width
  const neuralW = mode === "ultrawide" ? 40
                : mode === "wide"      ? 34
                : mode === "standard"  ? 28
                : mode === "compact"   ? 24
                : 20;

  // Pipeline fills the rest
  const pipelineW = cols - neuralW - consW - sideW;

  // Right sidebar split: top 60% agents, bottom 40% cost
  const agentH     = Math.floor(mainH * 0.6);
  const costH      = mainH - agentH;

  return {
    mode, screenCols: cols, screenRows: rows,
    topBar, bottomBar,
    neural:      { top: mainTop, left: 0,                         width: neuralW,    height: mainH },
    consciousness: { top: mainTop, left: neuralW,                 width: consW,      height: mainH },
    pipeline:    { top: mainTop, left: neuralW + consW,           width: pipelineW,  height: mainH },
    agentPool:   { top: mainTop, left: neuralW + consW + pipelineW, width: sideW,   height: agentH },
    memoryCost:  { top: mainTop + agentH, left: neuralW + consW + pipelineW, width: sideW, height: costH },
  };
}

// ── Visibility helpers ────────────────────────────────────────

/**
 * Returns true if a panel should be visible given the current layout mode.
 * In compact/minimal modes some panels are hidden to save space.
 */
export function isPanelVisible(panel: keyof Omit<LayoutGeometry, "mode" | "screenCols" | "screenRows">, mode: LayoutMode): boolean {
  if (mode === "ultrawide" || mode === "wide") return true;
  if (mode === "standard") return panel !== "memoryCost"; // merged into agentPool
  if (mode === "compact")  return panel === "neural" || panel === "pipeline" || panel === "topBar" || panel === "bottomBar";
  // minimal: only neural + top/bottom bars
  return panel === "neural" || panel === "topBar" || panel === "bottomBar";
}
