// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F3: Log Telescope
// ═══════════════════════════════════════════════════════════════

import type { DashboardState, LogEntry } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { blessed } from "../cjs.js";
import { trunc } from "../theme.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type LogLevel    = "all" | "info" | "warn" | "error" | "debug";
type TimeRange   = 60_000 | 300_000 | 3_600_000 | null;

const LEVEL_COLOR: Record<string, string> = {
  info: "{cyan-fg}INFO {/}", warn: "{yellow-fg}WARN {/}",
  error: "{red-fg}ERR  {/}", debug: "{#666677-fg}DBG  {/}",
};

const TIME_LABELS: Array<{ ms: TimeRange; label: string; key: string }> = [
  { ms: 60_000,     label: "1m",  key: "1" },
  { ms: 300_000,    label: "5m",  key: "5" },
  { ms: 3_600_000,  label: "1h",  key: "h" },
  { ms: null,       label: "all", key: "0" },
];

export class LogTelescopeView extends BaseView {
  private levelFilter: LogLevel    = "all";
  private searchQuery               = "";
  private timeRange:   TimeRange    = null;
  private searchBox:   AnyElement;
  private cachedEntries: LogEntry[] = [];
  private exportMsg                 = "";

  constructor(screen: AnyElement) {
    super(screen, { title: "LOG TELESCOPE", fKey: "F3", width: "95%", height: "90%", borderColor: "#5c8aff" });

    this.searchBox = blessed.textbox({
      parent: this.box, bottom: 3, left: 1, width: "60%", height: 3,
      inputOnFocus: true,
      border: { type: "line", fg: "#5c8aff" },
      label: " {blue-fg}/ regex or literal search{/} ",
      style: { fg: "white", bg: "#0a0a16" },
    });

    this.searchBox.on("submit", (value: string) => {
      this.searchQuery = value.trim();
      this.searchBox.clearValue();
      this.content.focus();
    });
    this.searchBox.key("escape", () => { this.searchBox.clearValue(); this.content.focus(); });

    // Level filter buttons
    const levels: LogLevel[] = ["all", "info", "warn", "error", "debug"];
    levels.forEach((level, i) => {
      const btn = blessed.button({
        parent: this.box, bottom: 3, right: 1 + (levels.length - 1 - i) * 8,
        width: 7, height: 3, tags: true,
        content: ` ${level.toUpperCase()} `,
        border: { type: "line", fg: "#5c8aff" },
        style: { fg: "white", bg: "#0a0a16", focus: { bg: "#1a3a6a" } },
      });
      btn.on("press", () => { this.levelFilter = level; });
    });

    // Time-range keys (on content so they work when view is open)
    this.content.key("1", () => { this.timeRange = 60_000; });
    this.content.key("5", () => { this.timeRange = 300_000; });
    this.content.key("h", () => { this.timeRange = 3_600_000; });
    this.content.key("0", () => { this.timeRange = null; });
    // Clear search
    this.content.key("x", () => { this.searchQuery = ""; });
    // Ctrl+S — export filtered entries to file
    this.content.key("C-s", () => { void this.exportToFile(); });
  }

  private async exportToFile(): Promise<void> {
    try {
      const dir = join(homedir(), ".pepagi", "logs");
      await mkdir(dir, { recursive: true });
      const ts   = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `export-${ts}.txt`);
      const text = this.cachedEntries.map(e => {
        const t   = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
        return `[${t}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.message}`;
      }).join("\n");
      await writeFile(path, text, "utf8");
      this.exportMsg = `{green-fg}✓ Exported ${this.cachedEntries.length} entries → ${path}{/}`;
    } catch (err) {
      this.exportMsg = `{red-fg}✗ Export failed: ${String(err)}{/}`;
    }
    setTimeout(() => { this.exportMsg = ""; }, 4000);
  }

  show(): void { super.show(); this.searchBox.focus(); }

  protected renderContent(state: DashboardState): string {
    const now = Date.now();
    let entries: LogEntry[] = [...state.eventLog];

    // Time-range filter
    if (this.timeRange != null) {
      entries = entries.filter(e => e.ts >= now - this.timeRange!);
    }

    // Level filter
    if (this.levelFilter !== "all") {
      entries = entries.filter(e => e.level === this.levelFilter);
    }

    // Search filter — regex if query starts with "/", literal otherwise
    let activeRe: RegExp | null = null;
    if (this.searchQuery) {
      if (this.searchQuery.startsWith("/")) {
        try {
          activeRe = new RegExp(this.searchQuery.slice(1), "i");
          entries  = entries.filter(e => activeRe!.test(e.message) || activeRe!.test(e.source));
        } catch {
          // Invalid regex → fall back to literal
          const q = this.searchQuery.slice(1).toLowerCase();
          entries  = entries.filter(e => e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q));
        }
      } else {
        const q = this.searchQuery.toLowerCase();
        entries  = entries.filter(e => e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q));
      }
    }

    // Cache for Ctrl+S export
    this.cachedEntries = entries;

    const timeLabel = TIME_LABELS.find(t => t.ms === this.timeRange)?.label ?? "all";
    const lines: string[] = [
      `{bold}{blue-fg}◈ LOG TELESCOPE{/bold}{/}  {#666677-fg}${entries.length} entries{/}` +
      (this.searchQuery ? `  {yellow-fg}search: "${trunc(this.searchQuery, 30)}"{/}` : "") +
      (this.levelFilter !== "all" ? `  {cyan-fg}level:${this.levelFilter}{/}` : "") +
      (this.timeRange != null ? `  {#c084fc-fg}last ${timeLabel}{/}` : ""),
      `{#666677-fg}1=1m 5=5m h=1h 0=all  /=search  x=clear  Ctrl+S=export  level buttons below{/}`,
      "{#3a3a4a-fg}" + "─".repeat(80) + "{/}",
    ];

    for (const e of entries.slice(-500)) {
      const t   = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
      const lvl = LEVEL_COLOR[e.level] ?? "";
      const src = `{#5c8aff-fg}[${e.source.slice(0, 12).padEnd(12)}]{/}`;
      let msg = trunc(e.message, 300);

      // Highlight matches
      if (activeRe) {
        msg = msg.replace(activeRe, (m) => `{yellow-fg}${m}{/}`);
      } else if (this.searchQuery && !this.searchQuery.startsWith("/")) {
        const escaped = this.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        msg = msg.replace(new RegExp(`(${escaped})`, "gi"), "{yellow-fg}$1{/}");
      }

      lines.push(`{#666677-fg}${t}{/} ${lvl} ${src} ${msg}`);
      if (e.detail) {
        for (const d of e.detail) lines.push(d);
      }
    }

    if (entries.length === 0) lines.push("{#444455-fg}  No entries match the current filter{/}");
    if (this.exportMsg) lines.push("", this.exportMsg);
    return lines.join("\n");
  }
}
