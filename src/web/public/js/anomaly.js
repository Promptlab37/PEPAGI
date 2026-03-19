// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — Anomaly Pulse Detection
// 8 detection rules, runs every 2s
// ═══════════════════════════════════════════════════════════════

let storeRef = null;
let anomalyInterval = null;
let prevCheckState = {};

export function initAnomalyPulse(store) {
  storeRef = store;
  anomalyInterval = setInterval(runAnomalyCheck, 2000);
}

export function stopAnomalyPulse() {
  if (anomalyInterval) { clearInterval(anomalyInterval); anomalyInterval = null; }
}

function runAnomalyCheck() {
  if (!storeRef) return;
  const state = storeRef.getAll();
  if (!state) return;

  const anomalies = [];

  // Rule 1: Infinite loop — same task retried 3+ times
  const taskRetries = {};
  for (const d of (state.decisions || [])) {
    const key = `${d.taskId}-${d.decision?.action}`;
    taskRetries[key] = (taskRetries[key] || 0) + 1;
    if (taskRetries[key] >= 3) {
      anomalies.push({ type: 'infinite_loop', severity: 'high', message: `Task ${d.taskId?.slice(0, 8)} retried ${taskRetries[key]}x with same action "${d.decision?.action}"` });
    }
  }

  // Rule 2: Cost explosion — session cost > 80% of limit
  const limit = 10; // default $10 limit
  if (state.sessionCost > limit * 0.8) {
    anomalies.push({ type: 'cost_explosion', severity: 'high', message: `Session cost $${state.sessionCost.toFixed(2)} exceeds 80% of $${limit} limit` });
  }

  // Rule 3: Stagnation — no completions in last 5 min with active tasks
  const activeTasks = Object.values(state.activeTasks || {});
  if (activeTasks.length > 0) {
    const lastCompletion = (state.completedTasks || []).reduce((max, t) => Math.max(max, t.createdAt + (t.durationMs || 0)), 0);
    if (lastCompletion > 0 && Date.now() - lastCompletion > 300000) {
      anomalies.push({ type: 'stagnation', severity: 'medium', message: `No task completions in ${Math.round((Date.now() - lastCompletion) / 60000)}min with ${activeTasks.length} active tasks` });
    }
  }

  // Rule 4: High error rate — >50% errors in last 10 tasks
  const recent = (state.completedTasks || []).slice(-10);
  if (recent.length >= 5) {
    const failCount = recent.filter(t => t.status === 'failed').length;
    if (failCount / recent.length > 0.5) {
      anomalies.push({ type: 'high_error_rate', severity: 'high', message: `${failCount}/${recent.length} recent tasks failed (${(failCount / recent.length * 100).toFixed(0)}% error rate)` });
    }
  }

  // Rule 5: Confidence drop — avg confidence trending down
  const decisions = state.decisions || [];
  if (decisions.length >= 6) {
    const recent3 = decisions.slice(-3).map(d => d.decision?.confidence || 0);
    const prev3 = decisions.slice(-6, -3).map(d => d.decision?.confidence || 0);
    const avgRecent = recent3.reduce((s, v) => s + v, 0) / 3;
    const avgPrev = prev3.reduce((s, v) => s + v, 0) / 3;
    if (avgRecent < 0.5 && avgRecent < avgPrev - 0.15) {
      anomalies.push({ type: 'confidence_drop', severity: 'medium', message: `Confidence trending down: ${(avgPrev * 100).toFixed(0)}% → ${(avgRecent * 100).toFixed(0)}%` });
    }
  }

  // Rule 6: Agent overload — any agent has >5 active requests
  for (const [name, a] of Object.entries(state.agents || {})) {
    if ((a.requestsActive || 0) > 5) {
      anomalies.push({ type: 'agent_overload', severity: 'medium', message: `Agent ${name} has ${a.requestsActive} active requests` });
    }
  }

  // Rule 7: Memory bloat — >1000 events in log
  if ((state.eventLog || []).length > 800) {
    anomalies.push({ type: 'memory_bloat', severity: 'low', message: `Event log has ${state.eventLog.length} entries (high memory usage)` });
  }

  // Rule 8: Breach state — consciousness breach
  const qualia = state.currentQualia || {};
  if ((qualia.confidence ?? 1) < 0.3 || (qualia.frustration ?? 0) > 0.8) {
    anomalies.push({ type: 'consciousness_breach', severity: 'high', message: `Consciousness breach: conf=${(qualia.confidence ?? 0).toFixed(2)} frust=${(qualia.frustration ?? 0).toFixed(2)}` });
  }

  // Update anomaly indicator
  updateAnomalyIndicator(anomalies);

  // Merge new anomalies into state (avoid duplicates within 30s window)
  const now = Date.now();
  for (const a of anomalies) {
    const existing = (state.anomalies || []).find(e =>
      e.type === a.type && now - e.ts < 30000
    );
    if (!existing) {
      if (!state.anomalies) state.anomalies = [];
      state.anomalies.push({
        id: `ap-${now}-${Math.random().toString(36).slice(2, 6)}`,
        ts: now,
        type: a.type,
        severity: a.severity,
        message: a.message,
        acknowledged: false,
      });
    }
  }
}

function updateAnomalyIndicator(anomalies) {
  const indicator = document.getElementById('anomaly-indicator');
  if (!indicator) return;

  const high = anomalies.filter(a => a.severity === 'high').length;
  const medium = anomalies.filter(a => a.severity === 'medium').length;

  if (high > 0) {
    indicator.className = 'anomaly-indicator anomaly-high';
    indicator.textContent = `${high + medium} anomalies`;
    indicator.title = anomalies.map(a => `[${a.severity}] ${a.message}`).join('\n');
  } else if (medium > 0) {
    indicator.className = 'anomaly-indicator anomaly-medium';
    indicator.textContent = `${medium} anomalies`;
    indicator.title = anomalies.map(a => `[${a.severity}] ${a.message}`).join('\n');
  } else {
    indicator.className = 'anomaly-indicator anomaly-clear';
    indicator.textContent = 'nominal';
    indicator.title = 'No anomalies detected';
  }
}

export function acknowledgeAnomalies() {
  if (!storeRef) return;
  const state = storeRef.getAll();
  for (const a of (state.anomalies || [])) {
    if (!a.acknowledged) a.acknowledged = true;
  }
}
