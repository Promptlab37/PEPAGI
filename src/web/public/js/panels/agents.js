// PEPAGI Web Dashboard — Agent Pool Panel (TUI spec: 100%)

const AGENT_COLORS = {
  claude: 'var(--cyan)', gpt: 'var(--green)', gemini: 'var(--blue)',
  ollama: 'var(--purple)', lmstudio: 'var(--gold)',
};

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function avgLatency(arr) {
  if (!arr || arr.length === 0) return '-';
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return avg < 1000 ? Math.round(avg) + 'ms' : (avg / 1000).toFixed(1) + 's';
}

/** Latency histogram (5 buckets) */
function latencyHistogram(arr, color) {
  if (!arr || arr.length < 2) return '';
  const buckets = [0, 0, 0, 0, 0]; // <500ms, <1s, <3s, <5s, 5s+
  for (const v of arr) {
    if (v < 500) buckets[0]++;
    else if (v < 1000) buckets[1]++;
    else if (v < 3000) buckets[2]++;
    else if (v < 5000) buckets[3]++;
    else buckets[4]++;
  }
  const max = Math.max(...buckets, 1);
  const labels = ['<.5s', '<1s', '<3s', '<5s', '5s+'];
  return `<div class="latency-hist">
    ${buckets.map((b, i) => {
      const h = Math.max(2, (b / max) * 20);
      return `<div class="lat-bucket">
        <div class="lat-bar-wrap"><div class="lat-bar" style="height:${h}px;background:${color}"></div></div>
        <div class="lat-label">${labels[i]}</div>
      </div>`;
    }).join('')}
  </div>`;
}

/** Success rate color */
function srColor(rate) {
  if (rate >= 90) return 'var(--green)';
  if (rate >= 70) return 'var(--gold)';
  return 'var(--coral)';
}

/** Load bar */
function loadBar(active, max) {
  const total = max || 4;
  const pct = Math.min((active / total) * 100, 100);
  const color = pct > 80 ? 'var(--coral)' : pct > 50 ? 'var(--gold)' : 'var(--green)';
  return `<div class="agent-load">
    <div class="agent-load-track"><div class="agent-load-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="agent-load-label">${active}/${total}</span>
  </div>`;
}

const RATE_LIMITS = { claude: 60, gpt: 60, gemini: 60, ollama: 999, lmstudio: 999 };

function rateLimitBar(provider, requestsTotal, startTime) {
  const limit = RATE_LIMITS[provider] || 60;
  const upMin = Math.max(1, (Date.now() - (startTime || Date.now())) / 60000);
  const rate = requestsTotal / upMin;
  const usage = Math.min(rate / limit, 1);
  const resetSec = 60 - Math.floor((Date.now() / 1000) % 60);
  const color = usage >= 0.8 ? 'var(--coral)' : usage >= 0.5 ? 'var(--gold)' : 'var(--green)';
  return `<div class="agent-stat"><span>Rate</span>
    <span class="agent-stat-value" style="font-size:0.68rem">
      ${rate.toFixed(1)}/min/${limit}
      <span class="agent-load" style="display:inline-flex;width:40px;margin:0 4px">
        <span class="agent-load-track"><span class="agent-load-fill" style="width:${usage * 100}%;background:${color}"></span></span>
      </span>
      <span style="color:var(--dim)">reset ${resetSec}s</span>
    </span>
  </div>`;
}

/** Escape HTML to prevent XSS */
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format elapsed time since timestamp */
function fmtElapsed(ts) {
  if (!ts) return '';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
}

export function renderAgents(state) {
  const grid = document.getElementById('agents-grid');
  const empty = document.getElementById('agents-empty');
  if (!grid) return;

  const agents = Object.values(state.agents || {});

  if (agents.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = agents.map(a => {
    const color = AGENT_COLORS[a.provider] || 'var(--text)';
    const dotClass = a.available ? 'dot-online' : 'dot-offline';
    const successRate = a.requestsTotal > 0
      ? Math.round(((a.requestsTotal - a.errorCount) / a.requestsTotal) * 100)
      : 100;
    const toggleLabel = a.available ? 'ON' : 'OFF';
    const toggleColor = a.available ? 'var(--green)' : 'var(--coral)';
    const isWorking = a.requestsActive > 0;

    // Activity section — shown when agent is working, with mini action log
    let activityHtml = '';
    if (isWorking) {
      const taskLabel = a.currentTask ? escHtml(a.currentTask.slice(0, 60)) : 'unknown task';
      const activityLabel = a.lastActivity ? escHtml(a.lastActivity.slice(0, 80)) : 'waiting...';
      const elapsed = a.lastActivityTs ? fmtElapsed(a.lastActivityTs) : '';

      // Mini action log — shows last 5 actions with timestamps
      let actionLogHtml = '';
      const actions = (a.recentActions || []).slice(-5).reverse();
      if (actions.length > 0) {
        actionLogHtml = `<div class="agent-action-log">
          ${actions.map(act => {
            const t = new Date(act.ts);
            const timeStr = t.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return `<div class="agent-action-entry"><span class="agent-action-time">${timeStr}</span> ${escHtml(act.text.slice(0, 100))}</div>`;
          }).join('')}
        </div>`;
      }

      activityHtml = `<div class="agent-activity">
        <div class="agent-activity-task">\u25B6 ${taskLabel}</div>
        <div class="agent-activity-action">${activityLabel} <span class="agent-activity-time">${elapsed}</span></div>
        ${actionLogHtml}
      </div>`;
    }

    // Kill button — only shown when agent is working
    const killBtn = isWorking
      ? `<button class="agent-kill-btn" data-provider="${a.provider}" title="Kill running execution">KILL</button>`
      : '';

    return `<div class="agent-card${a.available ? '' : ' agent-disabled'}${isWorking ? ' agent-working' : ''}" style="border-top: 2px solid ${a.available ? color : 'var(--dim)'}">
      <div class="agent-name">
        <span class="dot ${dotClass}${isWorking ? ' dot-working' : ''}"></span>
        <span style="color:${a.available ? color : 'var(--dim)'}">${a.provider}</span>
        <span class="agent-model">${a.model || ''}</span>
        ${killBtn}
        <button class="agent-toggle-btn" data-provider="${a.provider}" style="color:${toggleColor}">${toggleLabel}</button>
      </div>
      ${activityHtml}
      <div class="agent-stat"><span>SR</span><span class="agent-stat-value" style="color:${srColor(successRate)}">SR:${successRate}%</span></div>
      <div class="agent-stat"><span>Load</span>${loadBar(a.requestsActive, 4)}</div>
      <div class="agent-stat"><span>Requests</span><span class="agent-stat-value">${a.requestsTotal}</span></div>
      <div class="agent-stat"><span>Tokens</span><span class="agent-stat-value">\u2191${fmtTokens(a.tokensIn)} \u2193${fmtTokens(a.tokensOut)}</span></div>
      <div class="agent-stat"><span>Cost</span><span class="agent-stat-value" style="color:var(--gold)">$${a.costTotal.toFixed(3)}</span></div>
      <div class="agent-stat"><span>Latency</span><span class="agent-stat-value">${avgLatency(a.latencyMs)}</span></div>
      <div class="agent-stat"><span>Errors</span><span class="agent-stat-value" style="color:${a.errorCount > 0 ? 'var(--coral)' : 'var(--dim)'}">${a.errorCount}</span></div>
      ${rateLimitBar(a.provider, a.requestsTotal, state.startTime)}
      ${latencyHistogram(a.latencyMs, color)}
    </div>`;
  }).join('');

  // Toggle buttons
  grid.querySelectorAll('.agent-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const provider = btn.getAttribute('data-provider');
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/api/agent/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const data = await res.json();
        btn.textContent = data.available ? 'ON' : 'OFF';
        btn.style.color = data.available ? 'var(--green)' : 'var(--coral)';
      } catch {
        btn.textContent = 'ERR';
      }
      btn.disabled = false;
    });
  });

  // Kill buttons
  grid.querySelectorAll('.agent-kill-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const provider = btn.getAttribute('data-provider');
      if (!confirm(`Kill ${provider} agent? This will abort the running task and disable the agent.`)) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/api/agent/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const data = await res.json();
        btn.textContent = data.killed ? 'KILLED' : 'N/A';
      } catch {
        btn.textContent = 'ERR';
      }
      btn.disabled = false;
    });
  });
}
