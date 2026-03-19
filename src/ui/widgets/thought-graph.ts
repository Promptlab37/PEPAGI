// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Widget: Thought Graph (Ctrl+G)
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { blessed } from "../cjs.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { trunc } from "../theme.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

const CAUSAL_DIR = join(homedir(), ".pepagi", "causal");

interface CausalNodeDisk {
  id:           string;
  taskId:       string;
  action:       string;
  reason:       string;
  parentNodeId: string | null;
  timestamp:    string;
  outcome:      "success" | "failure" | "pending";
  counterfactual?: string;
}

interface CausalTask { taskId: string; nodes: CausalNodeDisk[]; }

async function loadCausalTasks(): Promise<CausalTask[]> {
  if (!existsSync(CAUSAL_DIR)) return [];
  try {
    const files = await readdir(CAUSAL_DIR);
    const jsonFiles = (files as string[]).filter(f => f.endsWith(".json")).sort().reverse(); // newest first
    const tasks = await Promise.all(jsonFiles.map(async (f) => {
      try {
        const content = await readFile(join(CAUSAL_DIR, f), "utf8");
        const nodes   = JSON.parse(content) as CausalNodeDisk[];
        const taskId  = f.replace(".json", "");
        return { taskId, nodes: Array.isArray(nodes) ? nodes : [] };
      } catch { return null; }
    }));
    return tasks.filter((t): t is CausalTask => t !== null && t.nodes.length > 0);
  } catch { return []; }
}

function renderTree(nodes: CausalNodeDisk[], width: number): string[] {
  const actC: Record<string, string> = {
    decompose: "cyan", assign: "blue", complete: "green",
    fail: "red", ask_user: "yellow", swarm: "purple",
    verify: "#c084fc", synthesize: "#00e5cc",
  };
  const outC  = (o: string) => o === "success" ? "green" : o === "failure" ? "red" : "#666677";
  const outI  = (o: string) => o === "success" ? "✓" : o === "failure" ? "✗" : "○";

  // Build parent → children map
  const children = new Map<string | null, CausalNodeDisk[]>();
  for (const n of nodes) {
    const pid = n.parentNodeId ?? null;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid)!.push(n);
  }

  const lines: string[] = [];
  const maxReasonW = Math.max(20, width - 36);

  function renderNode(node: CausalNodeDisk, depth: number, isLast: boolean): void {
    const indent = "  ".repeat(depth);
    const branch = depth === 0 ? "" : (isLast ? "└─ " : "├─ ");
    const oc     = outC(node.outcome);
    const ac     = actC[node.action] ?? "white";
    const ts     = node.timestamp
      ? new Date(node.timestamp).toLocaleTimeString("en-GB", { hour12: false })
      : "??:??:??";

    lines.push(
      `{#666677-fg}${indent}${branch}{/}{${oc}-fg}[${outI(node.outcome)}]{/} ` +
      `{${ac}-fg}${node.action.padEnd(9)}{/}  ` +
      `{white-fg}${trunc(node.reason, maxReasonW - depth * 2)}{/}  ` +
      `{#444455-fg}${ts}{/}`,
    );

    // Counterfactual
    if (node.counterfactual) {
      const cfIndent = "  ".repeat(depth + 1) + (isLast ? "   " : "│  ");
      lines.push(
        `{#666677-fg}${cfIndent}↯ {/}{#888877-fg}${trunc(node.counterfactual, Math.max(20, width - (depth + 1) * 2 - 40))}{/}`,
      );
    }

    const kids = children.get(node.id) ?? [];
    kids.forEach((k, i) => renderNode(k, depth + 1, i === kids.length - 1));
  }

  const roots = children.get(null) ?? [];
  if (roots.length === 0 && nodes.length > 0) {
    // No proper root — just render all flat
    nodes.forEach((n, i) => renderNode(n, 0, i === nodes.length - 1));
  } else {
    roots.forEach((r, i) => renderNode(r, 0, i === roots.length - 1));
  }
  return lines.length > 0 ? lines : ["{#444455-fg}  No nodes in chain{/}"];
}

export class ThoughtGraphWidget {
  private box:     AnyElement;
  private content: AnyElement;
  private _visible = false;
  private tasks:    CausalTask[] = [];
  private taskIdx   = 0;
  private loading   = false;

  constructor(screen: AnyElement) {
    this.box = blessed.box({
      parent: screen, top: "center", left: "center",
      width: "82%", height: "72%",
      tags: true, border: { type: "line", fg: "#c084fc" },
      label: " {bold}{purple-fg}[Ctrl+G] THOUGHT GRAPH{/}{/} ",
      style: { fg: "white", bg: "#0a0a16", border: { fg: "#c084fc" } },
      hidden: true, shadow: true,
    });

    this.content = blessed.box({
      parent: this.box, top: 1, left: 1,
      width: "100%-4", height: "100%-4",
      tags: true, scrollable: true, alwaysScroll: false,
      scrollbar: { ch: "│", style: { fg: "#3a3a4a" } },
      style: { fg: "white", bg: "#0a0a16" },
    });

    blessed.box({
      parent: this.box, bottom: 1, left: 1,
      width: "100%-4", height: 1, tags: true,
      content: " {#666677-fg}[← →] task  [↑↓] scroll  [r] reload  [Escape] close{/} ",
      style: { fg: "grey", bg: "#0a0a16" },
    });

    this.content.key("left",  () => { if (this.taskIdx > 0) { this.taskIdx--; this.doRender(); } });
    this.content.key("right", () => { if (this.taskIdx < this.tasks.length - 1) { this.taskIdx++; this.doRender(); } });
    this.content.key("home",  () => { this.taskIdx = 0; this.doRender(); });
    this.content.key("end",   () => {
      if (this.tasks.length > 0) { this.taskIdx = this.tasks.length - 1; this.doRender(); }
    });
    this.content.key("r", () => { void this.reload(); });
  }

  show(): void {
    this._visible = true;
    this.box.show();
    this.content.focus();
    void this.reload();
  }

  hide(): void { this._visible = false; this.box.hide(); }
  isVisible(): boolean { return this._visible; }

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.doRender();
    try {
      this.tasks = await loadCausalTasks();
      if (this.taskIdx >= this.tasks.length) this.taskIdx = Math.max(0, this.tasks.length - 1);
    } finally {
      this.loading = false;
    }
    this.doRender();
  }

  private doRender(): void {
    const w = (this.box.width ?? 70) - 6;
    if (this.loading) {
      this.content.setContent("{#444455-fg}  Loading causal chains…{/}");
      return;
    }
    if (this.tasks.length === 0) {
      this.content.setContent([
        "{bold}{purple-fg}◈ CAUSAL DECISION GRAPH{/bold}{/}",
        "",
        "{#444455-fg}  No causal chain files found.{/}",
        `  {#444455-fg}Path: ${CAUSAL_DIR}{/}`,
        "",
        "  {#666677-fg}Chains are saved after each task completes.{/}",
        "  {#666677-fg}Run some tasks to populate this view.{/}",
      ].join("\n"));
      return;
    }
    const task    = this.tasks[this.taskIdx]!;
    const success = task.nodes.filter(n => n.outcome === "success").length;
    const failure = task.nodes.filter(n => n.outcome === "failure").length;
    const pending = task.nodes.filter(n => n.outcome === "pending").length;
    const cfs     = task.nodes.filter(n => n.counterfactual).length;

    const lines = [
      `{bold}{purple-fg}◈ CAUSAL GRAPH{/bold}{/}  {#666677-fg}task {/}{cyan-fg}${task.taskId.slice(0, 14)}{/}  ` +
      `{#444455-fg}(${this.taskIdx + 1}/${this.tasks.length}){/}`,
      `{#666677-fg}${task.nodes.length} nodes  ` +
      `{green-fg}✓${success}{/} {red-fg}✗${failure}{/} {#666677-fg}○${pending}{/}` +
      (cfs > 0 ? `  {#888877-fg}↯${cfs} counterfactuals{/}` : "") + `{/}`,
      "{#3a3a4a-fg}" + "─".repeat(w) + "{/}",
      "",
      ...renderTree(task.nodes, w),
    ];
    this.content.setContent(lines.join("\n"));
  }

  // Called from dashboard redraw — live state not needed here, driven by files
  update(_state: DashboardState): void { /* no-op */ }

  getElement(): AnyElement { return this.box; }
}
