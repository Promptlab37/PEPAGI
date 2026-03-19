// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Cost Predictor / Ticker Widget
// ═══════════════════════════════════════════════════════════════
//
// Revolution #4: Predictive cost ticker.
// Uses linear regression on costHistory to project future spend.
// Shows: current session cost, projected hourly/daily/monthly,
// projected end-of-session cost, and a trend sparkline.

import type { DashboardState } from "../state.js";
import { BaseView } from "../views/base-view.js";
import type { AnyElement } from "../views/base-view.js";
import { fmtCost, renderBar, BLOCK_CHARS } from "../theme.js";

interface CostProjection {
  cph:      number;   // cost per hour
  cpd:      number;   // cost per day
  cpmo:     number;   // cost per month
  cp7d:     number;   // cost per 7 days
  r2:       number;   // R² fit (0–1)
  slope:    number;   // cost per second
  trend:    "rising" | "falling" | "stable";
}

/** Simple linear regression on (time, cost) pairs. */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const ssxy = xs.reduce((acc, x, i) => acc + (x - mx) * ((ys[i] ?? 0) - my), 0);
  const ssxx = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
  const slope = ssxx === 0 ? 0 : ssxy / ssxx;
  const intercept = my - slope * mx;
  const ssres = ys.reduce((acc, y, i) => acc + (y - (slope * xs[i]! + intercept)) ** 2, 0);
  const sstot = ys.reduce((acc, y) => acc + (y - my) ** 2, 0);
  const r2 = sstot === 0 ? 1 : Math.max(0, 1 - ssres / sstot);
  return { slope, intercept, r2 };
}

function projectCosts(history: number[], intervalMs: number): CostProjection | null {
  if (history.length < 3) return null;
  // Build (elapsed seconds, cost) pairs
  const xs = history.map((_, i) => (i * intervalMs) / 1000);
  const { slope, r2 } = linearRegression(xs, history);

  const cps  = Math.max(0, slope);   // cost per second
  const cph  = cps * 3600;
  const cpd  = cph * 24;
  const cpmo = cpd * 30;
  const cp7d = cpd * 7;
  const trend = slope > 1e-7 ? "rising" : slope < -1e-7 ? "falling" : "stable";
  return { cph, cpd, cpmo, cp7d, r2, slope: cps, trend };
}

function renderMiniSparkline(data: number[], width: number, color: string): string {
  if (data.length === 0) return " ".repeat(width);
  const max    = Math.max(...data, 0.001);
  const points = data.slice(-width);
  const pad    = width - points.length;
  const chars  = " ".repeat(pad) + points.map(v => {
    const idx = Math.round((v / max) * (BLOCK_CHARS.length - 1));
    return BLOCK_CHARS[Math.min(idx, BLOCK_CHARS.length - 1)] ?? BLOCK_CHARS[BLOCK_CHARS.length - 1]!;
  }).join("");
  return `{${color}-fg}${chars}{/}`;
}

export class CostPredictorView extends BaseView {
  constructor(screen: AnyElement) {
    super(screen, { title: "COST PREDICTOR", fKey: "C", width: "70%", height: "75%", borderColor: "#ffd93d" });
  }

  protected renderContent(state: DashboardState): string {
    const hist    = state.costHistory;
    const proj    = projectCosts(hist, 100);  // 100ms interval matches REDRAW_INTERVAL_MS
    const sparkW  = 40;
    const sparkStr = renderMiniSparkline(hist, sparkW, "#ffd93d");

    const lines: string[] = [
      "{bold}{yellow-fg}◈ COST PREDICTOR{/bold}{/}",
      "{#666677-fg}Predictive cost projection via linear regression{/}",
      "",
      "{#888899-fg}CURRENT SESSION{/}",
      `  {yellow-fg}${fmtCost(state.sessionCost)}{/}  {#666677-fg}spent so far{/}`,
      "",
      `{#666677-fg}Cost trend:{/}  ${sparkStr}`,
      "",
    ];

    if (!proj) {
      lines.push("{#444455-fg}  Collecting data… (need ≥3 data points){/}");
      return lines.join("\n");
    }

    const trendColor  = proj.trend === "rising" ? "red" : proj.trend === "falling" ? "green" : "cyan";
    const trendArrow  = proj.trend === "rising" ? "↑" : proj.trend === "falling" ? "↓" : "→";
    const r2Color     = proj.r2 >= 0.8 ? "green" : proj.r2 >= 0.5 ? "yellow" : "#666677";
    const limitFrac   = Math.min(1, state.sessionCost / 10.0);
    const budgetBar   = renderBar(limitFrac, 1, 24);
    const budgetColor = limitFrac < 0.6 ? "green" : limitFrac < 0.85 ? "yellow" : "red";

    lines.push(
      "{#888899-fg}PROJECTIONS{/}",
      `  {#666677-fg}Per hour:{/}   {yellow-fg}${fmtCost(proj.cph)}/hr{/}`,
      `  {#666677-fg}Per day:{/}    {yellow-fg}${fmtCost(proj.cpd)}/day{/}`,
      `  {#666677-fg}Per week:{/}   {yellow-fg}${fmtCost(proj.cp7d)}/7d{/}`,
      `  {#666677-fg}Per month:{/}  {yellow-fg}${fmtCost(proj.cpmo)}/mo{/}`,
      "",
      "{#888899-fg}TREND ANALYSIS{/}",
      `  {#666677-fg}Trend:  {/}{${trendColor}-fg}${trendArrow} ${proj.trend.toUpperCase()}{/}  ` +
      `{#666677-fg}slope: {/}{${trendColor}-fg}${fmtCost(proj.slope * 3600)}/hr{/}`,
      `  {#666677-fg}Model R²:{/}  {${r2Color}-fg}${(proj.r2 * 100).toFixed(1)}%{/}  ` +
      `{#444455-fg}(${proj.r2 >= 0.8 ? "good fit" : proj.r2 >= 0.5 ? "fair fit" : "noisy data"}){/}`,
      "",
      "{#888899-fg}BUDGET STATUS{/}",
      `  {${budgetColor}-fg}${budgetBar}{/}  {yellow-fg}${(limitFrac * 100).toFixed(1)}%{/} {#666677-fg}of $10 limit{/}`,
    );

    // Time-to-limit projection
    if (proj.cph > 0) {
      const remaining = Math.max(0, 10.0 - state.sessionCost);
      const hoursLeft = remaining / proj.cph;
      const hrsStr    = hoursLeft > 24 ? `${(hoursLeft / 24).toFixed(1)}d` : `${hoursLeft.toFixed(1)}h`;
      const limColor  = hoursLeft < 1 ? "red" : hoursLeft < 4 ? "yellow" : "green";
      lines.push(`  {#666677-fg}Estimated budget remaining:{/} {${limColor}-fg}~${hrsStr} at current rate{/}`);
    }

    lines.push(
      "",
      `{#444455-fg}Data points: ${hist.length}  Tokens: ↑${state.sessionTokensIn.toLocaleString()} ↓${state.sessionTokensOut.toLocaleString()}{/}`,
    );

    return lines.join("\n");
  }
}
