// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — State Bridge
// Bridges eventBus events into DashboardState for WebSocket clients
// ═══════════════════════════════════════════════════════════════

import { eventBus } from "../core/event-bus.js";
import type { PepagiEvent, AgentProvider, Task } from "../core/types.js";
import { PEPAGI_DATA_DIR } from "../config/loader.js";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";

import {
  createInitialState, pushBounded, pushBoundedHistory,
  type DashboardState, type TaskRow, type LogEntry, type SecurityEvent,
  type DecisionRecord, type AgentStat,
} from "../ui/state.js";

const MAX_LOG_LINES = 10_000;
const MAX_SPARKLINE_POINTS = 200;

/** Truncate string */
function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

/** Format cost */
function fmtCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

// ── Event description (plain text, no blessed tags) ──────────

function describeEvent(e: PepagiEvent): string {
  switch (e.type) {
    case "task:created":       return `Task created: "${trunc(e.task.title, 60)}" [${e.task.id.slice(0, 8)}]`;
    case "task:assigned":      return `Task ${e.taskId.slice(0, 8)} \u2192 ${e.agent}`;
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
    case "tool:result":        return `Tool result: ${e.tool} ${e.success ? "\u2713" : "\u2717"}`;
    case "world:simulated":    return `World model: ${e.scenarios} scenarios \u2192 ${e.winner}`;
    case "planner:plan":       return `Planner [${e.level}]: ${e.steps} steps`;
    case "causal:node":        return `Causal: ${trunc(e.action, 40)} [${e.taskId.slice(0, 8)}]`;
    case "consciousness:qualia": return "Qualia update";
    case "platform:status":      return `${e.platform} ${e.connected ? "connected" : "disconnected"}`;
    case "platform:qr":          return `WhatsApp QR code available — scan to connect`;
    default:                   return JSON.stringify(e).slice(0, 100);
  }
}

// ── Serialized event for WebSocket ───────────────────────────

interface WSEvent {
  eventType: string;
  description: string;
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  /** Detail sub-lines for tree display (reasoning, tool params, qualia deltas, causal nodes) */
  details?: string[];
  /** Qualia deltas from mediator:decision */
  qualiaDeltas?: Array<{ key: string; delta: number }>;
}

// ── StateBridge ──────────────────────────────────────────────

export class StateBridge {
  private state: DashboardState;
  private clients: Set<WebSocket> = new Set();
  private handler: ((e: PepagiEvent) => void) | null = null;
  private memStatsTimer: ReturnType<typeof setInterval> | null = null;
  private prevQualia: Record<string, number> = {};

  constructor(platformConfig?: { telegram?: { enabled: boolean }; whatsapp?: { enabled: boolean }; discord?: { enabled: boolean } }) {
    this.state = createInitialState();
    // Sync platform enabled states from config so dashboard shows actual status
    if (platformConfig) {
      if (platformConfig.telegram?.enabled) this.state.platforms.telegram.enabled = true;
      if (platformConfig.whatsapp?.enabled) this.state.platforms.whatsapp.enabled = true;
      if (platformConfig.discord?.enabled)  this.state.platforms.discord.enabled = true;
    }
  }

  /** Start listening to eventBus and refreshing memory stats. */
  start(): void {
    this.handler = (event: PepagiEvent) => {
      const wsEvent = this.handleEvent(event);
      // Broadcast both the event AND full state so clients stay in sync
      this.broadcast({ type: "event", event: wsEvent });
      this.broadcastState();
    };
    eventBus.onAny(this.handler);

    // Refresh memory stats immediately, then every 30s
    void this.refreshMemoryStats();
    this.memStatsTimer = setInterval(() => void this.refreshMemoryStats(), 30_000);
    this.memStatsTimer.unref();
  }

  /** Stop listening. */
  stop(): void {
    if (this.handler) {
      eventBus.offAny(this.handler);
      this.handler = null;
    }
    if (this.memStatsTimer) {
      clearInterval(this.memStatsTimer);
      this.memStatsTimer = null;
    }
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }

  /**
   * Hydrate dashboard state from persisted tasks (on startup).
   * Restores completed/failed task history so dashboard survives redeploy.
   */
  hydrateFromTasks(tasks: Task[]): void {
    for (const t of tasks) {
      const row: TaskRow = {
        id: t.id, title: t.title, status: t.status,
        agent: t.assignedTo, difficulty: t.difficulty,
        confidence: t.confidence, cost: t.estimatedCost,
        durationMs: (t.completedAt && t.createdAt)
          ? new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()
          : null,
        createdAt: new Date(t.createdAt).getTime(),
        assignedAt: t.startedAt ? new Date(t.startedAt).getTime() : null,
        startedAt: t.startedAt ? new Date(t.startedAt).getTime() : null,
        swarmBranches: 0,
        result: typeof t.output?.result === "string" ? t.output.result
          : t.output?.summary ?? t.lastError ?? null,
      };
      if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") {
        pushBounded(this.state.completedTasks, row, 100);
        if (t.status === "completed") this.state.totalCompleted++;
        else this.state.totalFailed++;
        this.state.sessionCost += t.estimatedCost;
      } else {
        this.state.activeTasks.set(t.id, row);
      }
    }
    // Sort completed by createdAt descending (most recent first)
    this.state.completedTasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Add WebSocket client. Sends full state snapshot immediately. */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    const msg = JSON.stringify({ type: "init", state: this.serializeState() });
    ws.send(msg);
  }

  /** Remove WebSocket client. */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /** Get client count. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Get full serialized state (for REST API). */
  getFullState(): Record<string, unknown> {
    return this.serializeState();
  }

  /** Update agent availability in state (called after agent toggle). */
  setAgentAvailable(provider: string, available: boolean): void {
    const stat = this.state.agents.get(provider as AgentProvider);
    if (stat) stat.available = available;
  }

  /** Update lastActivity for the agent currently working on a given taskId. */
  private updateAgentActivity(taskId: string, activity: string, now: number): void {
    for (const stat of this.state.agents.values()) {
      if (stat.currentTaskId === taskId) {
        stat.lastActivity = activity;
        stat.lastActivityTs = now;
        // Push to recent actions log (keep last 8)
        pushBounded(stat.recentActions, { ts: now, text: activity }, 8);
        break;
      }
    }
  }

  // ── Event handling (ported from dashboard.ts, no blessed tags) ──

  private handleEvent(event: PepagiEvent): WSEvent {
    const now = Date.now();
    let level: LogEntry["level"] = "info";
    const source = event.type.split(":")[0] ?? "system";
    const description = describeEvent(event);
    // Skip noisy consciousness:qualia events from Neural Stream log
    const skipLog = event.type === "consciousness:qualia";

    const entry: LogEntry = { ts: now, level, source, message: description };
    if (!skipLog) pushBounded(this.state.eventLog, entry, MAX_LOG_LINES);

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
        // Track current task on agent
        const taskRow = this.state.activeTasks.get(event.taskId);
        stat.currentTaskId = event.taskId;
        stat.currentTask = taskRow?.title ?? event.taskId;
        stat.lastActivity = "Assigned";
        stat.lastActivityTs = now;
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
          r.result = (typeof event.output.result === "string" ? event.output.result : null) || event.output.summary || null;
          if (event.cost !== undefined && event.cost > 0) r.cost = event.cost;
          if (event.agent && !r.agent) r.agent = event.agent as AgentProvider;
          r.durationMs = now - r.createdAt;
          this.state.activeTasks.delete(event.taskId);
          pushBounded(this.state.completedTasks, r, 100);
          this.state.totalCompleted++;
          if (r.agent) {
            const stat = this.state.agents.get(r.agent);
            if (stat) {
              stat.requestsActive = Math.max(0, stat.requestsActive - 1);
              stat.costTotal += r.cost;
              if (r.durationMs) pushBoundedHistory(stat.latencyMs as number[], r.durationMs, 20);
              // Clear current task when done
              if (stat.currentTaskId === event.taskId) {
                stat.currentTaskId = null;
                stat.currentTask = null;
                stat.lastActivity = "Completed";
                stat.lastActivityTs = now;
              }
            }
          }
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
          if (r.agent) {
            const stat = this.state.agents.get(r.agent);
            if (stat) {
              stat.requestsActive = Math.max(0, stat.requestsActive - 1);
              stat.errorCount++;
              if (r.durationMs) pushBoundedHistory(stat.latencyMs as number[], r.durationMs, 20);
              if (stat.currentTaskId === event.taskId) {
                stat.currentTaskId = null;
                stat.currentTask = null;
                stat.lastActivity = "Failed";
                stat.lastActivityTs = now;
              }
            }
          }
        }
        level = "error";
        entry.level = level;
        break;
      }
      case "mediator:thinking":
        pushBounded(this.state.innerMonologue, event.thought, 30);
        // Update agent activity for all thinking events (gives visibility into what agent is doing)
        this.updateAgentActivity(event.taskId, trunc(event.thought, 80), now);
        break;
      case "mediator:decision": {
        const d = event.decision;
        if (d.action === "swarm") {
          const r = this.state.activeTasks.get(event.taskId);
          if (r) r.swarmBranches = d.subtasks?.length ?? 2;
        }
        pushBounded(this.state.decisions, {
          ts: now, taskId: event.taskId, decision: d,
          thought: d.consciousnessNote ?? "",
        } satisfies DecisionRecord, 200);
        // Update qualia from introspection
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
          pushBounded(this.state.innerMonologue, d.consciousnessNote, 30);
        this.prevQualia = { ...this.state.currentQualia };
        break;
      }
      case "system:cost_warning": {
        pushBounded(this.state.securityEvents, {
          ts: now, type: "cost_warning",
          message: `Cost at ${fmtCost(event.currentCost)} / ${fmtCost(event.limit)} limit`,
          taskId: "",
        } satisfies SecurityEvent, 100);
        level = "warn";
        entry.level = level;
        this.state.sessionCost = event.currentCost;
        pushBoundedHistory(this.state.costHistory, event.currentCost, MAX_SPARKLINE_POINTS);
        break;
      }
      case "security:blocked": {
        pushBounded(this.state.securityEvents, {
          ts: now, type: "blocked", message: event.reason, taskId: event.taskId,
        } satisfies SecurityEvent, 100);
        this.state.threatScore = Math.min(1, this.state.threatScore * 0.9 + 0.3);
        level = "warn";
        entry.level = level;
        break;
      }
      case "meta:watchdog_alert": {
        level = "warn"; entry.level = level; entry.source = "watchdog";
        this.state.watchdogLastPing = now;
        pushBounded(this.state.anomalies, {
          id: `wa-${now}`, ts: now, type: "watchdog_alert",
          severity: "medium", message: event.message, acknowledged: false,
        }, 50);
        break;
      }
      case "system:alert": {
        level = event.level === "critical" ? "error" : "warn";
        entry.level = level;
        pushBounded(this.state.anomalies, {
          id: `sa-${now}`, ts: now, type: "system_alert",
          severity: event.level === "critical" ? "high" : "medium",
          message: event.message, acknowledged: false,
        }, 50);
        break;
      }
      case "tool:call": {
        entry.source = "tool";
        // Update agent activity for the agent working on this task
        this.updateAgentActivity(event.taskId, `Tool: ${event.tool}`, now);
        break;
      }
      case "tool:result": {
        entry.source = "tool";
        level = event.success ? "info" : "error";
        entry.level = level;
        this.updateAgentActivity(event.taskId, `${event.tool} ${event.success ? "\u2713" : "\u2717"}`, now);
        break;
      }
      case "world:simulated": {
        entry.source = "world";
        break;
      }
      case "planner:plan": {
        entry.source = "planner";
        break;
      }
      case "causal:node": {
        entry.source = "causal";
        break;
      }
      case "consciousness:qualia": {
        // Update all qualia dimensions from phenomenal state engine
        for (const [key, val] of Object.entries(event.qualia)) {
          if (typeof val === "number") this.state.currentQualia[key] = val;
        }
        // Don't log to event stream — too frequent
        entry.level = "debug";
        break;
      }
      case "platform:status": {
        const pKey = event.platform as keyof typeof this.state.platforms;
        const pState = this.state.platforms[pKey];
        if (pState) {
          pState.connected = event.connected;
          if (event.connected) pState.enabled = true;
          // Clear QR code when connected
          if (event.connected && "qrCode" in pState) pState.qrCode = undefined;
        }
        break;
      }
      case "platform:qr": {
        this.state.platforms.whatsapp.qrCode = event.qr;
        break;
      }
    }

    // Slow exponential decay of threat score
    this.state.threatScore = Math.max(0, this.state.threatScore * 0.9997);

    // Build detail sub-lines and qualia deltas for Neural Stream tree display
    const details: string[] = [];
    let qualiaDeltas: Array<{ key: string; delta: number }> | undefined;

    switch (event.type) {
      case "mediator:decision": {
        const d = event.decision;
        if (d.reasoning) details.push(`Reasoning: ${trunc(d.reasoning, 120)}`);
        if (d.action) details.push(`Action: ${d.action}`);
        if (d.assignment?.agent) details.push(`Assign \u2192 ${d.assignment.agent}`);
        if (d.subtasks?.length) details.push(`Subtasks: ${d.subtasks.length} created`);
        // Qualia deltas
        if (d.introspection?.emotionalState) {
          const es = d.introspection.emotionalState;
          qualiaDeltas = [];
          for (const [key, val] of Object.entries(es)) {
            if (typeof val !== "number") continue;
            const prev = this.prevQualia[key] ?? 0;
            const delta = val - prev;
            if (Math.abs(delta) >= 0.05) qualiaDeltas.push({ key, delta });
          }
          if (qualiaDeltas.length === 0) qualiaDeltas = undefined;
        }
        if (d.consciousnessNote) details.push(`Note: ${trunc(d.consciousnessNote, 100)}`);
        break;
      }
      case "tool:call":
        details.push(`Tool: ${event.tool}`);
        if (event.input) details.push(`Input: ${trunc(typeof event.input === "string" ? event.input : JSON.stringify(event.input), 120)}`);
        break;
      case "tool:result":
        details.push(`Tool: ${event.tool}`);
        details.push(event.success ? `\u2713 Success` : `\u2717 Failed`);
        if (event.output) details.push(`Output: ${trunc(String(event.output), 120)}`);
        break;
      case "world:simulated":
        details.push(`Scenarios: ${event.scenarios}`);
        details.push(`Winner: ${event.winner}`);
        break;
      case "planner:plan":
        details.push(`Level: ${event.level}`);
        details.push(`Steps: ${event.steps}`);
        break;
      case "causal:node":
        details.push(`Action: ${event.action}`);
        if (event.parentAction) details.push(`Parent: ${event.parentAction}`);
        if (event.counterfactual) details.push(`\u21af ${event.counterfactual}`);
        break;
      case "task:completed":
        const resultText = typeof event.output?.result === "string" ? event.output.result : event.output?.summary;
        if (resultText) details.push(`Result: ${trunc(resultText, 200)}`);
        break;
    }

    // Attach detail to the log entry for client-side tree rendering
    if (details.length > 0) entry.detail = details;

    return { eventType: event.type, description, ts: now, level, source, details: details.length > 0 ? details : undefined, qualiaDeltas };
  }

  // ── Memory stats (ported from dashboard.ts) ────────────────

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
    pushBoundedHistory(mh.l2, episodes, 60);
    pushBoundedHistory(mh.l3, facts, 60);
    pushBoundedHistory(mh.l4, procedures + skills, 60);
    pushBoundedHistory(mh.l5, skills, 60);
  }

  // ── Serialization ──────────────────────────────────────────

  private serializeState(): Record<string, unknown> {
    const s = this.state;
    return {
      startTime: s.startTime,
      sessionCost: s.sessionCost,
      sessionTokensIn: s.sessionTokensIn,
      sessionTokensOut: s.sessionTokensOut,
      costHistory: s.costHistory,
      costPerMinute: s.costPerMinute,
      activeTasks: Object.fromEntries(s.activeTasks),
      completedTasks: s.completedTasks,
      totalCompleted: s.totalCompleted,
      totalFailed: s.totalFailed,
      agents: Object.fromEntries(s.agents),
      qualiaHistory: s.qualiaHistory,
      currentQualia: s.currentQualia,
      consciousnessProfile: s.consciousnessProfile,
      innerMonologue: s.innerMonologue,
      introspectionHistory: s.introspectionHistory,
      eventLog: s.eventLog.slice(-500), // last 500 for initial load (not all 10k)
      securityEvents: s.securityEvents,
      threatScore: s.threatScore,
      anomalies: s.anomalies,
      decisions: s.decisions.slice(-50), // last 50 for initial load
      platforms: s.platforms,
      memoryStats: s.memoryStats,
      memoryLevelHistory: s.memoryLevelHistory,
      watchdogLastPing: s.watchdogLastPing,
    };
  }

  // ── Broadcast to all WS clients ───────────────────────────

  private broadcast(msg: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const json = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(json);
      }
    }
  }

  /** Throttled full state broadcast — max once per 500ms. */
  private _stateTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcastState(): void {
    if (this._stateTimer || this.clients.size === 0) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.broadcast({ type: "state", state: this.serializeState() });
    }, 500);
  }
}
