// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Dashboard Orchestrator
// ═══════════════════════════════════════════════════════════════

import { eventBus } from "../core/event-bus.js";
import type { PepagiEvent, AgentProvider } from "../core/types.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createInitialState, pushBounded, pushBoundedHistory,
  type DashboardState, type TaskRow, type LogEntry, type SecurityEvent, type DecisionRecord,
  type AgentStat,
} from "./state.js";
import { computeLayout, isPanelVisible } from "./adaptive-layout.js";
import { scanAnomalies, topAnomaly, severityColor } from "./anomaly-detector.js";
import { resolveKey, nextPanel, prevPanel, KEY_HELP } from "./keybindings.js";
import {
  fmtCost, fmtUptime, trunc, dominantQualiaEmoji, C,
  REDRAW_INTERVAL_MS, MAX_LOG_LINES, MAX_SPARKLINE_POINTS, BRAILLE_FRAMES,
} from "./theme.js";
import { migrateConfigKeys } from "./config-crypto.js";
import { blessed } from "./cjs.js";

// Panels
import { NeuralStreamPanel }  from "./panels/neural-stream.js";
import { ConsciousnessPanel } from "./panels/consciousness.js";
import { PipelinePanel }      from "./panels/pipeline.js";
import { AgentPoolPanel }     from "./panels/agent-pool.js";
import { MemoryCostPanel }    from "./panels/memory-cost.js";

// Views (F1-F9)
import { CommandCenterView }    from "./views/command-center.js";
import { MemoryExplorerView }   from "./views/memory-explorer.js";
import { LogTelescopeView }     from "./views/log-telescope.js";
import { AgentObservatoryView } from "./views/agent-observatory.js";
import { ConsciousnessLabView } from "./views/consciousness-lab.js";
import { SecurityFortressView } from "./views/security-fortress.js";
import { EvolutionEngineView }  from "./views/evolution-engine.js";
import { SecureVaultView }      from "./views/secure-vault.js";
import { NetworkSonarView }     from "./views/network-sonar.js";

// Widgets
import { DecisionReplayWidget } from "./widgets/decision-replay.js";
import { ThoughtGraphWidget }   from "./widgets/thought-graph.js";

// ── View interface ─────────────────────────────────────────────

interface TuiView {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  update(s: DashboardState): void;
}

// ── Dashboard ─────────────────────────────────────────────────

export class PepagiDashboard {
  private state:  DashboardState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private screen: any;

  private neural:        NeuralStreamPanel  | null = null;
  private consciousness: ConsciousnessPanel | null = null;
  private pipeline:      PipelinePanel      | null = null;
  private agentPool:     AgentPoolPanel     | null = null;
  private memoryCost:    MemoryCostPanel    | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private topBar:    any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bottomBar: any;

  private views: Map<string, TuiView> = new Map();
  private decisionReplay: DecisionReplayWidget | null = null;
  private thoughtGraph:   ThoughtGraphWidget   | null = null;

  private redrawTimer:   ReturnType<typeof setInterval> | null = null;
  private anomalyTimer:  ReturnType<typeof setInterval> | null = null;
  private memStatsTimer: ReturnType<typeof setInterval> | null = null;
  private _anyHandler: ((e: PepagiEvent) => void) | null = null;
  private prevQualia: Record<string, number> = {};

  // ── Readline state ───────────────────────────────────────────
  private cmdBuffer      = "";
  private cmdCursorPos   = 0;
  private cmdHistory:    string[] = [];
  private cmdHistoryIdx  = -1;
  private cmdInputActive = false;

  constructor(private readonly onTaskSubmit?: (task: string) => void) {
    this.state = createInitialState();
  }

  // ── Start ────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      const migrated = await migrateConfigKeys(`${PEPAGI_DATA_DIR}/config.json`);
      if (migrated > 0) this.log("info", "vault", `Migrated ${migrated} plaintext API key(s) to encrypted storage`);
    } catch { /* non-fatal */ }

    this.screen = blessed.screen({
      smartCSR:     true,
      fullUnicode:  true,
      title:        "PEPAGI",
      cursor:       { artificial: true, shape: "line", blink: true, color: "cyan" },
      dockBorders:  false,
      ignoreLocked: ["C-c"],
    });

    this.buildLayout();
    this.subscribeEvents();
    this.startTimers();
    this.screen.render();
  }

  stop(): void {
    if (this.redrawTimer)   clearInterval(this.redrawTimer);
    if (this.anomalyTimer)  clearInterval(this.anomalyTimer);
    if (this.memStatsTimer) clearInterval(this.memStatsTimer);
    if (this._anyHandler)   eventBus.offAny(this._anyHandler);
    try { this.screen?.destroy(); } catch { /* ignore */ }
  }

  // ── Layout ───────────────────────────────────────────────────

  private buildLayout(): void {
    const cols = this.screen.width  as number;
    const rows = this.screen.height as number;
    const geom = computeLayout(cols, rows);

    // Top bar
    this.topBar = blessed.box({
      parent: this.screen, top: 0, left: 0, width: "100%", height: geom.topBar.height,
      tags: true,
      border: { type: "line", fg: "#1a1a2e" },
      style: { fg: "white", bg: "#0d0d1a", border: { fg: "#1a1a2e" } },
    });

    // Bottom bar (3-row bordered readline strip)
    this.bottomBar = blessed.box({
      parent: this.screen, bottom: 0, left: 0, width: "100%", height: geom.bottomBar.height,
      tags: true,
      border: { type: "line", fg: "#3a3a4a" },
      style:  { fg: "#666677", bg: "#0d0d1a", border: { fg: "#3a3a4a" } },
    });

    // Main container
    const main = blessed.box({
      parent: this.screen, top: geom.topBar.height, left: 0,
      width: "100%", height: geom.neural.height,
      style: { bg: "black" },
    });

    // Panels — only create what's visible in the current layout mode
    const mode = geom.mode;
    this.neural = new NeuralStreamPanel(
      main, { top: 0, left: 0, width: geom.neural.width, height: geom.neural.height },
    );
    if (isPanelVisible("consciousness", mode)) {
      this.consciousness = new ConsciousnessPanel(
        main, { top: 0, left: geom.consciousness.left, width: geom.consciousness.width, height: geom.consciousness.height },
      );
    }
    if (isPanelVisible("pipeline", mode)) {
      this.pipeline = new PipelinePanel(
        main, { top: 0, left: geom.pipeline.left, width: geom.pipeline.width, height: geom.pipeline.height },
      );
    }
    if (isPanelVisible("agentPool", mode)) {
      this.agentPool = new AgentPoolPanel(
        main, { top: 0, left: geom.agentPool.left, width: geom.agentPool.width, height: geom.agentPool.height },
      );
    }
    if (isPanelVisible("memoryCost", mode)) {
      this.memoryCost = new MemoryCostPanel(
        main, { top: geom.agentPool.height, left: geom.memoryCost.left, width: geom.memoryCost.width, height: geom.memoryCost.height },
      );
    }

    // F-key views
    this.views.set("F1", new CommandCenterView(this.screen, (action) => this.executeCommand(action)));
    this.views.set("F2", new MemoryExplorerView(this.screen));
    this.views.set("F3", new LogTelescopeView(this.screen));
    this.views.set("F4", new AgentObservatoryView(this.screen));
    this.views.set("F5", new ConsciousnessLabView(this.screen));
    this.views.set("F6", new SecurityFortressView(this.screen));
    this.views.set("F7", new EvolutionEngineView(this.screen));
    this.views.set("F8", new SecureVaultView(this.screen));
    this.views.set("F9", new NetworkSonarView(this.screen));

    // Floating widgets
    this.decisionReplay = new DecisionReplayWidget(this.screen);
    this.thoughtGraph   = new ThoughtGraphWidget(this.screen);

    // Key handler
    this.screen.on("keypress", (_ch: unknown, key: { name: string; ctrl: boolean; shift: boolean }) => {
      const name = key.ctrl ? `C-${key.name}` : key.shift ? `S-${key.name}` : key.name;
      this.handleKey(name);
    });

    // Resize: re-render (blessed handles repositioning)
    this.screen.on("resize", () => this.screen.render());
  }

  // ── Key handling ─────────────────────────────────────────────

  private handleKey(keyName: string): void {
    // Route all keys to readline when input is active
    if (this.cmdInputActive) { this.handleInputKey(keyName); return; }

    // Widget-specific keys
    if (this.decisionReplay?.isVisible()) {
      if (keyName === "left")   { this.adjReplayIdx(-1); return; }
      if (keyName === "right")  { this.adjReplayIdx(+1); return; }
      if (keyName === "home")   { this.state.replayIndex = 0; return; }
      if (keyName === "end")    { this.state.replayIndex = -1; return; }
      if (keyName === "escape") { this.decisionReplay.hide(); return; }
    }
    if (this.thoughtGraph?.isVisible()) {
      if (keyName === "escape") { this.thoughtGraph.hide(); return; }
    }
    // Overlay close
    if (this.state.activeView && keyName === "escape") {
      this.views.get(this.state.activeView)?.hide();
      this.state.activeView = null;
      return;
    }

    const action = resolveKey(keyName);
    switch (action.type) {
      case "open_view": {
        if (this.state.activeView) this.views.get(this.state.activeView)?.hide();
        if (this.state.activeView === action.view) { this.state.activeView = null; }
        else { this.state.activeView = action.view; this.views.get(action.view)?.show(); }
        break;
      }
      case "close_view": {
        if (this.state.activeView) { this.views.get(this.state.activeView)?.hide(); this.state.activeView = null; }
        break;
      }
      case "focus_panel": {
        this.state.focusedPanel = action.panel === "next"
          ? nextPanel(this.state.focusedPanel)
          : prevPanel(this.state.focusedPanel);
        this.updatePanelFocus();
        break;
      }
      case "toggle_pause": {
        this.state.paused = !this.state.paused;
        this.log("info", "tui", this.state.paused ? "Display paused" : "Display resumed");
        break;
      }
      case "decision_replay_open": {
        this.decisionReplay?.isVisible() ? this.decisionReplay.hide() : this.decisionReplay?.show();
        break;
      }
      case "decision_replay_prev": { if (this.decisionReplay?.isVisible()) this.adjReplayIdx(-1); break; }
      case "decision_replay_next": { if (this.decisionReplay?.isVisible()) this.adjReplayIdx(+1); break; }
      case "thought_graph_open": {
        this.thoughtGraph?.isVisible() ? this.thoughtGraph.hide() : this.thoughtGraph?.show();
        break;
      }
      case "ack_anomaly": {
        const top = topAnomaly(this.state);
        if (top) { top.acknowledged = true; this.log("info", "tui", `Ack: ${top.message.slice(0, 40)}`); }
        break;
      }
      case "search_mode": {
        // "/" activates readline with "/" pre-filled
        this.cmdInputActive = true;
        this.cmdBuffer      = "/";
        this.cmdCursorPos   = 1;
        this.cmdHistoryIdx  = -1;
        break;
      }
      case "none": {
        // Enter when no view/widget active → activate readline
        if (keyName === "enter" || keyName === "return") {
          this.cmdInputActive = true;
          this.cmdBuffer      = "";
          this.cmdCursorPos   = 0;
          this.cmdHistoryIdx  = -1;
        }
        break;
      }
      case "quit": { this.stop(); process.exit(0); }
    }
  }

  // ── Readline ─────────────────────────────────────────────────

  private handleInputKey(keyName: string): void {
    switch (keyName) {
      case "escape":
      case "C-c":
        this.cmdInputActive = false;
        this.cmdBuffer      = "";
        this.cmdCursorPos   = 0;
        this.cmdHistoryIdx  = -1;
        break;
      case "enter":
      case "return": {
        const trimmed = this.cmdBuffer.trim();
        if (trimmed) {
          this.cmdHistory.unshift(trimmed);
          if (this.cmdHistory.length > 50) this.cmdHistory.length = 50;
          this.executeCommand(trimmed);
        }
        this.cmdInputActive = false;
        this.cmdBuffer      = "";
        this.cmdCursorPos   = 0;
        this.cmdHistoryIdx  = -1;
        break;
      }
      case "backspace":
        if (this.cmdCursorPos > 0) {
          this.cmdBuffer    = this.cmdBuffer.slice(0, this.cmdCursorPos - 1) + this.cmdBuffer.slice(this.cmdCursorPos);
          this.cmdCursorPos--;
        }
        break;
      case "delete":
        if (this.cmdCursorPos < this.cmdBuffer.length) {
          this.cmdBuffer = this.cmdBuffer.slice(0, this.cmdCursorPos) + this.cmdBuffer.slice(this.cmdCursorPos + 1);
        }
        break;
      case "left":
        this.cmdCursorPos = Math.max(0, this.cmdCursorPos - 1);
        break;
      case "right":
        this.cmdCursorPos = Math.min(this.cmdBuffer.length, this.cmdCursorPos + 1);
        break;
      case "C-a":
      case "home":
        this.cmdCursorPos = 0;
        break;
      case "C-e":
      case "end":
        this.cmdCursorPos = this.cmdBuffer.length;
        break;
      case "C-k":
        this.cmdBuffer    = this.cmdBuffer.slice(0, this.cmdCursorPos);
        break;
      case "C-u":
        this.cmdBuffer    = this.cmdBuffer.slice(this.cmdCursorPos);
        this.cmdCursorPos = 0;
        break;
      case "up":
        if (this.cmdHistory.length > 0) {
          this.cmdHistoryIdx = Math.min(this.cmdHistory.length - 1, this.cmdHistoryIdx + 1);
          this.cmdBuffer     = this.cmdHistory[this.cmdHistoryIdx] ?? "";
          this.cmdCursorPos  = this.cmdBuffer.length;
        }
        break;
      case "down":
        if (this.cmdHistoryIdx > 0) {
          this.cmdHistoryIdx--;
          this.cmdBuffer    = this.cmdHistory[this.cmdHistoryIdx] ?? "";
          this.cmdCursorPos = this.cmdBuffer.length;
        } else {
          this.cmdHistoryIdx = -1;
          this.cmdBuffer     = "";
          this.cmdCursorPos  = 0;
        }
        break;
      default:
        if (keyName.length === 1 && keyName >= " ") {
          this.cmdBuffer    = this.cmdBuffer.slice(0, this.cmdCursorPos) + keyName + this.cmdBuffer.slice(this.cmdCursorPos);
          this.cmdCursorPos++;
        }
        break;
    }
  }

  private executeCommand(cmd: string): void {
    // F-key navigation from palette
    if (/^F[1-9]$/.test(cmd)) {
      if (this.state.activeView) this.views.get(this.state.activeView)?.hide();
      this.state.activeView = cmd;
      this.views.get(cmd)?.show();
      return;
    }

    this.log("info", "user", `> ${cmd}`);

    if (cmd.startsWith("/")) {
      const parts = cmd.slice(1).split(" ");
      const name  = parts[0]?.toLowerCase() ?? "";
      const args  = parts.slice(1).join(" ");
      switch (name) {
        case "status":
          this.log("info", "cmd",
            `Active:${this.state.activeTasks.size}  Done:${this.state.totalCompleted}  Failed:${this.state.totalFailed}  Cost:${fmtCost(this.state.sessionCost)}`);
          break;
        case "cost": {
          const agents = [...this.state.agents.values()].filter(a => a.costTotal > 0);
          if (agents.length === 0) {
            this.log("info", "cmd", `Session cost: ${fmtCost(this.state.sessionCost)} — no agent breakdown yet`);
          } else {
            this.log("info", "cmd", `Total: ${fmtCost(this.state.sessionCost)}`);
            for (const a of agents) this.log("info", "cmd", `  ${a.provider}: ${fmtCost(a.costTotal)}`);
          }
          break;
        }
        case "pause":
          this.state.paused = true;
          this.log("info", "cmd", "Display paused — /resume or Space to unpause");
          break;
        case "resume":
          this.state.paused = false;
          this.log("info", "cmd", "Display resumed");
          break;
        case "clear":
          this.state.eventLog = [];
          this.neural?.rebuild(this.state);
          this.log("info", "cmd", "Log cleared");
          break;
        case "memory": {
          const ms = this.state.memoryStats;
          if (args.startsWith("search ")) {
            const q = args.slice(7).trim();
            this.log("info", "cmd", `Memory search: "${q}" — open F2 Memory Explorer for full results`);
          } else {
            this.log("info", "cmd",
              `Memory: ${ms.episodes} episodes  ${ms.facts} facts  ${ms.procedures} procedures  ${ms.skills} skills`);
          }
          break;
        }
        case "help":
          this.log("info", "cmd", "Slash commands: /status /cost /pause /resume /clear /memory [search q] /help /replay /graph /ack /swarm <task>");
          this.log("info", "cmd", "Keys: F1-F9 views  Tab focus  Space pause  / or Enter cmd  C-R replay  C-G graph  a ack  q quit");
          break;
        case "replay":
          this.decisionReplay?.isVisible() ? this.decisionReplay.hide() : this.decisionReplay?.show();
          break;
        case "graph":
          this.thoughtGraph?.isVisible() ? this.thoughtGraph.hide() : this.thoughtGraph?.show();
          break;
        case "ack": {
          const top = topAnomaly(this.state);
          if (top) { top.acknowledged = true; this.log("info", "cmd", `Ack: ${top.message.slice(0, 60)}`); }
          else       this.log("info", "cmd", "No active anomalies");
          break;
        }
        case "swarm":
          if (args) { this.onTaskSubmit?.(args); }
          else       this.log("warn", "cmd", "Usage: /swarm <task description>");
          break;
        default:
          this.log("warn", "cmd", `Unknown: /${name}  —  type /help for commands`);
      }
    } else {
      // Free text → submit as task
      this.onTaskSubmit?.(cmd);
    }
  }

  private adjReplayIdx(delta: number): void {
    const len = this.state.decisions.length;
    if (len === 0) return;
    const cur = this.state.replayIndex === -1 ? len - 1 : this.state.replayIndex;
    const next = Math.max(0, Math.min(len - 1, cur + delta));
    this.state.replayIndex = next >= len - 1 ? -1 : next;
  }

  private updatePanelFocus(): void {
    const map: Record<string, { focus(): void; blur(): void } | null> = {
      neural: this.neural, consciousness: this.consciousness,
      pipeline: this.pipeline, agents: this.agentPool, cost: this.memoryCost,
    };
    for (const [name, panel] of Object.entries(map)) {
      if (!panel) continue;
      if (name === this.state.focusedPanel) panel.focus(); else panel.blur();
    }
  }

  // ── Event subscriptions ──────────────────────────────────────

  private subscribeEvents(): void {
    this._anyHandler = (event: PepagiEvent) => this.handleEvent(event);
    eventBus.onAny(this._anyHandler);
  }

  private handleEvent(event: PepagiEvent): void {
    const now = Date.now();
    let skipLog = false;
    const entry: LogEntry = {
      ts: now, level: "info",
      source: event.type.split(":")[0] ?? "system",
      message: describeEvent(event),
    };

    switch (event.type) {
      case "task:created": {
        const row: TaskRow = {
          id: event.task.id, title: event.task.title, status: event.task.status,
          agent: event.task.assignedTo, difficulty: event.task.difficulty,
          confidence: event.task.confidence, cost: event.task.estimatedCost,
          durationMs: null, createdAt: now, assignedAt: null, startedAt: null, swarmBranches: 0,
          result: null,
        };
        this.state.activeTasks.set(event.task.id, row);
        break;
      }
      case "task:assigned": {
        const r = this.state.activeTasks.get(event.taskId);
        if (r) { r.agent = event.agent; r.status = "assigned"; r.assignedAt = now; }
        // Ensure agent stat exists and track active request
        if (!this.state.agents.has(event.agent)) {
          this.state.agents.set(event.agent, {
            provider: event.agent, model: event.agent, available: true,
            requestsTotal: 0, requestsActive: 0,
            tokensIn: 0, tokensOut: 0, costTotal: 0,
            latencyMs: [], errorCount: 0, lastUsed: null,
            currentTaskId: null, currentTask: null, lastActivity: null, lastActivityTs: null,
            recentActions: [],
          } satisfies AgentStat);
        }
        const stat = this.state.agents.get(event.agent)!;
        stat.requestsTotal++;
        stat.requestsActive++;
        stat.lastUsed = now;
        break;
      }
      case "task:started": {
        const r = this.state.activeTasks.get(event.taskId);
        if (r) { r.status = "running"; r.startedAt = now; }
        break;
      }
      case "task:completed": {
        const r = this.state.activeTasks.get(event.taskId);
        if (r) {
          r.status = "completed"; r.confidence = event.output.confidence;
          r.result = (typeof event.output.result === "string" ? event.output.result as string : null) || event.output.summary || null;
          if (event.cost !== undefined && event.cost > 0) r.cost = event.cost;
          if (event.agent && !r.agent) r.agent = event.agent as AgentProvider;
          r.durationMs = now - r.createdAt;
          this.state.activeTasks.delete(event.taskId);
          pushBounded(this.state.completedTasks, r, 100);
          this.state.totalCompleted++;
          // Update agent stats
          if (r.agent) {
            const stat = this.state.agents.get(r.agent);
            if (stat) {
              stat.requestsActive = Math.max(0, stat.requestsActive - 1);
              stat.costTotal += r.cost;
              if (r.durationMs) pushBoundedHistory(stat.latencyMs as number[], r.durationMs, 20);
            }
          }
          // Accumulate session cost
          this.state.sessionCost += r.cost;
          pushBoundedHistory(this.state.costHistory, this.state.sessionCost, MAX_SPARKLINE_POINTS);
        }
        break;
      }
      case "task:failed": {
        const r = this.state.activeTasks.get(event.taskId);
        if (r) {
          r.status = "failed"; r.durationMs = now - r.createdAt;
          this.state.activeTasks.delete(event.taskId);
          pushBounded(this.state.completedTasks, r, 100);
          this.state.totalFailed++;
          // Update agent stats - increment errors, decrement active
          if (r.agent) {
            const stat = this.state.agents.get(r.agent);
            if (stat) {
              stat.requestsActive = Math.max(0, stat.requestsActive - 1);
              stat.errorCount++;
              if (r.durationMs) pushBoundedHistory(stat.latencyMs as number[], r.durationMs, 20);
            }
          }
        }
        entry.level = "error";
        break;
      }
      case "mediator:thinking":
        pushBounded(this.state.innerMonologue, event.thought, 20);
        break;
      case "mediator:decision": {
        const d = event.decision;
        // Mark swarm branches on the task row
        if (d.action === "swarm") {
          const r = this.state.activeTasks.get(event.taskId);
          if (r) r.swarmBranches = d.subtasks?.length ?? 2;
        }
        pushBounded(this.state.decisions, {
          ts: now, taskId: event.taskId, decision: d,
          thought: d.consciousnessNote ?? "",
        } satisfies DecisionRecord, 200);
        // Enrich the log entry with decision detail lines
        const detail: string[] = [];
        if (d.reasoning) detail.push(`   {#666677-fg}└─ reason:{/} {#aaaacc-fg}${trunc(d.reasoning, 80)}{/}`);
        if (d.assignment) detail.push(`   {#666677-fg}└─ assign:{/} {cyan-fg}${d.assignment.agent}{/} {#888899-fg}${trunc(d.assignment.reason, 50)}{/}`);
        if (d.subtasks?.length) detail.push(`   {#666677-fg}└─ decompose:{/} {yellow-fg}${d.subtasks.length} subtasks{/} [${d.subtasks.map(s => trunc(s.title, 20)).join(", ")}]`);
        if (detail.length) entry.detail = detail;
        if (d.introspection?.emotionalState) {
          const es = d.introspection.emotionalState;
          if (es.pleasure    !== undefined) this.state.currentQualia["pleasure"]    = es.pleasure;
          if (es.confidence  !== undefined) this.state.currentQualia["confidence"]  = es.confidence;
          if (es.frustration !== undefined) this.state.currentQualia["frustration"] = es.frustration;
          if (es.curiosity   !== undefined) this.state.currentQualia["curiosity"]   = es.curiosity;
        }
        if (d.introspection?.currentFeeling)
          pushBounded(this.state.introspectionHistory, d.introspection.currentFeeling, 50);
        if (d.consciousnessNote)
          pushBounded(this.state.innerMonologue, d.consciousnessNote, 20);
        // Qualia change arrows in neural stream
        const qDeltas: string[] = [];
        for (const [k, v] of Object.entries(this.state.currentQualia)) {
          const prev = this.prevQualia[k];
          if (prev !== undefined) {
            const delta = v - prev;
            if (Math.abs(delta) >= 0.05) {
              const arrow = delta > 0 ? "{green-fg}↑{/}" : "{red-fg}↓{/}";
              qDeltas.push(`{#888899-fg}${k.slice(0, 5)}{/}${arrow}`);
            }
          }
        }
        this.prevQualia = { ...this.state.currentQualia };
        if (qDeltas.length > 0) {
          if (!entry.detail) entry.detail = [];
          entry.detail.push(`   {#666677-fg}└─ qualia Δ:{/} ${qDeltas.join(" ")}`);
        }
        break;
      }
      case "system:cost_warning": {
        pushBounded(this.state.securityEvents, {
          ts: now, type: "cost_warning",
          message: `Cost at ${fmtCost(event.currentCost)} / ${fmtCost(event.limit)} limit`,
          taskId: "",
        } satisfies SecurityEvent, 100);
        entry.level = "warn";
        this.state.sessionCost = event.currentCost;
        pushBoundedHistory(this.state.costHistory, event.currentCost, MAX_SPARKLINE_POINTS);
        break;
      }
      case "security:blocked": {
        pushBounded(this.state.securityEvents, {
          ts: now, type: "blocked", message: event.reason, taskId: event.taskId,
        } satisfies SecurityEvent, 100);
        this.state.threatScore = Math.min(1, this.state.threatScore * 0.9 + 0.3);
        entry.level = "warn";
        break;
      }
      case "meta:watchdog_alert": {
        entry.level = "warn"; entry.source = "watchdog";
        this.state.watchdogLastPing = now;
        pushBounded(this.state.anomalies, {
          id: `wa-${now}`, ts: now, type: "watchdog_alert",
          severity: "medium", message: event.message, acknowledged: false,
        }, 50);
        break;
      }
      case "system:alert": {
        entry.level = event.level === "critical" ? "error" : "warn";
        pushBounded(this.state.anomalies, {
          id: `sa-${now}`, ts: now, type: "system_alert",
          severity: event.level === "critical" ? "high" : "medium",
          message: event.message, acknowledged: false,
        }, 50);
        break;
      }
      case "tool:call": {
        entry.source = "tool";
        const inputStr = event.input ? JSON.stringify(event.input).slice(0, 60) : "";
        entry.detail = [`   {#666677-fg}└─ {/}{cyan-fg}${event.tool}{/}${inputStr ? ` {#888899-fg}${inputStr}{/}` : ""}`];
        break;
      }
      case "tool:result": {
        entry.source = "tool";
        entry.level  = event.success ? "info" : "error";
        entry.detail = [`   {#666677-fg}└─ {/}${event.success ? "{green-fg}✓" : "{red-fg}✗"}{/} {#888899-fg}${trunc(event.output, 60)}{/}`];
        break;
      }
      case "world:simulated": {
        entry.source = "world";
        entry.detail = [
          `   {#666677-fg}└─ winner:{/} {cyan-fg}${event.winner}{/}  ` +
          `{#888899-fg}p(ok)=${(event.predictedSuccess * 100).toFixed(0)}%  ${event.scenarios} scenarios{/}`,
        ];
        break;
      }
      case "planner:plan": {
        entry.source = "planner";
        const lvlColor = event.level === "strategic" ? "purple" : event.level === "tactical" ? "cyan" : "green";
        entry.detail = [`   {#666677-fg}└─ {/}{${lvlColor}-fg}${event.level}{/}  {#888899-fg}${event.steps} steps{/}`];
        break;
      }
      case "causal:node": {
        entry.source = "causal";
        const parentStr = event.parentAction
          ? `  {#666677-fg}← {/}{#888899-fg}${trunc(event.parentAction, 20)}{/}` : "";
        const detail: string[] = [
          `   {#666677-fg}└─ {/}{cyan-fg}${trunc(event.action, 30)}{/}${parentStr}`,
          `   {#444455-fg}   ${trunc(event.reason, 70)}{/}`,
        ];
        if (event.counterfactual)
          detail.push(`   {#3a3a4a-fg}   ↯ ${trunc(event.counterfactual, 60)}{/}`);
        entry.detail = detail;
        break;
      }
      case "consciousness:qualia": {
        // Update all qualia dimensions from phenomenal state engine
        for (const [key, val] of Object.entries(event.qualia)) {
          if (typeof val === "number") this.state.currentQualia[key] = val;
        }
        // Don't log to Neural Stream — too frequent
        skipLog = true;
        break;
      }
    }
    // Push log entry unless skipped (e.g. consciousness:qualia is too frequent)
    if (!skipLog) pushBounded(this.state.eventLog, entry, MAX_LOG_LINES);
    // Slow exponential decay of threat score
    this.state.threatScore = Math.max(0, this.state.threatScore * 0.9997);
  }

  // ── Timers ───────────────────────────────────────────────────

  private startTimers(): void {
    this.redrawTimer  = setInterval(() => this.redraw(), REDRAW_INTERVAL_MS);
    this.anomalyTimer = setInterval(() => {
      for (const a of scanAnomalies(this.state)) pushBounded(this.state.anomalies, a, 50);
    }, 2000);
    // Load memory stats on start, then every 30s
    void this.refreshMemoryStats();
    this.memStatsTimer = setInterval(() => void this.refreshMemoryStats(), 30_000);
  }

  private async refreshMemoryStats(): Promise<void> {
    const countLines = async (file: string): Promise<number> => {
      if (!existsSync(file)) return 0;
      try { return (await readFile(file, "utf8")).split("\n").filter(l => l.trim()).length; }
      catch { return 0; }
    };
    const countDecayed = async (file: string): Promise<number> => {
      if (!existsSync(file)) return 0;
      try {
        const raw = await readFile(file, "utf8");
        return raw.split("\n").filter(l => l.trim()).filter(l => {
          try { return ((JSON.parse(l) as Record<string, unknown>)["confidence"] as number ?? 1) < 0.3; }
          catch { return false; }
        }).length;
      } catch { return 0; }
    };
    const base = PEPAGI_DATA_DIR;
    const [episodes, facts, procedures, working, decayedFacts] = await Promise.all([
      countLines(join(base, "memory", "episodes.jsonl")),
      countLines(join(base, "memory", "knowledge.jsonl")),
      countLines(join(base, "memory", "procedures.jsonl")),
      countLines(join(base, "memory", "working.jsonl")),
      countDecayed(join(base, "memory", "knowledge.jsonl")),
    ]);
    let skills = 0;
    try {
      const files = await readdir(join(base, "skills")).catch(() => [] as string[]);
      skills = (files as string[]).filter(f => f.endsWith(".json") || f.endsWith(".mjs")).length;
    } catch { /* ignore */ }
    let vectors = 0;
    try {
      const files = await readdir(join(base, "vectors")).catch(() => [] as string[]);
      vectors = (files as string[]).length;
    } catch { /* ignore */ }
    this.state.memoryStats = { episodes, facts, procedures, skills, working, decayedFacts, vectors, lastLoaded: Date.now() };
    const mh = this.state.memoryLevelHistory;
    pushBoundedHistory(mh.l2, episodes,              60);
    pushBoundedHistory(mh.l3, facts,                 60);
    pushBoundedHistory(mh.l4, procedures + skills,   60);
    pushBoundedHistory(mh.l5, skills,                60);
  }

  // ── Redraw ───────────────────────────────────────────────────

  private redraw(): void {
    this.updateTopBar();
    this.updateBottomBar();

    // Anomaly pulse: flash Neural Stream border on high-severity unacked anomaly
    const highAnomaly = this.state.anomalies.some(a => !a.acknowledged && a.severity === "high");
    const neuralEl = this.neural?.getElement();
    if (neuralEl && this.state.focusedPanel !== "neural") {
      const pulseOn = highAnomaly && Math.floor(Date.now() / 500) % 2 === 1;
      neuralEl.style.border = { fg: pulseOn ? "#ff6b6b" : "#3a3a4a" };
    }

    if (this.state.activeView) {
      this.views.get(this.state.activeView)?.update(this.state);
    } else {
      this.neural?.update(this.state);
      this.consciousness?.update(this.state);
      this.pipeline?.update(this.state);
      this.agentPool?.update(this.state);
      this.memoryCost?.update(this.state);
    }

    this.decisionReplay?.update(this.state);
    this.thoughtGraph?.update(this.state);

    this.screen.render();
  }

  private updateTopBar(): void {
    const s  = this.state;
    const now = Date.now();
    const dq = dominantQualiaEmoji(s.currentQualia);
    const qualiaStr = Object.keys(s.currentQualia).length > 0 ? ` ${dq.emoji} {#888899-fg}${dq.label}{/}` : "";

    const top  = topAnomaly(s);
    const alertStr = top ? `  ${severityColor(top.severity)}⚠ ${trunc(top.message, 28)}{/}` : "";
    const pausedStr = s.paused ? "  {yellow-fg}[PAUSED]{/}" : "";

    const online  = [...s.agents.values()].filter(a => a.available).length;
    const agentH  = s.agents.size > 0
      ? `${online === s.agents.size ? "{green-fg}" : online > 0 ? "{yellow-fg}" : "{red-fg}"}${online}/${s.agents.size} agents{/}`
      : "{#666677-fg}no agents{/}";

    // Circuit-open flash: check if any agent CB is open
    const cbOpen = [...s.agents.values()].some(a =>
      a.requestsTotal > 0 && (a.errorCount / a.requestsTotal) >= 0.5 && a.errorCount >= 3);
    const cbStr = cbOpen && Math.floor(now / 1000) % 2 === 0
      ? "  {bold}{red-fg}⚠ CIRCUIT OPEN{/bold}{/}" : "";

    const spinChar = s.activeTasks.size > 0
      ? `{cyan-fg}${BRAILLE_FRAMES[Math.floor(now / 80) % BRAILLE_FRAMES.length]!}{/} `
      : "  ";
    const line1 = ` ${spinChar}{bold}{cyan-fg}PEPAGI v0.5.0{/bold}{/}  {#888899-fg}${new Date().toLocaleTimeString("en-GB")}{/}  {yellow-fg}${fmtCost(s.sessionCost)}{/}  ⏱ {cyan-fg}${fmtUptime(s.startTime)}{/}${qualiaStr}${pausedStr}`;
    const ms   = s.memoryStats;
    const tot  = s.totalCompleted + s.totalFailed;
    const sr   = tot > 0 ? s.totalCompleted / tot : 0.5;
    const lm   = Math.min(2.0, 1.0 + Math.min(0.5, ms.skills * 0.1) + Math.min(0.3, ms.procedures * 0.05) + sr * 0.2);
    const lmC  = lm >= 1.6 ? "green" : lm >= 1.2 ? "yellow" : "white";
    const lmStr = ` {#666677-fg}∑{/}{${lmC}-fg}${lm.toFixed(1)}×{/}`;
    const line2 = ` {#888899-fg}Active: {cyan-fg}${s.activeTasks.size}{/}  Done: {green-fg}${s.totalCompleted}{/}  Failed: {red-fg}${s.totalFailed}{/}  ${agentH}${lmStr}${alertStr}${cbStr}{/}`;
    this.topBar.setContent(`${line1}\n${line2}`);
  }

  private updateBottomBar(): void {
    if (this.cmdInputActive) {
      this.bottomBar.style.border = { fg: "cyan" };
      this.bottomBar.setLabel(" {cyan-fg}INPUT{/} ");
      const before = this.cmdBuffer.slice(0, this.cmdCursorPos);
      const cursor = this.cmdBuffer[this.cmdCursorPos] ?? " ";
      const after  = this.cmdBuffer.slice(this.cmdCursorPos + 1);
      this.bottomBar.setContent(
        ` {cyan-fg}>{/} {white-fg}${before}{/}{inverse}${cursor}{/inverse}{white-fg}${after}{/}` +
        `  {#444455-fg}Enter:submit  Esc:cancel  ↑↓:history  C-a/e:home/end  C-k/u:kill{/}`,
      );
    } else {
      this.bottomBar.style.border = { fg: "#3a3a4a" };
      const c = C.profile[this.state.consciousnessProfile] ?? "white";
      const viewHint = this.state.activeView ? `{cyan-fg}[${this.state.activeView} — Esc to close]{/}  ` : "";
      this.bottomBar.setLabel(" {#3a3a4a-fg}CMD{/} ");
      this.bottomBar.setContent(` ${viewHint}{${c}-fg}[${this.state.consciousnessProfile}]{/}  {#666677-fg}${KEY_HELP}{/}`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private log(level: LogEntry["level"], source: string, message: string): void {
    pushBounded(this.state.eventLog, { ts: Date.now(), level, source, message }, MAX_LOG_LINES);
  }
}

// ── Event description ─────────────────────────────────────────

function describeEvent(e: PepagiEvent): string {
  switch (e.type) {
    case "task:created":       return `Task created: "${trunc(e.task.title, 60)}" [${e.task.id.slice(0, 8)}]`;
    case "task:assigned":      return `Task ${e.taskId.slice(0, 8)} → ${e.agent}`;
    case "task:started":       return `Task ${e.taskId.slice(0, 8)} started`;
    case "task:completed":     return `Task ${e.taskId.slice(0, 8)} completed (conf: ${(e.output.confidence * 100).toFixed(0)}%)`;
    case "task:failed":        return `Task ${e.taskId.slice(0, 8)} FAILED: ${trunc(e.error, 80)}`;
    case "mediator:thinking":  return trunc(e.thought, 100);
    case "mediator:decision":  return `Decision [${e.decision.action}] conf=${(e.decision.confidence * 100).toFixed(0)}%`;
    case "system:cost_warning":return `Cost warning: ${fmtCost(e.currentCost)} / ${fmtCost(e.limit)}`;
    case "security:blocked":   return `BLOCKED: ${trunc(e.reason, 80)}`;
    case "meta:watchdog_alert":return `WATCHDOG: ${trunc(e.message, 80)}`;
    case "system:alert":       return `${e.level.toUpperCase()}: ${trunc(e.message, 80)}`;
    case "system:goal_result": return `Goal "${e.goalName}": ${trunc(e.message, 60)}`;
    case "tool:call":          return `Tool call: ${e.tool} [${e.taskId.slice(0, 8)}]`;
    case "tool:result":        return `Tool result: ${e.tool} ${e.success ? "✓" : "✗"}`;
    case "world:simulated":    return `World model: ${e.scenarios} scenarios → ${e.winner}`;
    case "planner:plan":       return `Planner [${e.level}]: ${e.steps} steps`;
    case "causal:node":        return `Causal: ${trunc(e.action, 40)} [${e.taskId.slice(0, 8)}]`;
    case "consciousness:qualia": return "Qualia update";
    default:                   return JSON.stringify(e).slice(0, 100);
  }
}
