// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Neural Stream Panel
// ═══════════════════════════════════════════════════════════════
//
// Live event log: shows every PepagiEvent as it arrives,
// color-coded by source with timestamps.

import type { DashboardState, LogEntry } from "../state.js";
import { ts, srcTag, trunc, MAX_LOG_LINES } from "../theme.js";
import { blessed, contrib } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

// ── Level color map ───────────────────────────────────────────

const LEVEL_COLOR: Record<string, string> = {
  info:  "{cyan-fg}",
  warn:  "{yellow-fg}",
  error: "{red-fg}",
  debug: "{#666677-fg}",
};

// ── Format helpers ────────────────────────────────────────────

export function formatLogEntry(e: LogEntry): string {
  const t   = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
  const lvl = LEVEL_COLOR[e.level] ?? "{white-fg}";
  const src = srcTag(e.source);
  const msg = trunc(e.message, 200);
  return `{#666677-fg}${t}{/} ${src} ${lvl}${msg}{/}`;
}

function formatLogEntryFull(e: LogEntry): string {
  const t   = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
  const lvl = LEVEL_COLOR[e.level] ?? "{white-fg}";
  const src = srcTag(e.source);
  return `{#666677-fg}${t}{/} ${src} ${lvl}${e.message}{/}`;
}

// ── Panel class ───────────────────────────────────────────────

export class NeuralStreamPanel {
  private box:  AnyElement;
  private log:  AnyElement;
  private title = " NEURAL STREAM ";
  private lastCount = 0;
  private expandMode  = false;
  private cachedState: DashboardState | null = null;

  constructor(
    parent: AnyElement,
    geom: { top: number; left: number; width: number; height: number },
  ) {
    this.box = blessed.box({
      parent,
      top:    geom.top,
      left:   geom.left,
      width:  geom.width,
      height: geom.height,
      tags:   true,
      border: { type: "line", fg: "#3a3a4a" },
      label:  ` {cyan-fg}⬡ ${this.title}{/} `,
      style: { fg: "white", bg: "black", border: { fg: "#3a3a4a" } },
    });

    this.log = contrib.log({
      parent: this.box,
      top:    1,
      left:   1,
      width:  "100%-4",
      height: "100%-2",
      tags:   true,
      scrollable:   true,
      alwaysScroll: true,
      scrollbar: { ch: "│", track: { bg: "#1a1a2e" }, style: { fg: "#3a3a4a" } },
      style: { fg: "white", bg: "black" },
    });

    // Ctrl+E — toggle expand mode (full message, no truncation)
    this.log.key("C-e", () => {
      this.expandMode = !this.expandMode;
      this.box.setLabel(` {cyan-fg}⬡ ${this.title}${this.expandMode ? "{yellow-fg}[EXPAND]{/}" : ""}{/} `);
      if (this.cachedState) this.rebuild(this.cachedState);
    });
  }

  /** Called on each redraw tick — pushes new log entries */
  update(state: DashboardState): void {
    if (state.paused) return;
    this.cachedState = state;

    const entries  = state.eventLog;
    const newCount = entries.length;

    for (let i = this.lastCount; i < newCount; i++) {
      const e = entries[i];
      if (!e) continue;
      this.log.log(this.expandMode ? formatLogEntryFull(e) : formatLogEntry(e));
      if (e.detail) {
        for (const line of e.detail) this.log.log(line);
      }
    }
    this.lastCount = newCount;
  }

  /** Push a pre-formatted string directly (for anomaly notices etc.) */
  pushRaw(line: string): void {
    this.log.log(line);
  }

  /** Clear and re-render last 200 entries (after pause resume or expand toggle) */
  rebuild(state: DashboardState): void {
    this.cachedState = state;
    this.log.setContent("");
    this.lastCount = 0;
    const show = state.eventLog.slice(-200);
    for (const e of show) {
      this.log.log(this.expandMode ? formatLogEntryFull(e) : formatLogEntry(e));
      if (e.detail) {
        for (const line of e.detail) this.log.log(line);
      }
    }
    this.lastCount = state.eventLog.length;
  }

  focus(): void {
    this.box.style.border = { fg: "cyan" };
    this.box.setLabel(` {cyan-fg}⬡ ${this.title}{/} ← `);
  }

  blur(): void {
    this.box.style.border = { fg: "#3a3a4a" };
    this.box.setLabel(` {cyan-fg}⬡ ${this.title}{/} `);
  }

  getElement(): AnyElement { return this.box; }
}
