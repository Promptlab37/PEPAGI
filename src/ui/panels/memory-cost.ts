// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Memory & Economics Panel
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { fmtCost, fmtTokens, fmtUptime, renderBar, costColor, BLOCK_CHARS, MAX_SPARKLINE_POINTS } from "../theme.js";
import { blessed } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

function renderSparkline(data: number[], width: number): string {
  if (data.length === 0) return " ".repeat(width);
  const max    = Math.max(...data, 0.001);
  const points = data.slice(-width);
  const pad    = width - points.length;
  return " ".repeat(pad) + points.map(v => {
    const idx = Math.round((v / max) * (BLOCK_CHARS.length - 1));
    return BLOCK_CHARS[idx] ?? BLOCK_CHARS[BLOCK_CHARS.length - 1]!;
  }).join("");
}

function estimateCostPerHour(history: number[]): number {
  if (history.length < 2) return 0;
  const last = history.slice(-60);
  if (last.length < 2) return 0;
  const delta    = (last[last.length - 1]! - last[0]!);
  const intervalH = (last.length * 0.1) / 3600;
  return intervalH <= 0 ? 0 : delta / intervalH;
}

export class MemoryCostPanel {
  private box:     AnyElement;
  private content: AnyElement;
  private title = " ECONOMICS ";

  constructor(
    parent: AnyElement,
    geom: { top: number; left: number; width: number; height: number },
  ) {
    this.box = blessed.box({
      parent, top: geom.top, left: geom.left,
      width: geom.width, height: geom.height,
      tags: true,
      border: { type: "line", fg: "#3a3a4a" },
      label: ` {gold-fg}$ ${this.title}{/} `,
      style: { fg: "white", bg: "black", border: { fg: "#3a3a4a" } },
    });
    this.content = blessed.box({
      parent: this.box, top: 1, left: 1,
      width: "100%-4", height: "100%-2",
      tags: true, scrollable: false,
      style: { fg: "white", bg: "black" },
    });
  }

  update(state: DashboardState): void {
    if (state.paused) return;

    const innerW   = Math.max(18, (this.box.width ?? 28) - 6);
    const sparkW   = Math.max(10, innerW - 2);
    const costData = state.costHistory.slice(-MAX_SPARKLINE_POINTS);
    const sparkStr = renderSparkline(costData, sparkW);
    const cph      = estimateCostPerHour(costData);
    const cpd      = cph * 24;
    const cphColor = cph < 0.05 ? "green" : cph < 0.20 ? "yellow" : "red";
    const limit    = 10.0;
    const pct      = Math.min(1, state.sessionCost / limit);
    const bar      = renderBar(pct, 1, Math.max(6, sparkW - 6));
    const barC     = costColor(pct);

    const lines: string[] = [
      `{#666677-fg}Session Cost{/}`,
      `  {yellow-fg}${fmtCost(state.sessionCost)}{/}  {#666677-fg}/ ${fmtCost(limit)}{/}`,
      `  ${barC}${bar}{/}`,
      "",
      `{#666677-fg}Rate{/}`,
      `  {${cphColor}-fg}${fmtCost(cph)}/hr{/}  {#666677-fg}≈ ${fmtCost(cpd)}/day{/}  {#444455-fg}≈ ${fmtCost(cph * 24 * 30)}/mo{/}`,
      "",
      `{#666677-fg}Tokens{/}`,
      `  {blue-fg}↑${fmtTokens(state.sessionTokensIn)}{/} {purple-fg}↓${fmtTokens(state.sessionTokensOut)}{/}`,
      "",
      `{#666677-fg}Cost trend{/}`,
      `  {#ffd93d-fg}${sparkStr}{/}`,
      "",
    ];

    // Per-agent cost breakdown
    const agentTotals = [...state.agents.values()].filter(a => a.costTotal > 0);
    if (agentTotals.length > 0) {
      const totalCost = agentTotals.reduce((s, a) => s + a.costTotal, 0) || 0.001;
      lines.push("{#666677-fg}By Agent{/}");
      for (const a of agentTotals.sort((x, y) => y.costTotal - x.costTotal)) {
        const pct2  = a.costTotal / totalCost;
        const bW    = Math.max(4, Math.floor(sparkW / 3));
        const bBar  = renderBar(pct2, 1, bW);
        lines.push(
          `  {#888899-fg}${a.provider.slice(0, 6).padEnd(6)}{/} ` +
          `{yellow-fg}${fmtCost(a.costTotal)}{/} ` +
          `{#3a3a4a-fg}${bBar}{/} {#666677-fg}${(pct2 * 100).toFixed(0)}%{/}`,
        );
      }
      lines.push("");
    }

    // Memory stats — L1-L5 visual bars + sparklines
    const ms   = state.memoryStats;
    const mh   = state.memoryLevelHistory;
    const bW   = Math.max(6, Math.floor(innerW / 2));
    const spW  = Math.max(6, Math.floor(innerW / 4));
    lines.push("{#666677-fg}Memory Levels{/}");
    if (ms.lastLoaded > 0) {
      const memLevels: Array<{ label: string; count: number; max: number; color: string; hist: number[] }> = [
        { label: "L1 Working  ", count: 1,                         max: 1,   color: "cyan",    hist: [] },
        { label: "L2 Episodic ", count: ms.episodes,               max: 100, color: "blue",    hist: mh.l2 },
        { label: "L3 Semantic ", count: ms.facts,                  max: 500, color: "#5c8aff", hist: mh.l3 },
        { label: "L4 Procedural", count: ms.procedures + ms.skills, max: 50, color: "purple",  hist: mh.l4 },
        { label: "L5 Meta     ", count: ms.skills,                 max: 50,  color: "#c084fc", hist: mh.l5 },
      ];
      for (const lvl of memLevels) {
        const pct = Math.min(1, lvl.count / lvl.max);
        const bar = renderBar(pct, 1, bW);
        const spark = lvl.hist.length > 1 ? renderSparkline(lvl.hist, spW) : " ".repeat(spW);
        lines.push(
          `  {#666677-fg}${lvl.label}{/} {${lvl.color}-fg}${bar}{/} {white-fg}${lvl.count}{/}` +
          (spark.trim() ? ` {#444455-fg}${spark}{/}` : ""),
        );
      }
    } else {
      lines.push("  {#444455-fg}loading…{/}");
    }
    // Extra memory counters
    lines.push("{#666677-fg}Memory Details{/}");
    lines.push(
      `  {#888899-fg}Working:{/}  {cyan-fg}${ms.working}{/}  {#444455-fg}items{/}`,
      `  {#888899-fg}Vectors:  {/}{#5c8aff-fg}${ms.vectors}{/}  {#444455-fg}files{/}`,
      `  {#888899-fg}Decayed:  {/}{${ms.decayedFacts > 0 ? "yellow" : "green"}-fg}${ms.decayedFacts}{/}  {#444455-fg}low-conf facts{/}`,
    );

    lines.push(
      "",
      `{#666677-fg}Uptime{/}`,
      `  {cyan-fg}${fmtUptime(state.startTime)}{/}`,
      "",
      `{#666677-fg}Done / Failed{/}`,
      `  {green-fg}${state.totalCompleted}{/} / {red-fg}${state.totalFailed}{/}`,
    );

    this.content.setContent(lines.join("\n"));
  }

  focus(): void { this.box.style.border = { fg: "cyan" }; this.box.setLabel(` {gold-fg}$ ${this.title}{/} ← `); }
  blur():  void { this.box.style.border = { fg: "#3a3a4a" }; this.box.setLabel(` {gold-fg}$ ${this.title}{/} `); }
  getElement(): AnyElement { return this.box; }
}
