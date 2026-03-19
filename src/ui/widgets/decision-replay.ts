// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Widget: Decision Replay (Ctrl+R)
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { fmtCost } from "../theme.js";
import { blessed } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

export class DecisionReplayWidget {
  private box:       AnyElement;
  private content:   AnyElement;
  private hintBar:   AnyElement;
  private _visible   = false;
  private showPrompt = false;
  private showWhatIf = false;

  constructor(screen: AnyElement) {
    this.box = blessed.box({
      parent: screen, top: "center", left: "center",
      width: "85%", height: "70%",
      tags: true, border: { type: "line", fg: "cyan" },
      label: " {bold}{cyan-fg}[Ctrl+R] DECISION REPLAY{/}{/} ",
      style: { fg: "white", bg: "#0a0a16", border: { fg: "cyan" } },
      hidden: true, shadow: true,
    });

    this.content = blessed.box({
      parent: this.box, top: 1, left: 1,
      width: "100%-4", height: "100%-4",
      tags: true, scrollable: true,
      style: { fg: "white", bg: "#0a0a16" },
    });

    this.hintBar = blessed.box({
      parent: this.box, bottom: 1, left: 1,
      width: "100%-4", height: 1, tags: true,
      content: " {#666677-fg}[←][→] step  [Home] first  [End] latest  [p] prompt  [Escape] close{/} ",
      style: { fg: "grey", bg: "#0a0a16" },
    });
  }

  private updateHint(): void {
    const extra = this.showPrompt
      ? " {cyan-fg}[p] overview{/} "
      : this.showWhatIf
      ? " {yellow-fg}[w] overview{/} "
      : " [p] prompt  [w] what-if ";
    this.hintBar.setContent(
      ` {#666677-fg}[←][→] step  [Home] first  [End] latest ${extra} [Escape] close{/} `,
    );
  }

  show(): void {
    this._visible  = true;
    this.showPrompt = false;
    this.showWhatIf = false;
    this.box.show();
    this.content.focus();
    this.content.key("p", () => {
      this.showWhatIf = false;
      this.showPrompt = !this.showPrompt;
      this.updateHint();
    });
    this.content.key("w", () => {
      this.showPrompt = false;
      this.showWhatIf = !this.showWhatIf;
      this.updateHint();
    });
    this.updateHint();
  }
  hide(): void { this._visible = false; this.box.hide(); }
  isVisible(): boolean { return this._visible; }

  update(state: DashboardState): void {
    if (!this._visible) return;
    this.content.setContent(this.render(state));
  }

  private render(state: DashboardState): string {
    const decisions = state.decisions;
    if (decisions.length === 0) return "{#444455-fg}  No decisions recorded yet.{/}";

    const idx    = state.replayIndex === -1
      ? decisions.length - 1
      : Math.max(0, Math.min(state.replayIndex, decisions.length - 1));
    const record = decisions[idx]!;
    const d      = record.decision;

    // ── What-if view ──────────────────────────────────────────
    if (this.showWhatIf) {
      const header = [
        `{bold}Decision {cyan-fg}${idx + 1}{/} / ${decisions.length}{/bold}  {#666677-fg}${new Date(record.ts).toLocaleTimeString()}{/}`,
        "{#3a3a4a-fg}" + "─".repeat(50) + "{/}",
        `{bold}{yellow-fg}◈ WHAT-IF ANALYSIS{/bold}{/}`,
        `{#666677-fg}Exploring alternative decisions for task ${record.taskId.slice(0, 10)}{/}`,
        "",
      ];
      const lines2: string[] = [...header];

      // Recorded alternatives from mediator (if any)
      const alts = d.alternatives ?? [];
      if (alts.length > 0) {
        lines2.push("{#888899-fg}REJECTED ALTERNATIVES (mediator-reported){/}");
        for (const a of alts) {
          const c = a.agent ? `{cyan-fg}→ ${a.agent}{/}` : "";
          lines2.push(
            `  {yellow-fg}▸ [${a.action}]{/} ${c}  ${a.estimatedCost != null ? `{yellow-fg}~${fmtCost(a.estimatedCost)}{/}` : ""}`,
            `    {#888899-fg}${a.reasoning}{/}`,
          );
        }
        lines2.push("");
      }

      // Synthetic what-if: estimate cost with different agents
      lines2.push("{#888899-fg}SYNTHETIC WHAT-IF: COST BY AGENT{/}");
      lines2.push(`{#666677-fg}Actual action: {cyan-fg}${d.action.toUpperCase()}{/}  ` +
        (d.assignment ? `agent: {cyan-fg}${d.assignment.agent}{/}` : "(no agent assigned)"));
      lines2.push("");

      // Compare agents from state
      const agents = [...state.agents.values()];
      if (agents.length === 0) {
        lines2.push("  {#444455-fg}No agents configured{/}");
      } else {
        const actualAgent = d.assignment?.agent;
        for (const a of agents) {
          const isActual = a.provider === actualAgent;
          const avgCostPer1k = a.tokensOut > 0
            ? (a.costTotal / (a.tokensOut / 1000))
            : 0;
          // Estimate: 500 output tokens for a typical decision
          const estCost = avgCostPer1k * 0.5;
          const marker = isActual ? "{bold}{cyan-fg}► CHOSEN{/bold}{/}" : "{#666677-fg}  option{/}";
          const errRate = a.requestsTotal > 0 ? (a.errorCount / a.requestsTotal) : 0;
          const srColor = errRate < 0.1 ? "green" : errRate < 0.3 ? "yellow" : "red";
          lines2.push(
            `  ${marker} {${isActual ? "cyan" : "white"}-fg}${a.provider.padEnd(10)}{/}` +
            `  est: {yellow-fg}${avgCostPer1k > 0 ? fmtCost(estCost) : "—"}{/}` +
            `  SR: {${srColor}-fg}${a.requestsTotal > 0 ? `${((1 - errRate) * 100).toFixed(0)}%` : "—"}{/}` +
            `  lat: {#888899-fg}${a.latencyMs.length ? Math.round(a.latencyMs.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, a.latencyMs.length)) + "ms" : "—"}{/}`,
          );
        }
      }

      lines2.push("", "{#444455-fg}Note: synthetic estimates based on session cost/token ratios{/}");
      return lines2.join("\n");
    }

    // ── Prompt text view ──────────────────────────────────────
    if (this.showPrompt) {
      const prompt = d.assignment?.prompt ?? "(no prompt — action was not 'assign')";
      const header = [
        `{bold}Decision {cyan-fg}${idx + 1}{/} / ${decisions.length}{/bold}  {#666677-fg}${new Date(record.ts).toLocaleTimeString()}  task: ${record.taskId.slice(0, 10)}{/}`,
        "{#3a3a4a-fg}" + "─".repeat(50) + "{/}",
        `{bold}Action:{/} {cyan-fg}${d.action.toUpperCase()}{/}` +
          (d.assignment ? `  {#666677-fg}→{/} {cyan-fg}${d.assignment.agent}{/}` : ""),
        "",
        "{bold}{#888899-fg}WORKER PROMPT TEXT:{/bold}{/}",
        "{#3a3a4a-fg}" + "─".repeat(50) + "{/}",
      ];
      // Split prompt into lines and display fully (no truncation)
      const promptLines = prompt.split("\n").map(l => `{#aaaacc-fg}${l}{/}`);
      return [...header, ...promptLines].join("\n");
    }
    const confC  = d.confidence >= 0.7 ? "green" : d.confidence >= 0.4 ? "yellow" : "red";
    const actC: Record<string, string> = {
      decompose: "cyan", assign: "blue", complete: "green",
      fail: "red", ask_user: "yellow", swarm: "purple",
    };

    const lines: string[] = [
      `{bold}Decision {cyan-fg}${idx + 1}{/} / ${decisions.length}{/bold}  {#666677-fg}${new Date(record.ts).toLocaleTimeString()}  task: ${record.taskId.slice(0, 10)}{/}`,
      "{#3a3a4a-fg}" + "─".repeat(50) + "{/}",
      "",
      `{bold}Action:{/}     {${actC[d.action] ?? "white"}-fg}${d.action.toUpperCase()}{/}`,
      `{bold}Confidence:{/} {${confC}-fg}${(d.confidence * 100).toFixed(0)}%{/}`,
      "",
      "{bold}Reasoning:{/}",
      `  {#aaaacc-fg}${d.reasoning ?? "(no reasoning provided)"}{/}`,
    ];

    if (record.thought) {
      lines.push("", "{bold}Thought:{/}", `  {#888899-fg}${record.thought}{/}`);
    }

    if (d.introspection) {
      lines.push("", "{bold}Introspection:{/}");
      lines.push(`  {#aaaacc-fg}${d.introspection.currentFeeling}{/}`);
      if (d.introspection.emotionalState) {
        const parts = Object.entries(d.introspection.emotionalState)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${((v as number) * 100).toFixed(0)}%`)
          .join("  ");
        lines.push(`  {#888899-fg}${parts}{/}`);
      }
      lines.push(`  {#666677-fg}Value alignment:{/} ${d.introspection.valueCheck ? "{green-fg}✓ aligned{/}" : "{red-fg}✗ misaligned{/}"}`);
    }

    if (d.assignment) {
      lines.push("", `{bold}Assignment:{/} {cyan-fg}${d.assignment.agent}{/}  {#666677-fg}${d.assignment.reason}{/}`);
    }

    if (d.subtasks && d.subtasks.length > 0) {
      lines.push("", `{bold}Subtasks: (${d.subtasks.length}){/}`);
      for (const st of d.subtasks) lines.push(`  {cyan-fg}▸{/} ${st.title}`);
    }

    return lines.join("\n");
  }

  getElement(): AnyElement { return this.box; }
}
