// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Anomaly Pulse Detector
// ═══════════════════════════════════════════════════════════════
//
// Monitors DashboardState on each redraw tick and emits
// AnomalyRecord entries when it detects suspicious patterns.
// Does NOT modify the state itself — caller pushes the records.

import type { DashboardState, AnomalyRecord } from "./state.js";
import { nanoid } from "nanoid";

// ── Detection rules ───────────────────────────────────────────

interface DetectionContext {
  state:     DashboardState;
  nowMs:     number;
  newAlerts: AnomalyRecord[];
}

function alert(ctx: DetectionContext, type: string, severity: AnomalyRecord["severity"], message: string): void {
  // Dedup: skip if same type was added in the last 30s
  const cutoff = ctx.nowMs - 30_000;
  const exists = ctx.state.anomalies.some(a => a.type === type && a.ts > cutoff);
  if (exists) return;

  ctx.newAlerts.push({
    id:           nanoid(8),
    ts:           ctx.nowMs,
    type,
    severity,
    message,
    acknowledged: false,
  });
}

// ── Rule 1: Cost explosion ─────────────────────────────────────

function checkCostExplosion(ctx: DetectionContext): void {
  const { state } = ctx;
  const last5 = state.costHistory.slice(-5);
  if (last5.length < 5) return;

  // Detect monotonically increasing cost delta (accelerating spend)
  const delta1 = last5[4]! - last5[3]!;
  const delta2 = last5[3]! - last5[2]!;
  if (delta1 > 0.01 && delta2 > 0 && delta1 > delta2 * 2) {
    alert(ctx, "cost_explosion", "high", `Cost accelerating: +$${delta1.toFixed(4)} last tick`);
  }
}

// ── Rule 2: Agent starvation ───────────────────────────────────

function checkAgentStarvation(ctx: DetectionContext): void {
  const { state } = ctx;
  const available = [...state.agents.values()].filter(a => a.available).length;
  if (state.agents.size > 0 && available === 0) {
    alert(ctx, "agent_starvation", "high", "All agents unavailable — tasks may be stalled");
  }
}

// ── Rule 3: Task pile-up ──────────────────────────────────────

function checkTaskPileUp(ctx: DetectionContext): void {
  const { state } = ctx;
  if (state.activeTasks.size >= 20) {
    alert(ctx, "task_pile_up", "medium", `${state.activeTasks.size} tasks active simultaneously`);
  }
}

// ── Rule 4: High frustration qualia ───────────────────────────

function checkFrustration(ctx: DetectionContext): void {
  const { state } = ctx;
  const frust = state.currentQualia["frustration"] ?? 0;
  if (frust >= 0.75) {
    alert(ctx, "high_frustration", "medium", `Frustration qualia at ${(frust * 100).toFixed(0)}% — system under stress`);
  }
}

// ── Rule 5: Confidence collapse ───────────────────────────────

function checkConfidenceCollapse(ctx: DetectionContext): void {
  const { state } = ctx;
  if (state.decisions.length < 3) return;
  const recent = state.decisions.slice(-5);
  const avgConf = recent.reduce((s, d) => s + d.decision.confidence, 0) / recent.length;
  if (avgConf < 0.35) {
    alert(ctx, "confidence_collapse", "high", `Mediator confidence at ${(avgConf * 100).toFixed(0)}% — consider intervention`);
  }
}

// ── Rule 6: Security threat surge ─────────────────────────────

function checkSecuritySurge(ctx: DetectionContext): void {
  const { state } = ctx;
  const cutoff = ctx.nowMs - 60_000;
  const recent = state.securityEvents.filter(e => e.ts > cutoff).length;
  if (recent >= 5) {
    alert(ctx, "security_surge", "high", `${recent} security events in the last 60s`);
  }
}

// ── Rule 7: Watchdog silence (no decisions for 3+ min during active tasks) ──

function checkWatchdogSilence(ctx: DetectionContext): void {
  const { state } = ctx;
  if (state.activeTasks.size === 0) return;
  const lastDecision = state.decisions[state.decisions.length - 1];
  if (!lastDecision) return;
  const silenceMs = ctx.nowMs - lastDecision.ts;
  if (silenceMs >= 3 * 60 * 1000) {
    alert(ctx, "watchdog_silence", "medium", `No mediator decision for ${Math.floor(silenceMs / 60000)}m — possible stall`);
  }
}

// ── Rule 8: Repeated task failures ────────────────────────────

function checkFailureSpike(ctx: DetectionContext): void {
  const { state } = ctx;
  const cutoff = ctx.nowMs - 5 * 60 * 1000;
  const recentFails = state.completedTasks.filter(
    t => t.status === "failed" && t.createdAt > cutoff
  ).length;
  if (recentFails >= 3) {
    alert(ctx, "failure_spike", "medium", `${recentFails} task failures in the last 5 minutes`);
  }
}

// ── Main scan ─────────────────────────────────────────────────

/**
 * Run all anomaly detection rules against current state.
 * Returns array of new anomaly records to be appended to state.anomalies.
 */
export function scanAnomalies(state: DashboardState): AnomalyRecord[] {
  const ctx: DetectionContext = {
    state,
    nowMs:     Date.now(),
    newAlerts: [],
  };

  checkCostExplosion(ctx);
  checkAgentStarvation(ctx);
  checkTaskPileUp(ctx);
  checkFrustration(ctx);
  checkConfidenceCollapse(ctx);
  checkSecuritySurge(ctx);
  checkWatchdogSilence(ctx);
  checkFailureSpike(ctx);

  return ctx.newAlerts;
}

/** Returns the highest-severity unacknowledged anomaly, or null */
export function topAnomaly(state: DashboardState): AnomalyRecord | null {
  const unacked = state.anomalies.filter(a => !a.acknowledged);
  if (unacked.length === 0) return null;
  // Priority: high > medium > low
  const highSev = unacked.find(a => a.severity === "high");
  if (highSev) return highSev;
  const medSev = unacked.find(a => a.severity === "medium");
  return medSev ?? unacked[0] ?? null;
}

/** Color tag for a given severity level */
export function severityColor(sev: AnomalyRecord["severity"]): string {
  if (sev === "high")   return "{red-fg}";
  if (sev === "medium") return "{yellow-fg}";
  return "{cyan-fg}";
}
