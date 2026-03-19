// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F1: Command Center (VS Code-style palette)
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import { blessed } from "../cjs.js";
import type { AnyElement } from "./base-view.js";

interface PaletteItem {
  label:       string;
  description: string;
  action:      string;   // slash command, F-key string, or free text
  hint?:       string;   // keyboard shortcut hint
}

const PALETTE_ITEMS: PaletteItem[] = [
  { label: "Show Status",             description: "Active tasks, agents, session stats",            action: "/status",  hint: ">" },
  { label: "Show Cost Breakdown",     description: "Session cost breakdown by agent and model",      action: "/cost" },
  { label: "Pause Display",           description: "Freeze all panel updates",                       action: "/pause",   hint: "Space" },
  { label: "Resume Display",          description: "Unfreeze panel updates",                         action: "/resume" },
  { label: "Clear Event Log",         description: "Wipe the Neural Stream event log",               action: "/clear" },
  { label: "Show Memory Stats",       description: "Episodes · facts · procedures · skills counts",  action: "/memory" },
  { label: "Show Help",               description: "All keyboard shortcuts and commands",            action: "/help" },
  { label: "Open Memory Explorer",    description: "Browse 5-level cognitive memory",               action: "F2",       hint: "F2" },
  { label: "Open Log Telescope",      description: "Full-screen event log with regex search",       action: "F3",       hint: "F3" },
  { label: "Open Agent Observatory",  description: "Detailed per-agent performance cards",          action: "F4",       hint: "F4" },
  { label: "Open Consciousness Lab",  description: "Qualia state and inner monologue",              action: "F5",       hint: "F5" },
  { label: "Open Security Fortress",  description: "Security events, tripwires, threat level",      action: "F6",       hint: "F6" },
  { label: "Open Evolution Engine",   description: "Self-improvement: reflections and skills",      action: "F7",       hint: "F7" },
  { label: "Open Secure Vault",       description: "Encrypted API key management",                  action: "F8",       hint: "F8" },
  { label: "Open Network Sonar",      description: "Platform connections and latency",              action: "F9",       hint: "F9" },
  { label: "Toggle Decision Replay",  description: "Step through mediator decision history",        action: "/replay",  hint: "C-R" },
  { label: "Toggle Thought Graph",    description: "Visualize the reasoning chain graph",           action: "/graph",   hint: "C-G" },
  { label: "Acknowledge Anomaly",     description: "Dismiss the top unacknowledged anomaly",        action: "/ack" },
];

export class CommandCenterView extends BaseView {
  private filterBox: AnyElement;
  private listBox:   AnyElement;
  private query    = "";
  private selIdx   = 0;

  constructor(
    screen:  AnyElement,
    private readonly onAction: (action: string) => void,
  ) {
    super(screen, { title: "COMMAND CENTER", fKey: "F1", width: "72%", height: "82%", borderColor: "cyan" });

    // BaseView's content element is not used in palette mode
    this.content.hide();

    // Filter input at top of overlay
    this.filterBox = blessed.textbox({
      parent:       this.box,
      top:          1,
      left:         1,
      width:        "100%-4",
      height:       3,
      tags:         true,
      inputOnFocus: true,
      border:       { type: "line", fg: "cyan" },
      label:        " {#888899-fg}Filter commands — type, ↑↓ navigate, Enter execute, Esc close{/} ",
      style:        { fg: "white", bg: "#0a0a16", focus: { border: { fg: "#00e5cc" } } },
    });

    // Palette items list below filter
    this.listBox = blessed.box({
      parent:     this.box,
      top:        4,
      left:       1,
      width:      "100%-4",
      height:     "100%-7",
      tags:       true,
      scrollable: false,
      style:      { fg: "white", bg: "#0a0a16" },
    });

    this.filterBox.on("keypress", (_ch: unknown, key: { name: string }) => {
      const k = key.name;
      if (k === "escape")                  { this.hide(); return; }
      if (k === "up")                      { this.selIdx = Math.max(0, this.selIdx - 1); this.renderList(); return; }
      if (k === "down")                    { this.selIdx = Math.min(this.filtered().length - 1, this.selIdx + 1); this.renderList(); return; }
      if (k === "enter" || k === "return") {
        const item = this.filtered()[this.selIdx];
        const raw  = (this.filterBox.getValue() as string).trim();
        if (item)      this.onAction(item.action);
        else if (raw)  this.onAction(raw);
        this.hide();
        return;
      }
      // Any other key: re-filter on next tick after textbox updates its value
      setImmediate(() => {
        this.query  = this.filterBox.getValue() as string;
        this.selIdx = 0;
        this.renderList();
        (this.box.screen as AnyElement)?.render();
      });
    });
  }

  override show(): void {
    super.show();
    this.filterBox.clearValue();
    this.query  = "";
    this.selIdx = 0;
    this.renderList();
    this.filterBox.focus();
  }

  protected renderContent(_state: DashboardState): string { return ""; }

  override update(_state: DashboardState): void { /* palette managed by show() + keypress */ }

  // ── Private helpers ─────────────────────────────────────────

  private filtered(): PaletteItem[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return PALETTE_ITEMS;
    return PALETTE_ITEMS.filter(i =>
      i.label.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      i.action.toLowerCase().includes(q),
    );
  }

  private renderList(): void {
    const items = this.filtered();
    if (this.selIdx >= items.length) this.selIdx = Math.max(0, items.length - 1);

    const lines: string[] = [
      `{#666677-fg}${items.length} / ${PALETTE_ITEMS.length} commands{/}`,
      "",
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const sel  = i === this.selIdx;
      const arrow  = sel ? "{cyan-fg}▶{/}" : " ";
      const labelC = sel ? "{bold}{white-fg}" : "{#aaaacc-fg}";
      const actC   = sel ? "{yellow-fg}" : "{#3a3a4a-fg}";
      const hintStr = item.hint ? `  {#555566-fg}[${item.hint}]{/}` : "";
      lines.push(
        `  ${arrow} ${labelC}${item.label}{/}  ${actC}${item.action}{/}${hintStr}`,
        `      {#555566-fg}${item.description}{/}`,
      );
    }

    this.listBox.setContent(lines.join("\n"));
  }
}
