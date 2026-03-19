// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Task Pipeline Panel
// ═══════════════════════════════════════════════════════════════

import type { Task } from "../../core/types.js";
import type { DashboardState, TaskRow } from "../state.js";
import { trunc, fmtCost, fmtDuration } from "../theme.js";
import { blessed } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

const STATUS_COLOR: Record<string, string> = {
  pending: "#666677", queued: "#888899", assigned: "#5c8aff",
  running: "#00e5cc", waiting_subtasks: "#ffd93d", review: "#c084fc",
  completed: "#4ade80", failed: "#ff6b6b", cancelled: "#888899",
};

const DIFF_COLOR: Record<string, string> = {
  trivial: "#666677", simple: "#4ade80", medium: "#ffd93d",
  complex: "#ff6b6b", unknown: "#c084fc",
};

const STATUS_ICON: Record<string, string> = {
  pending: "○", queued: "◌", assigned: "◐", running: "●",
  waiting_subtasks: "⊙", review: "◉", completed: "✓", failed: "✗", cancelled: "—",
};

function statusTag(s: string): string {
  const c = STATUS_COLOR[s] ?? "white";
  const i = STATUS_ICON[s] ?? s;
  return `{${c}-fg}${i}{/}`;
}

function diffTag(d: string): string {
  return `{${DIFF_COLOR[d] ?? "white"}-fg}${d.slice(0, 4)}{/}`;
}

function confBar(c: number): string {
  if (c >= 0.8) return `{green-fg}${(c * 100).toFixed(0)}%{/}`;
  if (c >= 0.5) return `{yellow-fg}${(c * 100).toFixed(0)}%{/}`;
  return `{red-fg}${(c * 100).toFixed(0)}%{/}`;
}

function agentTag(a: string | null): string {
  if (!a) return "{#444455-fg}---{/}";
  const colors: Record<string, string> = {
    claude: "cyan", gpt: "green", gemini: "blue", ollama: "yellow", lmstudio: "magenta",
  };
  return `{${colors[a] ?? "white"}-fg}${a.slice(0, 6)}{/}`;
}

function formatRow(t: TaskRow, titleW: number): string {
  return (
    `${statusTag(t.status)} ${trunc(t.title, titleW).padEnd(titleW)} ` +
    `${agentTag(t.agent)} ${diffTag(t.difficulty)} ${confBar(t.confidence)} ` +
    `{#aaaacc-fg}${fmtCost(t.cost).padStart(7)}{/} ` +
    `{#888899-fg}${t.durationMs != null ? fmtDuration(t.durationMs) : "---"}{/}`
  );
}

function formatTimeline(t: TaskRow, _width: number): string {
  const stages = ["pend", "asgn", "run", "done"];
  const statuses: Task["status"][] = ["pending", "assigned", "running", "completed"];
  const curIdx = Math.max(0, statuses.indexOf(t.status));
  const doneIdx = t.status === "completed" || t.status === "failed" ? 3 : -1;

  const parts = stages.map((label, i) => {
    if (doneIdx === 3 && i < 4) return `{green-fg}✓${label}{/}`;
    if (i < curIdx)             return `{green-fg}✓${label}{/}`;
    if (i === curIdx)           return `{cyan-fg}◉${label}{/}`;
    return `{#3a3a4a-fg}○${label}{/}`;
  });
  const sep = "{#3a3a4a-fg}─{/}";
  const dotLine = "  " + parts.join(sep);

  // Per-stage durations
  const now = Date.now();
  const endMs = t.durationMs != null ? t.createdAt + t.durationMs : now;
  const pendDur   = t.assignedAt ? t.assignedAt - t.createdAt : null;
  const assignDur = t.startedAt && t.assignedAt ? t.startedAt - t.assignedAt : null;
  const runDur    = t.startedAt ? endMs - t.startedAt : null;

  const timings: string[] = [];
  if (pendDur   != null) timings.push(`{#555566-fg}pend:${fmtDuration(pendDur)}{/}`);
  if (assignDur != null) timings.push(`{#555566-fg}asgn:${fmtDuration(assignDur)}{/}`);
  if (runDur    != null) timings.push(`{#555566-fg}run:${fmtDuration(runDur)}{/}`);
  const timingLine = timings.length > 0 ? "  " + timings.join(" {#3a3a4a-fg}·{/} ") : "";

  return timingLine ? `${dotLine}\n${timingLine}` : dotLine;
}

export class PipelinePanel {
  private box:       AnyElement;
  private content:   AnyElement;
  private title      = " TASK PIPELINE ";
  private prevTokIn  = 0;
  private prevTokOut = 0;
  private prevTokTs  = 0;
  private selectedIdx = -1;   // -1 = no selection
  private expanded    = false;
  private taskList:   TaskRow[] = [];

  constructor(
    parent: AnyElement,
    geom: { top: number; left: number; width: number; height: number },
  ) {
    this.box = blessed.box({
      parent, top: geom.top, left: geom.left,
      width: geom.width, height: geom.height,
      tags: true,
      border: { type: "line", fg: "#3a3a4a" },
      label: ` {green-fg}⚡ ${this.title}{/} `,
      style: { fg: "white", bg: "black", border: { fg: "#3a3a4a" } },
    });

    this.content = blessed.box({
      parent: this.box, top: 1, left: 1,
      width: "100%-4", height: "100%-2",
      tags: true, scrollable: true, keys: true,
      scrollbar: { ch: "│", style: { fg: "#3a3a4a" } },
      style: { fg: "white", bg: "black" },
    });

    this.content.key(["j", "down"], () => {
      if (this.taskList.length === 0) return;
      this.selectedIdx = Math.min(this.taskList.length - 1, (this.selectedIdx < 0 ? -1 : this.selectedIdx) + 1);
      this.expanded = false;
    });
    this.content.key(["k", "up"], () => {
      this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      this.expanded = false;
    });
    this.content.key(["escape"], () => { this.selectedIdx = -1; this.expanded = false; });
    this.content.key(["enter", "space"], () => {
      if (this.selectedIdx >= 0) this.expanded = !this.expanded;
    });
  }

  update(state: DashboardState): void {
    if (state.paused) return;

    const innerW = Math.max(40, (this.box.width ?? 60) - 4);
    const titleW = Math.max(10, innerW - 60);
    const sep    = `{#3a3a4a-fg}${"─".repeat(innerW)}{/}`;

    const active = [...state.activeTasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    // Clamp selectedIdx
    if (this.selectedIdx >= active.length) { this.selectedIdx = active.length - 1; }
    this.taskList = active;

    const lines: string[] = [
      `{bold}{#888899-fg}${"S".padEnd(2)} ${"TITLE".padEnd(titleW)} ${"AGENT".padEnd(7)} ${"DIFF".padEnd(5)} ${"CONF".padEnd(5)} ${"COST".padEnd(7)} DUR{/bold}{/}`,
      `{#444455-fg}j/k=select  Enter=detail  Esc=deselect{/}`,
      sep,
    ];

    for (let i = 0; i < Math.min(active.length, 20); i++) {
      const t   = active[i]!;
      const sel = i === this.selectedIdx;
      const row = sel ? `{inverse}${formatRow(t, titleW)}{/inverse}` : formatRow(t, titleW);
      lines.push(row);
      const tl = formatTimeline(t, innerW);
      if (tl) lines.push(tl);

      // ── Swarm branch viz ──────────────────────────────────
      if (t.swarmBranches > 0) {
        const branches = Array.from({ length: t.swarmBranches }, (_, bi) =>
          `  {#3a3a4a-fg}${bi < t.swarmBranches - 1 ? "├──" : "└──"}{/} {purple-fg}branch-${bi + 1}{/}`,
        );
        lines.push(`  {bold}{purple-fg}⟨SWARM: ${t.swarmBranches} branches⟩{/bold}{/}`);
        lines.push(...branches);
      }

      // ── Expanded detail ───────────────────────────────────
      if (sel && this.expanded) {
        lines.push(`  {#3a3a4a-fg}${"─".repeat(Math.max(10, innerW - 4))}{/}`);
        lines.push(`  {#666677-fg}ID:{/}       {#888899-fg}${t.id}{/}`);
        lines.push(`  {#666677-fg}Status:{/}   ${statusTag(t.status)} {white-fg}${t.status}{/}`);
        lines.push(`  {#666677-fg}Agent:{/}    ${agentTag(t.agent)}`);
        lines.push(`  {#666677-fg}Difficulty:{/} ${diffTag(t.difficulty)}  Confidence: ${confBar(t.confidence)}`);
        lines.push(`  {#666677-fg}Cost:{/}     {yellow-fg}$${t.cost.toFixed(4)}{/}`);
        if (t.durationMs != null) lines.push(`  {#666677-fg}Duration:{/} {cyan-fg}${fmtDuration(t.durationMs)}{/}`);
        if (t.swarmBranches > 0) lines.push(`  {#666677-fg}Swarm:{/}    {purple-fg}${t.swarmBranches} parallel branches{/}`);
        lines.push(`  {#3a3a4a-fg}${"─".repeat(Math.max(10, innerW - 4))}{/}`);
      }
    }

    if (active.length === 0 && state.completedTasks.length === 0) {
      lines.push("{#444455-fg}  No tasks yet — send a message to start{/}");
    }

    if (active.length > 0 && state.completedTasks.length > 0) {
      lines.push(sep);
      lines.push("{#666677-fg}  — recent history —{/}");
    }

    for (const t of state.completedTasks.slice(-10).reverse()) lines.push(formatRow(t, titleW));

    lines.push(sep);
    lines.push(
      `{#666677-fg}Active: {cyan-fg}${active.length}{/}  Done: {green-fg}${state.totalCompleted}{/}  Failed: {red-fg}${state.totalFailed}{/}{/}`,
    );

    // ── Streaming token counter ───────────────────────────────
    const now2    = Date.now();
    const dtMs    = this.prevTokTs > 0 ? now2 - this.prevTokTs : 1000;
    const dtMin   = dtMs / 60_000;
    const dIn     = state.sessionTokensIn  - this.prevTokIn;
    const dOut    = state.sessionTokensOut - this.prevTokOut;
    const rateIn  = dtMin > 0 ? Math.round(dIn  / dtMin) : 0;
    const rateOut = dtMin > 0 ? Math.round(dOut / dtMin) : 0;
    this.prevTokIn  = state.sessionTokensIn;
    this.prevTokOut = state.sessionTokensOut;
    this.prevTokTs  = now2;

    const hasRunning = active.some(t => t.status === "running");
    if (hasRunning || rateIn > 0 || rateOut > 0) {
      const pulseChar = hasRunning ? (Math.floor(now2 / 400) % 2 === 0 ? "◉" : "●") : "○";
      lines.push(sep);
      lines.push(
        `{cyan-fg}${pulseChar} STREAMING{/}  ` +
        `{blue-fg}↑${rateIn.toLocaleString()}{/}{#666677-fg} tok/min{/}  ` +
        `{purple-fg}↓${rateOut.toLocaleString()}{/}{#666677-fg} tok/min{/}  ` +
        `{#444455-fg}session: ↑${state.sessionTokensIn.toLocaleString()} ↓${state.sessionTokensOut.toLocaleString()}{/}`,
      );
    }

    this.content.setContent(lines.join("\n"));
  }

  focus(): void { this.box.style.border = { fg: "cyan" }; this.box.setLabel(` {green-fg}⚡ ${this.title}{/} ← `); }
  blur():  void { this.box.style.border = { fg: "#3a3a4a" }; this.box.setLabel(` {green-fg}⚡ ${this.title}{/} `); }
  getElement(): AnyElement { return this.box; }
}
