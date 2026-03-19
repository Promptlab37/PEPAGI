// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Pipeline Visualization Widget
// ═══════════════════════════════════════════════════════════════
//
// Overlay widget showing a horizontal pipeline flow diagram.
// Opened via keyboard shortcut from the Pipeline panel or main dashboard.

import type { DashboardState, TaskRow } from "../state.js";
import { BaseView } from "../views/base-view.js";
import type { AnyElement } from "../views/base-view.js";
import { trunc, fmtDuration, fmtCost } from "../theme.js";

const STAGE_ICONS: Record<string, string> = {
  pending:          "○ pending",
  queued:           "◌ queued",
  assigned:         "◐ assigned",
  running:          "● running",
  waiting_subtasks: "⊙ waiting",
  review:           "◉ review",
  completed:        "✓ done",
  failed:           "✗ failed",
  cancelled:        "— cancel",
};

const STAGE_COLOR: Record<string, string> = {
  pending: "#666677", queued: "#888899", assigned: "#5c8aff",
  running: "#00e5cc", waiting_subtasks: "#ffd93d", review: "#c084fc",
  completed: "#4ade80", failed: "#ff6b6b", cancelled: "#888899",
};

function stageNode(status: string): string {
  const icon  = STAGE_ICONS[status] ?? status;
  const color = STAGE_COLOR[status] ?? "white";
  return `{${color}-fg}[ ${icon} ]{/}`;
}

function renderTaskFlow(task: TaskRow, width: number): string[] {
  const lines: string[] = [];
  const titleStr = trunc(task.title, Math.max(20, width - 40));
  lines.push(`  {bold}{#aaaacc-fg}${titleStr}{/bold}{/}`);

  // Horizontal stage flow
  const stages: Array<[string, boolean]> = [
    ["pending",  true],
    ["assigned", task.assignedAt != null],
    ["running",  task.startedAt  != null],
    ["completed", task.status === "completed" || task.status === "failed"],
  ];
  const flow = stages.map(([s, reached]) => {
    const color = reached ? (STAGE_COLOR[s] ?? "white") : "#3a3a4a";
    const icon  = reached ? "●" : "○";
    return `{${color}-fg}${icon} ${s}{/}`;
  }).join(" {#3a3a4a-fg}──►{/} ");
  lines.push(`  ${flow}`);

  // Timing row
  const now    = Date.now();
  const endMs  = task.durationMs != null ? task.createdAt + task.durationMs : now;
  const timings: string[] = [];
  if (task.assignedAt) timings.push(`pend:${fmtDuration(task.assignedAt - task.createdAt)}`);
  if (task.startedAt && task.assignedAt) timings.push(`asgn:${fmtDuration(task.startedAt - task.assignedAt)}`);
  if (task.startedAt) timings.push(`run:${fmtDuration(endMs - task.startedAt)}`);
  if (timings.length > 0) {
    lines.push(`  {#555566-fg}${timings.join("  ·  ")}{/}`);
  }
  const cost = task.cost > 0 ? `  {yellow-fg}${fmtCost(task.cost)}{/}` : "";
  const agent = task.agent ? `  {cyan-fg}${task.agent}{/}` : "";
  if (cost || agent) lines.push(`  {#888899-fg}cost:{/}${cost}${agent}`);

  return lines;
}

export class PipelineVizView extends BaseView {
  constructor(screen: AnyElement) {
    super(screen, { title: "PIPELINE VIZ", fKey: "P", width: "85%", height: "80%", borderColor: "#00e5cc" });
  }

  protected renderContent(state: DashboardState): string {
    const lines: string[] = [
      "{bold}{cyan-fg}◈ PIPELINE VISUALIZATION{/bold}{/}",
      "{#666677-fg}Task flow diagram — active and recent tasks{/}",
      "",
    ];

    const active    = [...state.activeTasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    const completed = state.completedTasks.slice(-5).reverse();
    const width     = 80;

    if (active.length === 0 && completed.length === 0) {
      lines.push("{#444455-fg}  No tasks yet{/}");
      return lines.join("\n");
    }

    if (active.length > 0) {
      lines.push("{#888899-fg}ACTIVE TASKS{/}");
      lines.push("{#3a3a4a-fg}" + "─".repeat(width) + "{/}");
      for (const t of active.slice(0, 8)) {
        for (const l of renderTaskFlow(t, width)) lines.push(l);
        lines.push("");
      }
    }

    if (completed.length > 0) {
      lines.push("{#888899-fg}RECENTLY COMPLETED{/}");
      lines.push("{#3a3a4a-fg}" + "─".repeat(width) + "{/}");
      for (const t of completed) {
        for (const l of renderTaskFlow(t, width)) lines.push(l);
        lines.push("");
      }
    }

    lines.push(
      "{#3a3a4a-fg}" + "─".repeat(width) + "{/}",
      `{#666677-fg}Active: {cyan-fg}${active.length}{/}  Done: {green-fg}${state.totalCompleted}{/}  Failed: {red-fg}${state.totalFailed}{/}{/}`,
    );

    return lines.join("\n");
  }
}
