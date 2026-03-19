// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Agent Pool & Platforms Panel
// ═══════════════════════════════════════════════════════════════

import type { DashboardState, AgentStat } from "../state.js";
import { statusDot, renderBar, renderBarColor, renderBarReset, fmtCost, fmtTokens, fmtUptime, trunc } from "../theme.js";
import { blessed } from "../cjs.js";

const RATE_LIMITS: Record<string, number> = {
  claude: 60, gpt: 60, gemini: 60, ollama: 999, lmstudio: 999,
};
// Standard 1-minute rolling window — seconds until next clock-aligned minute boundary
function secondsUntilReset(): number {
  return 60 - Math.floor((Date.now() / 1000) % 60);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

const AGENT_COLORS: Record<string, string> = {
  claude: "#00e5cc", gpt: "#4ade80", gemini: "#5c8aff", ollama: "#ffd93d", lmstudio: "#c084fc",
};

function circuitBreakerTag(a: AgentStat): string {
  const errRate = a.requestsTotal > 0 ? a.errorCount / a.requestsTotal : 0;
  if (errRate >= 0.5 && a.errorCount >= 3) return "{red-fg}[CB:OPEN]{/}";
  if (errRate >= 0.3 && a.errorCount >= 2) return "{yellow-fg}[CB:HALF]{/}";
  return "{green-fg}[CB:OK]{/}";
}

function renderAgent(a: AgentStat, barW: number, uptimeMin: number): string[] {
  const color    = AGENT_COLORS[a.provider] ?? "white";
  const dot      = a.available ? "{green-fg}●{/}" : "{red-fg}●{/}";
  const name     = `{${color}-fg}${trunc(a.provider.toUpperCase(), 8).padEnd(8)}{/}`;
  const active   = a.requestsActive > 0 ? `{yellow-fg}[${a.requestsActive}↑]{/}` : "";
  const last5    = a.latencyMs.slice(-5);
  const avgLat   = last5.length ? Math.round(last5.reduce((s, v) => s + v, 0) / last5.length) : 0;
  const latColor = avgLat < 1000 ? "green" : avgLat < 3000 ? "yellow" : "red";
  const loadBar  = renderBar(Math.min(1, a.requestsActive / 3), 1, barW);
  const loadC    = renderBarColor(Math.min(1, a.requestsActive / 3));
  const cb       = circuitBreakerTag(a);
  const totalReq = a.requestsTotal > 0 ? `{#666677-fg}${a.requestsTotal}req{/}` : "";
  // Success rate
  const sr       = a.requestsTotal > 0 ? (a.requestsTotal - a.errorCount) / a.requestsTotal : null;
  const srStr    = sr !== null
    ? `{${sr >= 0.9 ? "green" : sr >= 0.7 ? "yellow" : "red"}-fg}SR:${(sr * 100).toFixed(0)}%{/}`
    : "";
  // Rate limit row
  const limit    = RATE_LIMITS[a.provider] ?? 60;
  const rate     = uptimeMin > 0 ? a.requestsTotal / uptimeMin : 0;
  const ratePct  = Math.min(1, rate / limit);
  const rateC    = ratePct >= 0.8 ? "red" : ratePct >= 0.5 ? "yellow" : "green";
  const resetS   = secondsUntilReset();
  const rateBar  = renderBar(ratePct, 1, Math.max(4, barW - 2));
  return [
    `${dot} ${name}  ${active}  ${cb}  ${srStr}  ${totalReq}`,
    `  {#666677-fg}Cost:{/} {yellow-fg}${fmtCost(a.costTotal)}{/}  Tok:{blue-fg}${fmtTokens(a.tokensIn)}↑{/}{purple-fg}${fmtTokens(a.tokensOut)}↓{/}`,
    `  {#666677-fg}Lat:{/} {${latColor}-fg}${avgLat}ms{/}  Err:{red-fg}${a.errorCount}{/}  ${loadC}${loadBar}${renderBarReset()}`,
    `  {#666677-fg}Rate:{/} {${rateC}-fg}${rate.toFixed(1)}/min{/}{#3a3a4a-fg}/${limit}{/}  {${rateC}-fg}${rateBar}{/}  {#444455-fg}reset ${resetS}s{/}`,
  ];
}

export class AgentPoolPanel {
  private box:     AnyElement;
  private content: AnyElement;
  private title = " AGENT POOL ";
  private lagMs = 0;

  constructor(
    parent: AnyElement,
    geom: { top: number; left: number; width: number; height: number },
  ) {
    this.box = blessed.box({
      parent, top: geom.top, left: geom.left,
      width: geom.width, height: geom.height,
      tags: true,
      border: { type: "line", fg: "#3a3a4a" },
      label: ` {blue-fg}◈ ${this.title}{/} `,
      style: { fg: "white", bg: "black", border: { fg: "#3a3a4a" } },
    });
    this.content = blessed.box({
      parent: this.box, top: 1, left: 1,
      width: "100%-4", height: "100%-2",
      tags: true, scrollable: false,
      style: { fg: "white", bg: "black" },
    });

    // Track event-loop lag with a recurring setImmediate probe
    this._probeLag();
  }

  private _probeLag(): void {
    const t = performance.now();
    setImmediate(() => {
      this.lagMs = Math.round(performance.now() - t);
      this._probeLag();
    });
  }

  update(state: DashboardState): void {
    if (state.paused) return;
    const innerW    = Math.max(20, (this.box.width ?? 30) - 6);
    const barW      = Math.max(4, Math.floor(innerW / 4));
    const sep       = `{#3a3a4a-fg}${"─".repeat(innerW)}{/}`;
    const uptimeMin = (Date.now() - state.startTime) / 60_000;
    const lines: string[] = [];

    if (state.agents.size === 0) {
      lines.push("{#444455-fg}  No agents configured{/}");
    } else {
      for (const agent of state.agents.values()) {
        lines.push(...renderAgent(agent, barW, uptimeMin));
        lines.push(sep);
      }
    }

    // ── Watchdog status ─────────────────────────────────────────
    const wdAge = state.watchdogLastPing > 0
      ? `{green-fg}✓ ${fmtUptime(state.watchdogLastPing)} ago{/}`
      : "{#444455-fg}no ping yet{/}";
    lines.push(`{#888899-fg}WATCHDOG{/}  ${wdAge}`);
    lines.push(sep);

    // ── System resources ─────────────────────────────────────────
    const mem     = process.memoryUsage();
    const heapMB  = Math.round(mem.heapUsed  / 1_048_576);
    const rssMB   = Math.round(mem.rss        / 1_048_576);
    const heapPct = Math.min(1, heapMB / 512); // 512 MB reference
    const heapW   = Math.max(6, Math.floor(innerW / 2));
    const heapBar = renderBar(heapPct, 1, heapW);
    const heapC   = renderBarColor(heapPct);
    const lagC    = this.lagMs < 20 ? "green" : this.lagMs < 100 ? "yellow" : "red";
    lines.push(sep, "{#888899-fg}RESOURCES{/}");
    lines.push(
      `  {#666677-fg}Heap {/}{white-fg}${heapMB}MB{/} ${heapC}${heapBar}${renderBarReset()}`,
      `  {#666677-fg}RSS  {/}{white-fg}${rssMB}MB{/}   {#666677-fg}Lag {/}{${lagC}-fg}${this.lagMs}ms{/}`,
    );
    lines.push(sep);

    lines.push("{#888899-fg}PLATFORMS{/}");
    const { telegram, whatsapp, discord } = state.platforms;
    lines.push(fmt("Telegram", telegram.enabled, telegram.connected, telegram.messageCount));
    lines.push(fmt("WhatsApp", whatsapp.enabled, whatsapp.connected, whatsapp.messageCount));
    lines.push(fmt("Discord",  discord.enabled,  discord.connected,  discord.messageCount));
    this.content.setContent(lines.join("\n"));
  }

  focus(): void { this.box.style.border = { fg: "cyan" }; this.box.setLabel(` {blue-fg}◈ ${this.title}{/} ← `); }
  blur():  void { this.box.style.border = { fg: "#3a3a4a" }; this.box.setLabel(` {blue-fg}◈ ${this.title}{/} `); }
  getElement(): AnyElement { return this.box; }
}

function fmt(name: string, enabled: boolean, connected: boolean, messages: number): string {
  if (!enabled) return `  {#444455-fg}${name.padEnd(9)} disabled{/}`;
  return `  ${statusDot(connected)} {white-fg}${name.padEnd(9)}{/} {#888899-fg}${messages} msgs{/}`;
}
