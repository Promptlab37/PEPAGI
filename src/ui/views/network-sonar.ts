// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F9: Network Sonar
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { fmtTokens, renderBar, statusDot, trunc } from "../theme.js";
import { createConnection } from "node:net";

// Typical API rate limits (requests per minute)
const RATE_LIMITS: Record<string, number> = {
  claude:   60,
  gpt:      60,
  gemini:   60,
  ollama:   999,
  lmstudio: 999,
};

const ENDPOINT_PORTS: Record<string, { host: string; port: number }> = {
  claude:  { host: "api.anthropic.com",                     port: 443 },
  gpt:     { host: "api.openai.com",                        port: 443 },
  gemini:  { host: "generativelanguage.googleapis.com",     port: 443 },
  ollama:  { host: "localhost",                              port: 11434 },
  lmstudio:{ host: "localhost",                              port: 1234 },
};

const BLOCKS = " ▁▂▃▄▅▆▇█";

function tcpPing(host: string, port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const start  = Date.now();
    const socket = createConnection({ host, port });
    const timer  = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(Date.now() - start); });
    socket.once("error",   () => { clearTimeout(timer); resolve(null); });
  });
}

function sonarPing(ms: number | null | undefined): string {
  if (ms == null) return "{#444455-fg}○ no data{/}";
  if (ms < 500)   return `{green-fg}◉ ${ms}ms  FAST{/}`;
  if (ms < 2000)  return `{yellow-fg}◉ ${ms}ms  OK{/}`;
  return `{red-fg}◉ ${ms}ms  SLOW{/}`;
}

function latencyBar(latencies: number[], width: number): string {
  if (latencies.length === 0) return " ".repeat(width);
  const max = Math.max(...latencies, 100);
  return latencies.slice(-width).map(v => BLOCKS[Math.round((v / max) * 7)] ?? "█").join("");
}

export class NetworkSonarView extends BaseView {
  private pingMs:       Map<string, number | null> = new Map();
  private lastPingTime  = 0;
  private pingInFlight  = false;

  constructor(screen: AnyElement) {
    super(screen, { title: "NETWORK SONAR", fKey: "F9", width: "85%", height: "85%", borderColor: "#5c8aff" });
    this.content.key("r", () => { void this.runPings(); });
  }

  override show(): void { super.show(); void this.runPings(); }

  private async runPings(): Promise<void> {
    if (this.pingInFlight) return;
    this.pingInFlight = true;
    const results = await Promise.all(
      Object.entries(ENDPOINT_PORTS).map(async ([prov, ep]) => ({
        prov, ms: await tcpPing(ep.host, ep.port),
      })),
    );
    for (const { prov, ms } of results) this.pingMs.set(prov, ms);
    this.lastPingTime = Date.now();
    this.pingInFlight = false;
  }

  protected renderContent(state: DashboardState): string {
    if (!this.pingInFlight && Date.now() - this.lastPingTime > 30_000) void this.runPings();

    const uptimeSecs = (Date.now() - state.startTime) / 1000;
    const totalTok   = state.sessionTokensIn + state.sessionTokensOut;
    const tokPerMin  = uptimeSecs > 0 ? Math.round(totalTok / (uptimeSecs / 60)) : 0;

    const lines: string[] = [
      "{bold}{blue-fg}◈ NETWORK SONAR{/bold}{/}",
      `{#666677-fg}Live connectivity  r=refresh ping${this.pingInFlight ? "  {yellow-fg}pinging…{/}" : ""}{/}`,
      "",
    ];

    // ── ASCII Connection Map ──────────────────────────────────
    lines.push("{#888899-fg}CONNECTION MAP{/}");
    const provList = [...state.agents.keys()];
    const plats    = [
      state.platforms.telegram.enabled  ? { name: "Telegram", ok: state.platforms.telegram.connected  } : null,
      state.platforms.whatsapp.enabled  ? { name: "WhatsApp", ok: state.platforms.whatsapp.connected  } : null,
      state.platforms.discord.enabled   ? { name: "Discord",  ok: state.platforms.discord.connected   } : null,
    ].filter(Boolean) as { name: string; ok: boolean }[];

    const allNodes = [
      ...provList.map(p => ({ label: p.toUpperCase(), ping: this.pingMs.get(p) })),
      ...plats.map(p => ({ label: p.name,             ping: p.ok ? (0 as number) : null, platform: true })),
    ];

    if (allNodes.length === 0) {
      lines.push("  {#444455-fg}PEPAGI — no agents configured{/}");
    } else {
      lines.push("  {cyan-fg}PEPAGI{/}");
      allNodes.forEach((node, i) => {
        const isLast = i === allNodes.length - 1;
        const branch = isLast ? "└──" : "├──";
        const isPlatform = "platform" in node && node.platform;
        const pingStr = isPlatform
          ? (node.ping === 0 ? "{green-fg}CONNECTED{/}" : "{red-fg}OFFLINE{/}")
          : sonarPing(node.ping as number | null | undefined);
        const ep = ENDPOINT_PORTS[node.label.toLowerCase()];
        const host = ep ? `{#444455-fg}${trunc(ep.host, 30)}{/}` : "";
        lines.push(`  {#3a3a4a-fg}${branch}{/} {${isPlatform ? "white" : "cyan"}-fg}${node.label.padEnd(11)}{/}  ${pingStr}  ${host}`);
      });
    }

    lines.push("");

    // ── Messaging Platforms ──────────────────────────────────
    lines.push("{#888899-fg}MESSAGING PLATFORMS{/}");
    const platsAll = [
      { name: "Telegram", e: state.platforms.telegram },
      { name: "WhatsApp", e: state.platforms.whatsapp },
      { name: "Discord",  e: state.platforms.discord  },
    ];
    for (const { name, e } of platsAll) {
      if (!e.enabled) lines.push(`  {#444455-fg}${name.padEnd(10)} DISABLED{/}`);
      else lines.push(
        `  ${statusDot(e.connected)} {white-fg}${name.padEnd(10)}{/} ` +
        `${e.connected ? "{green-fg}CONNECTED{/}" : "{red-fg}DISCONNECTED{/}"}  {#666677-fg}${e.messageCount} msgs{/}`,
      );
    }

    lines.push("", "{#888899-fg}LLM API ENDPOINTS{/}");
    if (state.agents.size === 0) {
      lines.push("  {#444455-fg}No agents configured{/}");
    } else {
      for (const [provider, agent] of state.agents.entries()) {
        const last5  = agent.latencyMs.slice(-5);
        const avgLat = last5.length ? Math.round(last5.reduce((s, v) => s + v, 0) / last5.length) : 0;
        const ep     = ENDPOINT_PORTS[provider];
        lines.push(
          `  {cyan-fg}${provider.toUpperCase().padEnd(10)}{/} TCP:${sonarPing(this.pingMs.get(provider))}  App:${sonarPing(avgLat || undefined)}`,
          `    {#444455-fg}${ep?.host ?? "unknown"}{/}`,
          `    {#888899-fg}Latency trend{/} {cyan-fg}${latencyBar(agent.latencyMs, 20)}{/}`,
          `    {#666677-fg}Req:{/} {white-fg}${agent.requestsTotal}{/}  Active: {yellow-fg}${agent.requestsActive}{/}  Err: {red-fg}${agent.errorCount}{/}`,
          "",
        );
      }
    }

    // ── Rate Limits Per Platform ──────────────────────────────
    if (state.agents.size > 0) {
      const uptimeMin = (Date.now() - state.startTime) / 60_000;
      lines.push("{#888899-fg}RATE LIMITS{/}");
      lines.push(`  {#3a3a4a-fg}${"PROVIDER".padEnd(12)} ${"RATE".padEnd(12)} ${"LIMIT".padEnd(8)} ${"USAGE"}{/}`);
      lines.push(`  {#3a3a4a-fg}${"─".repeat(50)}{/}`);
      for (const [provider, agent] of state.agents.entries()) {
        const limit   = RATE_LIMITS[provider] ?? 60;
        const rate    = uptimeMin > 0 ? agent.requestsTotal / uptimeMin : 0;
        const pct     = Math.min(1, rate / limit);
        const bar     = renderBar(pct, 1, 14);
        const rateC   = pct >= 0.8 ? "red" : pct >= 0.5 ? "yellow" : "green";
        lines.push(
          `  {cyan-fg}${provider.padEnd(12)}{/}` +
          `{${rateC}-fg}${rate.toFixed(1).padEnd(7)}/min{/}` +
          `  {#666677-fg}lim:{/}{white-fg}${String(limit).padEnd(5)}{/}` +
          `{${rateC}-fg}${bar}{/} {#666677-fg}${(pct * 100).toFixed(0)}%{/}`,
        );
      }
      lines.push("");
    }

    // ── Data Transfer Summary ─────────────────────────────────
    const totalIn  = [...state.agents.values()].reduce((s, a) => s + a.tokensIn,  0);
    const totalOut = [...state.agents.values()].reduce((s, a) => s + a.tokensOut, 0);
    const totalReq = [...state.agents.values()].reduce((s, a) => s + a.requestsTotal, 0);

    lines.push(
      "{#3a3a4a-fg}" + "─".repeat(60) + "{/}",
      "{#888899-fg}DATA TRANSFER SUMMARY{/}",
      `  {blue-fg}Total tokens sent:     {/}{white-fg}${fmtTokens(totalIn)}{/}`,
      `  {purple-fg}Total tokens received: {/}{white-fg}${fmtTokens(totalOut)}{/}`,
      `  {cyan-fg}Total API requests:    {/}{white-fg}${totalReq}{/}`,
      `  {#888899-fg}Bandwidth (avg):       {/}{white-fg}${tokPerMin.toLocaleString()} tok/min{/}`,
    );

    if (state.agents.size > 1) {
      lines.push("", "{#888899-fg}PER-AGENT BREAKDOWN{/}");
      for (const [provider, agent] of state.agents.entries()) {
        const total = agent.tokensIn + agent.tokensOut;
        const pct   = totalIn + totalOut > 0 ? (total / (totalIn + totalOut)) * 100 : 0;
        lines.push(
          `  {cyan-fg}${provider.padEnd(10)}{/} {blue-fg}↑${fmtTokens(agent.tokensIn).padEnd(6)}{/} ` +
          `{purple-fg}↓${fmtTokens(agent.tokensOut).padEnd(6)}{/} ` +
          `{#666677-fg}${renderBar(pct / 100, 1, 15)} ${pct.toFixed(0)}%{/}`,
        );
      }
    }

    // ── Recent API Calls ─────────────────────────────────────
    lines.push("", "{#888899-fg}RECENT API CALLS (last 10){/}");
    const recentDecisions = state.decisions.slice(-10).reverse();
    if (recentDecisions.length === 0) {
      lines.push("  {#444455-fg}No API calls recorded yet{/}");
    } else {
      for (const d of recentDecisions) {
        const t    = new Date(d.ts).toLocaleTimeString("en-GB", { hour12: false });
        const act  = d.decision.action;
        const agt  = d.decision.assignment?.agent ?? "—";
        const conf = `${(d.decision.confidence * 100).toFixed(0)}%`;
        const confC = d.decision.confidence >= 0.7 ? "green" : d.decision.confidence >= 0.4 ? "yellow" : "red";
        lines.push(
          `  {#666677-fg}${t}{/} {cyan-fg}[${act.padEnd(8)}]{/} {white-fg}${agt.padEnd(10)}{/} {${confC}-fg}${conf}{/}`,
        );
      }
    }

    lines.push("", `{#444455-fg}Last ping: ${this.lastPingTime > 0 ? new Date(this.lastPingTime).toLocaleTimeString() : "—"}{/}`);
    return lines.join("\n");
  }
}
