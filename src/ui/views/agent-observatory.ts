// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F4: Agent Observatory
// ═══════════════════════════════════════════════════════════════

import type { DashboardState, AgentStat } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { fmtCost, fmtTokens, renderBar, renderBarColor, renderBarReset } from "../theme.js";

const AGENT_COLORS: Record<string, string> = {
  claude: "cyan", gpt: "green", gemini: "blue", ollama: "yellow", lmstudio: "magenta",
};

function latencyHistogram(latencies: number[], width: number): string {
  if (latencies.length === 0) return "{#444455-fg}no data{/}";
  const max    = Math.max(...latencies);
  const blocks = " ▁▂▃▄▅▆▇█";
  return latencies.slice(-width).map(v => blocks[Math.round((v / max) * 7)] ?? "█").join("");
}

function successRate(a: AgentStat): { pct: number | null; color: string; str: string } {
  if (a.requestsTotal === 0) return { pct: null, color: "#666677", str: "—" };
  const pct = (a.requestsTotal - a.errorCount) / a.requestsTotal;
  const color = pct >= 0.9 ? "green" : pct >= 0.7 ? "yellow" : "red";
  return { pct, color, str: `${(pct * 100).toFixed(0)}%` };
}

function renderAgentCard(a: AgentStat, idx: number, total: number): string[] {
  const color  = AGENT_COLORS[a.provider] ?? "white";
  const dot    = a.available ? "{green-fg}●{/}" : "{red-fg}●{/}";
  const last5  = a.latencyMs.slice(-5);
  const avgLat = last5.length ? Math.round(last5.reduce((s, v) => s + v, 0) / last5.length) : 0;
  const minLat = last5.length ? Math.min(...last5) : 0;
  const maxLat = last5.length ? Math.max(...last5) : 0;
  const latColor = avgLat < 1000 ? "green" : avgLat < 3000 ? "yellow" : "red";
  const eff    = a.tokensIn  > 0 ? (a.tokensOut / a.tokensIn).toFixed(2) : "—";
  const cPerK  = a.tokensOut > 0 ? fmtCost(a.costTotal / (a.tokensOut / 1000)) : "—";
  const sr     = successRate(a);
  const errRate = a.requestsTotal > 0 ? a.errorCount / a.requestsTotal : 0;
  const cbTag  = errRate >= 0.5 && a.errorCount >= 3 ? "{bold}{red-fg}[CB:OPEN]{/bold}{/}"
               : errRate >= 0.3 && a.errorCount >= 2 ? "{yellow-fg}[CB:HALF]{/}"
               : "{green-fg}[CB:OK]{/}";
  const loadPct = Math.min(1, a.requestsActive / 3);

  return [
    `{#666677-fg}[ ${idx + 1} / ${total} ]  ← → navigate  Home=fleet  ↑↓=scroll{/}`,
    "",
    `${dot} {bold}{${color}-fg}${a.provider.toUpperCase()}{/bold}{/}  {#666677-fg}${a.model}{/}  ${cbTag}`,
    `  {#888899-fg}${"─".repeat(48)}{/}`,
    `  {#666677-fg}Requests{/}  total {white-fg}${a.requestsTotal}{/}  active {cyan-fg}${a.requestsActive}{/}  errors {red-fg}${a.errorCount}{/}`,
    `  {#666677-fg}Success {/}  {${sr.color}-fg}${sr.str}{/}  ${renderBarColor(sr.pct ?? 0)}${renderBar(sr.pct ?? 0, 1, 20)}${renderBarReset()}`,
    `  {#666677-fg}Latency {/}  avg {${latColor}-fg}${avgLat}ms{/}  min {green-fg}${minLat}ms{/}  max {red-fg}${maxLat}ms{/}`,
    `  {#666677-fg}Histogram{/} {cyan-fg}${latencyHistogram(a.latencyMs, 30)}{/}`,
    `  {#666677-fg}Load    {/}  ${renderBarColor(loadPct)}${renderBar(loadPct, 1, 24)}${renderBarReset()} {cyan-fg}${a.requestsActive}{/} active`,
    `  {#888899-fg}${"─".repeat(48)}{/}`,
    `  {#666677-fg}Tokens  {/}  in {blue-fg}${fmtTokens(a.tokensIn)}{/}  out {purple-fg}${fmtTokens(a.tokensOut)}{/}  ratio {cyan-fg}${eff}{/}`,
    `  {#666677-fg}Cost    {/}  total {yellow-fg}${fmtCost(a.costTotal)}{/}  per-1k-out {yellow-fg}${cPerK}{/}`,
    `  {#666677-fg}Last used{/} {#888899-fg}${a.lastUsed ? new Date(a.lastUsed).toLocaleTimeString("en-GB") : "never"}{/}`,
  ];
}

function renderFleetOverview(state: DashboardState, agents: AgentStat[]): string[] {
  const lines: string[] = [
    "{#666677-fg}Fleet overview  → first card  ↑↓=scroll{/}",
    "",
    `{#888899-fg}${"AGENT".padEnd(12)} ${"STATUS".padEnd(8)} ${"SR".padEnd(6)} ${"REQ".padEnd(6)} ${"ERR".padEnd(5)} ${"LAT".padEnd(7)} ${"COST".padEnd(9)}{/}`,
    `{#3a3a4a-fg}${"─".repeat(60)}{/}`,
  ];

  for (const a of agents) {
    const color = AGENT_COLORS[a.provider] ?? "white";
    const dot   = a.available ? "{green-fg}●{/}" : "{red-fg}●{/}";
    const sr    = successRate(a);
    const last5 = a.latencyMs.slice(-5);
    const avgLat = last5.length ? Math.round(last5.reduce((s, v) => s + v, 0) / last5.length) : 0;
    const latC  = avgLat < 1000 ? "green" : avgLat < 3000 ? "yellow" : "red";
    lines.push(
      `${dot} {${color}-fg}${a.provider.padEnd(10)}{/} ` +
      `{${a.available ? "green" : "red"}-fg}${(a.available ? "online" : "offline").padEnd(7)}{/} ` +
      `{${sr.color}-fg}${sr.str.padEnd(5)}{/} ` +
      `{white-fg}${String(a.requestsTotal).padEnd(5)}{/} ` +
      `{red-fg}${String(a.errorCount).padEnd(4)}{/} ` +
      `{${latC}-fg}${(avgLat + "ms").padEnd(6)}{/} ` +
      `{yellow-fg}${fmtCost(a.costTotal)}{/}`,
    );
  }

  const online    = agents.filter(a => a.available).length;
  const totalCost = agents.reduce((s, a) => s + a.costTotal, 0);
  const totalTok  = agents.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0);
  lines.push(
    `{#3a3a4a-fg}${"─".repeat(60)}{/}`,
    `{#888899-fg}Fleet:{/} {green-fg}${online}{/}/${agents.length} online  ` +
    `cost {yellow-fg}${fmtCost(totalCost)}{/}  tokens {blue-fg}${fmtTokens(totalTok)}{/}`,
  );

  const stateInfo = `  Active tasks: {cyan-fg}${state.activeTasks.size}{/}  ` +
    `Done: {green-fg}${state.totalCompleted}{/}  Failed: {red-fg}${state.totalFailed}{/}`;
  lines.push(stateInfo);
  return lines;
}

function renderCompareSide(a: AgentStat, label: string): string[] {
  const color   = AGENT_COLORS[a.provider] ?? "white";
  const dot     = a.available ? "{green-fg}●{/}" : "{red-fg}●{/}";
  const sr      = successRate(a);
  const last5   = a.latencyMs.slice(-5);
  const avgLat  = last5.length ? Math.round(last5.reduce((s, v) => s + v, 0) / last5.length) : 0;
  const latC    = avgLat < 1000 ? "green" : avgLat < 3000 ? "yellow" : "red";
  const errRate = a.requestsTotal > 0 ? a.errorCount / a.requestsTotal : 0;
  const cbTag   = errRate >= 0.5 ? "{red-fg}CB:OPEN{/}" : errRate >= 0.3 ? "{yellow-fg}CB:HALF{/}" : "{green-fg}CB:OK{/}";

  return [
    `{bold}[${label}] ${dot} {${color}-fg}${a.provider.toUpperCase()}{/bold}{/}`,
    `{#666677-fg}${a.model}{/}  ${cbTag}`,
    "",
    `{#666677-fg}Requests:  {/}{white-fg}${a.requestsTotal}{/}  err {red-fg}${a.errorCount}{/}  act {cyan-fg}${a.requestsActive}{/}`,
    `{#666677-fg}Success:   {/}{${sr.color}-fg}${sr.str}{/}  ${renderBar(sr.pct ?? 0, 1, 18)}`,
    `{#666677-fg}Avg lat:   {/}{${latC}-fg}${avgLat}ms{/}`,
    `{#666677-fg}Histogram: {/}{cyan-fg}${latencyHistogram(a.latencyMs, 18)}{/}`,
    "",
    `{#666677-fg}Tokens in: {/}{blue-fg}${fmtTokens(a.tokensIn)}{/}`,
    `{#666677-fg}Tokens out:{/}{purple-fg}${fmtTokens(a.tokensOut)}{/}`,
    `{#666677-fg}Cost:      {/}{yellow-fg}${fmtCost(a.costTotal)}{/}`,
    `{#666677-fg}Last used: {/}{#888899-fg}${a.lastUsed ? new Date(a.lastUsed).toLocaleTimeString("en-GB") : "never"}{/}`,
  ];
}

export class AgentObservatoryView extends BaseView {
  private cardIdx     = -1;   // -1 = fleet overview, 0..n-1 = individual card
  private compareMode = false;
  private compareIdxA = 0;
  private compareIdxB = 1;

  constructor(screen: AnyElement) {
    super(screen, { title: "AGENT OBSERVATORY", fKey: "F4", width: "85%", height: "85%", borderColor: "green" });

    this.content.key("left",  () => {
      if (this.compareMode) { this.compareIdxA = Math.max(0, this.compareIdxA - 1); return; }
      this.cardIdx = this.cardIdx <= 0 ? -1 : this.cardIdx - 1;
    });
    this.content.key("right", () => {
      if (this.compareMode) { this.compareIdxA++; return; }
      this.cardIdx++;
    });   // clamped in renderContent
    this.content.key("home",  () => {
      if (this.compareMode) { this.compareIdxA = 0; this.compareIdxB = 1; return; }
      this.cardIdx = -1;
    }); // back to fleet
    this.content.key("c", () => {
      this.compareMode = !this.compareMode;
      if (this.compareMode) { this.compareIdxA = 0; this.compareIdxB = 1; }
    });
    // Tab shifts the B side in compare mode
    this.content.key("tab", () => {
      if (this.compareMode) this.compareIdxB++;
    });
  }

  protected renderContent(state: DashboardState): string {
    const agents = [...state.agents.values()];
    const lines:  string[] = ["{bold}{green-fg}◈ AGENT OBSERVATORY{/bold}{/}", ""];

    if (agents.length === 0) {
      lines.push("{#444455-fg}  No agents configured. Check ~/.pepagi/config.json{/}");
      return lines.join("\n");
    }

    // Clamp card index
    if (this.cardIdx >= agents.length) this.cardIdx = agents.length - 1;

    // ── Compare mode ─────────────────────────────────────────
    if (this.compareMode) {
      if (this.compareIdxA >= agents.length) this.compareIdxA = agents.length - 1;
      if (this.compareIdxB >= agents.length) this.compareIdxB = 0;
      if (this.compareIdxB === this.compareIdxA) this.compareIdxB = (this.compareIdxA + 1) % agents.length;

      const aAgent = agents[this.compareIdxA]!;
      const bAgent = agents[this.compareIdxB]!;
      lines.push(`{#666677-fg}Compare mode  ← → = shift A  Tab = shift B  c = exit  [{/}{cyan-fg}A: ${aAgent.provider}{/}{#666677-fg}] vs [{/}{green-fg}B: ${bAgent.provider}{/}{#666677-fg}]{/}`);
      lines.push("{#3a3a4a-fg}" + "─".repeat(70) + "{/}");

      const linesA = renderCompareSide(aAgent, "A");
      const linesB = renderCompareSide(bAgent, "B");
      const maxLen = Math.max(linesA.length, linesB.length);
      const colW   = 36;
      const SEP    = "  {#3a3a4a-fg}│{/}  ";

      for (let i = 0; i < maxLen; i++) {
        const la = linesA[i] ?? "";
        const lb = linesB[i] ?? "";
        // Plain text width approx: strip blessed tags for padding
        const laPad = la.padEnd ? la.padEnd(colW) : la;
        lines.push(`${laPad}${SEP}${lb}`);
      }

      // Diff summary
      lines.push("");
      lines.push("{#888899-fg}COMPARISON DELTA{/}");
      const srA  = successRate(aAgent);
      const srB  = successRate(bAgent);
      const latA = aAgent.latencyMs.slice(-5);
      const latB = bAgent.latencyMs.slice(-5);
      const avgA = latA.length ? Math.round(latA.reduce((s, v) => s + v, 0) / latA.length) : 0;
      const avgB = latB.length ? Math.round(latB.reduce((s, v) => s + v, 0) / latB.length) : 0;
      const betterSR  = (srA.pct ?? 0) >= (srB.pct ?? 0) ? "A" : "B";
      const betterLat = avgA <= avgB ? "A" : "B";
      const betterCost = aAgent.costTotal <= bAgent.costTotal ? "A" : "B";
      lines.push(
        `  {#666677-fg}SR:{/}    A={cyan-fg}${srA.str}{/}  B={green-fg}${srB.str}{/}  → {bold}${betterSR} better{/bold}`,
        `  {#666677-fg}Lat:{/}   A={cyan-fg}${avgA}ms{/}  B={green-fg}${avgB}ms{/}  → {bold}${betterLat} faster{/bold}`,
        `  {#666677-fg}Cost:{/}  A={cyan-fg}${fmtCost(aAgent.costTotal)}{/}  B={green-fg}${fmtCost(bAgent.costTotal)}{/}  → {bold}${betterCost} cheaper{/bold}`,
      );

      return lines.join("\n");
    }

    if (this.cardIdx === -1) {
      lines.push(...renderFleetOverview(state, agents));
      lines.push("{#666677-fg}  c=compare mode{/}");
    } else {
      const agent = agents[this.cardIdx];
      if (agent) lines.push(...renderAgentCard(agent, this.cardIdx, agents.length));
    }

    return lines.join("\n");
  }
}
