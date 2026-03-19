// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — F-Key Overlay System
// Modal system + all 9 F-key overlay views
// ═══════════════════════════════════════════════════════════════

let activeOverlay = null;
let overlayEl = null;
let overlayTitleEl = null;
let overlayBodyEl = null;
let overlayData = {};
let storeRef = null;

const OVERLAYS = {
  F1: { key: 'F1', title: 'Command Center', render: renderF1CommandCenter },
  F2: { key: 'F2', title: 'Memory Explorer', render: renderF2MemoryExplorer },
  F3: { key: 'F3', title: 'Log Telescope', render: renderF3LogTelescope },
  F4: { key: 'F4', title: 'Agent Observatory', render: renderF4AgentObservatory },
  F5: { key: 'F5', title: 'Consciousness Lab', render: renderF5ConsciousnessLab },
  F6: { key: 'F6', title: 'Security Fortress', render: renderF6SecurityFortress },
  F7: { key: 'F7', title: 'Evolution Engine', render: renderF7EvolutionEngine },
  F8: { key: 'F8', title: 'Secure Vault', render: renderF8SecureVault },
  F9: { key: 'F9', title: 'Network Sonar', render: renderF9NetworkSonar },
};

export function initOverlays(store) {
  storeRef = store;
  overlayEl = document.getElementById('overlay');
  overlayTitleEl = document.getElementById('overlay-title');
  overlayBodyEl = document.getElementById('overlay-body');
  if (!overlayEl) return;

  // Close button
  const closeBtn = document.getElementById('overlay-close');
  if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

  // Click backdrop to close
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeOverlay();
  });
}

export function openOverlay(key) {
  const def = OVERLAYS[key];
  if (!def || !overlayEl) return;
  activeOverlay = key;
  overlayTitleEl.textContent = `${def.key} — ${def.title}`;
  overlayEl.classList.add('active');
  document.body.classList.add('overlay-open');
  overlayData = {};
  def.render(overlayBodyEl, storeRef?.getAll(), overlayData);
}

export function closeOverlay() {
  if (!overlayEl) return;
  activeOverlay = null;
  overlayEl.classList.remove('active');
  document.body.classList.remove('overlay-open');
  overlayBodyEl.innerHTML = '';
  overlayData = {};
}

export function isOverlayOpen() { return activeOverlay !== null; }
export function getActiveOverlay() { return activeOverlay; }

export function refreshOverlay() {
  if (!activeOverlay || !storeRef) return;
  const def = OVERLAYS[activeOverlay];
  if (def) def.render(overlayBodyEl, storeRef.getAll(), overlayData);
}

// ── Helpers ────────────────────────────────────────────────────

function h(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtCost(n) { return `$${(n || 0).toFixed(4)}`; }

function bar(pct, color, width = 120) {
  const w = Math.max(0, Math.min(100, pct * 100));
  return `<span class="ov-bar"><span class="ov-bar-track" style="width:${width}px"><span class="ov-bar-fill" style="width:${w}%;background:${color}"></span></span><span class="ov-bar-val">${(pct * 100).toFixed(0)}%</span></span>`;
}

function section(title) { return `<div class="ov-section-title">${title}</div>`; }

function table(headers, rows) {
  let html = '<table class="ov-table"><thead><tr>';
  for (const h of headers) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (const cell of row) html += `<td>${cell}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

async function fetchJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// F1 — Command Center
// ═══════════════════════════════════════════════════════════════

function renderF1CommandCenter(el, state) {
  const tasks = Object.values(state.activeTasks || {});
  const completed = state.completedTasks || [];
  const agents = state.agents || {};
  const uptime = Date.now() - (state.startTime || Date.now());

  let html = section('System Overview');
  html += '<div class="ov-stats-grid">';
  html += `<div class="ov-stat"><span class="ov-stat-val">${fmtDuration(uptime)}</span><span class="ov-stat-lbl">Uptime</span></div>`;
  html += `<div class="ov-stat"><span class="ov-stat-val">${tasks.length}</span><span class="ov-stat-lbl">Active Tasks</span></div>`;
  html += `<div class="ov-stat"><span class="ov-stat-val">${state.totalCompleted || 0}</span><span class="ov-stat-lbl">Completed</span></div>`;
  html += `<div class="ov-stat"><span class="ov-stat-val">${state.totalFailed || 0}</span><span class="ov-stat-lbl">Failed</span></div>`;
  html += `<div class="ov-stat"><span class="ov-stat-val">${fmtCost(state.sessionCost)}</span><span class="ov-stat-lbl">Session Cost</span></div>`;
  html += `<div class="ov-stat"><span class="ov-stat-val">${Object.keys(agents).length}</span><span class="ov-stat-lbl">Agents</span></div>`;
  html += '</div>';

  // Active tasks
  if (tasks.length > 0) {
    html += section('Active Tasks');
    const rows = tasks.map(t => [
      `<span class="badge badge-${t.status}">${t.status}</span>`,
      t.title || t.id?.slice(0, 8),
      t.agent || '--',
      fmtDuration(Date.now() - (t.createdAt || Date.now())),
    ]);
    html += table(['Status', 'Title', 'Agent', 'Duration'], rows);
  }

  // Recent completed
  if (completed.length > 0) {
    html += section('Recent Completed');
    const rows = completed.slice(-10).reverse().map(t => [
      `<span class="badge badge-${t.status}">${t.status}</span>`,
      t.title || t.id?.slice(0, 8),
      t.agent || '--',
      `${(t.confidence * 100).toFixed(0)}%`,
      fmtCost(t.cost),
      fmtDuration(t.durationMs),
    ]);
    html += table(['Status', 'Title', 'Agent', 'Conf', 'Cost', 'Duration'], rows);
  }

  // Agent fleet
  html += section('Agent Fleet');
  const agentList = Object.entries(agents);
  if (agentList.length > 0) {
    const rows = agentList.map(([name, a]) => {
      const sr = a.requestsTotal > 0 ? ((a.requestsTotal - a.errorCount) / a.requestsTotal) : 1;
      const srColor = sr >= 0.9 ? 'var(--green)' : sr >= 0.7 ? 'var(--gold)' : 'var(--coral)';
      return [
        `<span style="color:var(--cyan)">${name}</span>`,
        `<span style="color:${srColor}">${(sr * 100).toFixed(0)}%</span>`,
        a.requestsTotal || 0,
        a.errorCount || 0,
        fmtCost(a.costTotal),
        `${a.requestsActive || 0} active`,
      ];
    });
    html += table(['Agent', 'SR%', 'Requests', 'Errors', 'Cost', 'Load'], rows);
  } else {
    html += '<div class="ov-empty">No agents active</div>';
  }

  // Quick actions
  html += section('Keyboard Shortcuts');
  html += '<div class="ov-kbd-grid">';
  const shortcuts = [
    ['F1-F9', 'Open overlays'], ['Esc', 'Close overlay'],
    ['Ctrl+R', 'Decision Replay'], ['Ctrl+G', 'Thought Graph'],
    ['j/k', 'Navigate events'], ['a', 'Acknowledge anomaly'],
    ['Space', 'Pause events'], ['/', 'Focus search'],
  ];
  for (const [key, desc] of shortcuts) {
    html += `<div class="ov-kbd-item"><kbd>${key}</kbd><span>${desc}</span></div>`;
  }
  html += '</div>';

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// F2 — Memory Explorer
// ═══════════════════════════════════════════════════════════════

const MEM_TABS = [
  { id: 'episodes', label: 'L2 Episodic', api: '/api/memory/episodes' },
  { id: 'knowledge', label: 'L3 Semantic', api: '/api/memory/knowledge' },
  { id: 'procedures', label: 'L4 Procedural', api: '/api/memory/procedures' },
  { id: 'meta', label: 'L5 Meta', api: '/api/memory/meta' },
  { id: 'working', label: 'L1 Working', api: '/api/memory/working' },
];

async function renderF2MemoryExplorer(el, state, data) {
  if (!data.activeTab) data.activeTab = 'episodes';
  if (!data.cache) data.cache = {};
  if (!data.expanded) data.expanded = new Set();
  if (!data.sort) data.sort = 'date';

  // Tab bar
  let html = '<div class="ov-tabs">';
  for (const t of MEM_TABS) {
    html += `<button class="ov-tab ${data.activeTab === t.id ? 'active' : ''}" data-mem-tab="${t.id}">${t.label}</button>`;
  }
  html += '</div>';

  // Load data if needed
  const tab = MEM_TABS.find(t => t.id === data.activeTab);
  if (tab && !data.cache[data.activeTab]) {
    html += '<div class="ov-loading">Loading...</div>';
    el.innerHTML = html;
    const result = await fetchJson(tab.api);
    data.cache[data.activeTab] = result?.entries || [];
    renderF2MemoryExplorer(el, state, data);
    return;
  }

  const entries = data.cache[data.activeTab] || [];
  html += `<div class="ov-meta">Entries: ${entries.length} | Sort: ${data.sort} | Click to expand</div>`;

  // Sort entries
  const sorted = [...entries];
  if (data.sort === 'confidence') {
    sorted.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  } else {
    sorted.sort((a, b) => (b.timestamp ?? b.createdAt ?? 0) - (a.timestamp ?? a.createdAt ?? 0));
  }

  // Render entries
  html += '<div class="ov-entries">';
  for (let i = 0; i < Math.min(sorted.length, 100); i++) {
    const e = sorted[i];
    const id = e.id || `entry-${i}`;
    const isExpanded = data.expanded.has(id);
    const preview = e.taskTitle || e.fact || e.name || e.summary || JSON.stringify(e).slice(0, 80);
    const conf = e.confidence !== undefined ? ` <span class="ov-conf">${(e.confidence * 100).toFixed(0)}%</span>` : '';
    const ts = e.timestamp || e.createdAt;
    const time = ts ? fmtTime(ts) : '';
    html += `<div class="ov-entry ${isExpanded ? 'expanded' : ''}" data-mem-id="${id}">`;
    html += `<div class="ov-entry-header"><span class="ov-entry-idx">#${i + 1}</span><span class="ov-entry-preview">${escHtml(preview)}</span>${conf}<span class="ov-entry-time">${time}</span></div>`;
    if (isExpanded) {
      html += `<pre class="ov-entry-detail">${escHtml(JSON.stringify(e, null, 2))}</pre>`;
    }
    html += '</div>';
  }
  if (entries.length === 0) html += '<div class="ov-empty">No entries in this memory level</div>';
  html += '</div>';

  el.innerHTML = html;

  // Tab click handlers
  el.querySelectorAll('[data-mem-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      data.activeTab = btn.dataset.memTab;
      data.expanded = new Set();
      renderF2MemoryExplorer(el, state, data);
    });
  });

  // Entry expand toggle
  el.querySelectorAll('[data-mem-id]').forEach(entry => {
    entry.querySelector('.ov-entry-header')?.addEventListener('click', () => {
      const id = entry.dataset.memId;
      if (data.expanded.has(id)) data.expanded.delete(id); else data.expanded.add(id);
      renderF2MemoryExplorer(el, state, data);
    });
  });
}

function escHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════
// F3 — Log Telescope
// ═══════════════════════════════════════════════════════════════

function renderF3LogTelescope(el, state, data) {
  if (!data.filter) data.filter = '';
  if (!data.levelFilter) data.levelFilter = 'all';
  if (!data.timeRange) data.timeRange = 0; // 0=all, ms

  const events = state.eventLog || [];
  const now = Date.now();

  // Filter
  let filtered = events;
  if (data.levelFilter !== 'all') {
    filtered = filtered.filter(e => e.level === data.levelFilter);
  }
  if (data.timeRange > 0) {
    filtered = filtered.filter(e => now - e.ts < data.timeRange);
  }
  if (data.filter) {
    const q = data.filter.toLowerCase();
    const isRegex = q.startsWith('/') && q.length > 1;
    if (isRegex) {
      try {
        const rx = new RegExp(q.slice(1), 'i');
        filtered = filtered.filter(e => rx.test(e.message || '') || rx.test(e.source || ''));
      } catch { /* invalid regex, fallback to literal */ }
    } else {
      filtered = filtered.filter(e => (e.message || '').toLowerCase().includes(q) || (e.source || '').toLowerCase().includes(q));
    }
  }

  let html = '<div class="ov-toolbar">';
  html += `<input class="ov-search" type="text" placeholder="Search (prefix / for regex)" value="${escHtml(data.filter)}" id="log-search">`;
  html += '<div class="ov-btn-group">';
  for (const lv of ['all', 'info', 'warn', 'error']) {
    html += `<button class="ov-btn ${data.levelFilter === lv ? 'active' : ''}" data-log-level="${lv}">${lv}</button>`;
  }
  html += '</div>';
  html += '<div class="ov-btn-group">';
  for (const [label, ms] of [['1m', 60000], ['5m', 300000], ['1h', 3600000], ['All', 0]]) {
    html += `<button class="ov-btn ${data.timeRange === ms ? 'active' : ''}" data-log-time="${ms}">${label}</button>`;
  }
  html += '</div>';
  html += `<span class="ov-meta">${filtered.length} / ${events.length} events</span>`;
  html += '</div>';

  // Log entries
  html += '<div class="ov-log">';
  const recent = filtered.slice(-200).reverse();
  for (const e of recent) {
    const lvCls = `event-level-${e.level || 'info'}`;
    html += `<div class="ov-log-line">`;
    html += `<span class="ov-log-time">${fmtTime(e.ts)}</span>`;
    html += `<span class="ov-log-level ${lvCls}">${(e.level || 'info')[0].toUpperCase()}</span>`;
    html += `<span class="ov-log-source">${escHtml(e.source || '')}</span>`;
    html += `<span class="ov-log-msg">${escHtml(e.message || '')}</span>`;
    html += '</div>';
    if (e.detail) {
      for (let i = 0; i < e.detail.length; i++) {
        const branch = i < e.detail.length - 1 ? '├─' : '└─';
        html += `<div class="ov-log-detail"><span class="ov-log-branch">${branch}</span>${escHtml(e.detail[i])}</div>`;
      }
    }
  }
  if (recent.length === 0) html += '<div class="ov-empty">No matching events</div>';
  html += '</div>';

  el.innerHTML = html;

  // Search handler
  const searchEl = el.querySelector('#log-search');
  if (searchEl) {
    searchEl.addEventListener('input', (ev) => { data.filter = ev.target.value; renderF3LogTelescope(el, state, data); });
  }
  el.querySelectorAll('[data-log-level]').forEach(btn => {
    btn.addEventListener('click', () => { data.levelFilter = btn.dataset.logLevel; renderF3LogTelescope(el, state, data); });
  });
  el.querySelectorAll('[data-log-time]').forEach(btn => {
    btn.addEventListener('click', () => { data.timeRange = parseInt(btn.dataset.logTime); renderF3LogTelescope(el, state, data); });
  });
}

// ═══════════════════════════════════════════════════════════════
// F4 — Agent Observatory
// ═══════════════════════════════════════════════════════════════

function renderF4AgentObservatory(el, state, data) {
  const agents = state.agents || {};
  const agentList = Object.entries(agents);
  if (!data.selected) data.selected = null;
  if (!data.compareMode) data.compareMode = false;

  let html = section('Agent Fleet Overview');
  if (agentList.length === 0) {
    html += '<div class="ov-empty">No agents registered</div>';
    el.innerHTML = html;
    return;
  }

  // Fleet table
  const upMs = Date.now() - (state.startTime || Date.now());
  const upMin = Math.max(1, upMs / 60000);
  const rows = agentList.map(([name, a]) => {
    const sr = a.requestsTotal > 0 ? (a.requestsTotal - a.errorCount) / a.requestsTotal : 1;
    const srColor = sr >= 0.9 ? 'var(--green)' : sr >= 0.7 ? 'var(--gold)' : 'var(--coral)';
    const avgLat = a.latencyMs?.length > 0 ? (a.latencyMs.reduce((s, v) => s + v, 0) / a.latencyMs.length) : 0;
    const rate = (a.requestsTotal / upMin).toFixed(1);
    return [
      `<span class="ov-agent-name" data-agent="${name}" style="cursor:pointer;color:var(--cyan)">${name}</span>`,
      `<span style="color:${srColor}">${(sr * 100).toFixed(0)}%</span>`,
      a.requestsTotal,
      a.errorCount,
      fmtDuration(avgLat),
      fmtCost(a.costTotal),
      `${rate}/min`,
      `${a.requestsActive} / ${a.requestsTotal}`,
    ];
  });
  html += table(['Agent', 'SR%', 'Reqs', 'Errs', 'Avg Lat', 'Cost', 'Rate', 'Active/Total'], rows);

  // Agent detail cards
  html += section('Agent Details');
  html += '<div class="ov-agent-cards">';
  for (const [name, a] of agentList) {
    const sr = a.requestsTotal > 0 ? (a.requestsTotal - a.errorCount) / a.requestsTotal : 1;
    const srColor = sr >= 0.9 ? 'var(--green)' : sr >= 0.7 ? 'var(--gold)' : 'var(--coral)';
    const avgLat = a.latencyMs?.length > 0 ? (a.latencyMs.reduce((s, v) => s + v, 0) / a.latencyMs.length) : 0;

    html += `<div class="ov-agent-card">`;
    html += `<div class="ov-agent-card-header"><span style="color:var(--cyan);font-weight:600">${name}</span><span class="ov-dim">${a.model || name}</span></div>`;
    html += `<div class="ov-agent-card-body">`;
    html += `<div class="ov-kv"><span>Success Rate</span><span style="color:${srColor}">${(sr * 100).toFixed(1)}%</span></div>`;
    html += `<div class="ov-kv"><span>Avg Latency</span><span>${fmtDuration(avgLat)}</span></div>`;
    html += `<div class="ov-kv"><span>Total Cost</span><span>${fmtCost(a.costTotal)}</span></div>`;
    html += `<div class="ov-kv"><span>Tokens In</span><span>${(a.tokensIn || 0).toLocaleString()}</span></div>`;
    html += `<div class="ov-kv"><span>Tokens Out</span><span>${(a.tokensOut || 0).toLocaleString()}</span></div>`;
    html += `<div class="ov-kv"><span>Errors</span><span style="color:var(--coral)">${a.errorCount}</span></div>`;

    // Latency histogram
    if (a.latencyMs?.length > 0) {
      const buckets = [0, 0, 0, 0, 0]; // <.5s, <1s, <3s, <5s, 5s+
      for (const l of a.latencyMs) {
        if (l < 500) buckets[0]++;
        else if (l < 1000) buckets[1]++;
        else if (l < 3000) buckets[2]++;
        else if (l < 5000) buckets[3]++;
        else buckets[4]++;
      }
      const max = Math.max(1, ...buckets);
      html += '<div class="ov-hist">';
      const labels = ['<.5s', '<1s', '<3s', '<5s', '5s+'];
      for (let i = 0; i < 5; i++) {
        const h = Math.round((buckets[i] / max) * 30);
        html += `<div class="ov-hist-bar"><div style="height:${h}px;background:var(--cyan)"></div><span>${labels[i]}</span></div>`;
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  html += '</div>';

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// F5 — Consciousness Lab
// ═══════════════════════════════════════════════════════════════

const QUALIA_COLORS = {
  pleasure: 'var(--green)', confidence: 'var(--cyan)', frustration: 'var(--coral)',
  curiosity: 'var(--gold)', focus: 'var(--blue)', creativity: 'var(--purple)',
  determination: '#ff8c42', empathy: '#ff69b4', satisfaction: '#7CFC00',
  anxiety: '#ff4444', surprise: '#FFD700',
};

function renderF5ConsciousnessLab(el, state) {
  const qualia = state.currentQualia || {};
  const profile = state.consciousnessProfile || 'STANDARD';
  const monologue = state.innerMonologue || [];
  const introHist = state.introspectionHistory || [];

  let html = section('Consciousness Profile');
  html += `<div class="ov-profile-badge">${profile}</div>`;

  // Qualia dimensions
  html += section('Qualia State (11 dimensions)');
  html += '<div class="ov-qualia-grid">';
  for (const [dim, color] of Object.entries(QUALIA_COLORS)) {
    const val = qualia[dim] ?? 0;
    html += `<div class="ov-qualia-dim">`;
    html += `<span class="ov-qualia-label">${dim}</span>`;
    html += bar(val, color, 100);
    html += `<span class="ov-qualia-val">${val.toFixed(2)}</span>`;
    html += '</div>';
  }
  html += '</div>';

  // Self-model
  const conf = qualia.confidence ?? 0;
  const frust = qualia.frustration ?? 0;
  const breach = conf < 0.3 || frust > 0.8;
  html += section('Self-Model');
  html += '<div class="ov-self-model">';
  html += `<div class="ov-kv"><span>Breach State</span><span style="color:${breach ? 'var(--coral)' : 'var(--green)'}">${breach ? 'BREACH ACTIVE' : 'NOMINAL'}</span></div>`;
  const lm = Math.min(2.0, 1.0 + Math.min(0.5, (state.memoryStats?.skills || 0) * 0.1) + Math.min(0.3, (state.memoryStats?.procedures || 0) * 0.05));
  html += `<div class="ov-kv"><span>Learning Multiplier</span><span style="color:${lm >= 1.6 ? 'var(--green)' : lm >= 1.2 ? 'var(--gold)' : 'var(--text)'}">${lm.toFixed(2)}x</span></div>`;
  html += '</div>';

  // Qualia history sparklines
  const qh = state.qualiaHistory || {};
  if (Object.keys(qh).length > 0) {
    html += section('Qualia History');
    html += '<div class="ov-sparklines">';
    for (const [dim, history] of Object.entries(qh)) {
      if (!Array.isArray(history) || history.length < 2) continue;
      const color = QUALIA_COLORS[dim] || 'var(--dim)';
      html += `<div class="ov-sparkline-row"><span class="ov-sparkline-label">${dim}</span>${renderSparklineSVG(history, color)}</div>`;
    }
    html += '</div>';
  }

  // Inner monologue
  html += section('Inner Monologue');
  html += '<div class="ov-monologue">';
  for (const thought of monologue.slice(-15).reverse()) {
    const cat = guessCategory(thought);
    html += `<div class="ov-thought"><span class="monologue-tag" style="color:${cat.color}">[${cat.tag}]</span> ${escHtml(thought)}</div>`;
  }
  if (monologue.length === 0) html += '<div class="ov-empty">No thoughts yet</div>';
  html += '</div>';

  // Introspection history
  if (introHist.length > 0) {
    html += section('Introspection History');
    html += '<div class="ov-intro-list">';
    for (const item of introHist.slice(-10).reverse()) {
      html += `<div class="ov-intro-item">${escHtml(typeof item === 'string' ? item : JSON.stringify(item))}</div>`;
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

function guessCategory(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('plan') || t.includes('strateg')) return { tag: 'PLAN', color: 'var(--blue)' };
  if (t.includes('reflect') || t.includes('learn')) return { tag: 'REFLECT', color: 'var(--purple)' };
  if (t.includes('uncerta') || t.includes('unsure') || t.includes('confus')) return { tag: 'UNCERTAIN', color: 'var(--gold)' };
  if (t.includes('error') || t.includes('fail') || t.includes('wrong')) return { tag: 'ERROR', color: 'var(--coral)' };
  if (t.includes('success') || t.includes('complet') || t.includes('done')) return { tag: 'SUCCESS', color: 'var(--green)' };
  if (t.includes('?') || t.includes('should') || t.includes('what if')) return { tag: 'QUESTION', color: 'var(--cyan)' };
  return { tag: 'THOUGHT', color: 'var(--dim)' };
}

function renderSparklineSVG(data, color, w = 120, h = 20) {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data) || 1;
  const range = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ');
  return `<svg class="ov-sparkline-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

// ═══════════════════════════════════════════════════════════════
// F6 — Security Fortress
// ═══════════════════════════════════════════════════════════════

async function renderF6SecurityFortress(el, state, data) {
  if (!data.loaded) {
    el.innerHTML = '<div class="ov-loading">Loading security data...</div>';
    data.auditEntries = (await fetchJson('/api/audit'))?.entries || [];
    data.loaded = true;
  }

  const secEvents = state.securityEvents || [];
  const anomalies = state.anomalies || [];
  const threat = state.threatScore || 0;
  const audit = data.auditEntries || [];

  let html = section('Threat Level');
  const threatColor = threat >= 0.7 ? 'var(--coral)' : threat >= 0.3 ? 'var(--gold)' : 'var(--green)';
  html += `<div class="ov-threat">${bar(threat, threatColor, 300)}<span class="ov-threat-label" style="color:${threatColor}">${threat >= 0.7 ? 'HIGH' : threat >= 0.3 ? 'MEDIUM' : 'LOW'}</span></div>`;

  // Security events
  html += section(`Security Events (${secEvents.length})`);
  if (secEvents.length > 0) {
    const rows = secEvents.slice(-20).reverse().map(e => [
      fmtTime(e.ts),
      `<span style="color:var(--coral)">${e.type}</span>`,
      escHtml(e.message?.slice(0, 80) || ''),
    ]);
    html += table(['Time', 'Type', 'Message'], rows);
  } else {
    html += '<div class="ov-empty">No security events</div>';
  }

  // Anomalies
  if (anomalies.length > 0) {
    html += section(`Anomalies (${anomalies.length})`);
    const rows = anomalies.slice(-10).reverse().map(a => [
      fmtTime(a.ts),
      `<span style="color:${a.severity === 'high' ? 'var(--coral)' : 'var(--gold)'}">${a.severity}</span>`,
      a.type,
      escHtml(a.message?.slice(0, 60) || ''),
      a.acknowledged ? '<span style="color:var(--green)">ACK</span>' : '<span style="color:var(--dim)">--</span>',
    ]);
    html += table(['Time', 'Severity', 'Type', 'Message', 'Ack'], rows);
  }

  // Audit chain
  html += section(`Audit Log (${audit.length} entries)`);
  if (audit.length > 0) {
    // Verify chain integrity
    let chainOk = true;
    let verified = 0;
    for (let i = 1; i < audit.length; i++) {
      if (audit[i].prevHash && audit[i - 1].hash && audit[i].prevHash !== audit[i - 1].hash) {
        chainOk = false;
        break;
      }
      verified++;
    }
    html += `<div class="ov-audit-status">Chain integrity: <span style="color:${chainOk ? 'var(--green)' : 'var(--coral)'}">${chainOk ? '✓ VERIFIED' : '✗ BROKEN'}</span> (${verified} links verified)</div>`;

    const rows = audit.slice(-15).reverse().map(e => [
      fmtTime(e.timestamp || e.ts),
      e.component || '--',
      escHtml((e.action || e.message || '').slice(0, 60)),
      e.taskId ? e.taskId.slice(0, 8) : '--',
    ]);
    html += table(['Time', 'Component', 'Action', 'Task'], rows);
  } else {
    html += '<div class="ov-empty">No audit entries</div>';
  }

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// F7 — Evolution Engine
// ═══════════════════════════════════════════════════════════════

async function renderF7EvolutionEngine(el, state, data) {
  if (!data.loaded) {
    el.innerHTML = '<div class="ov-loading">Loading evolution data...</div>';
    const [reflRes, expRes, procRes, skillRes] = await Promise.all([
      fetchJson('/api/memory/reflections'),
      fetchJson('/api/memory/experiments'),
      fetchJson('/api/memory/procedures'),
      fetchJson('/api/skills'),
    ]);
    data.reflections = reflRes?.entries || [];
    data.experiments = expRes?.entries || [];
    data.procedures = procRes?.entries || [];
    data.skills = skillRes?.skills || [];
    data.loaded = true;
  }

  let html = '';

  // Skills overview
  html += section(`Distilled Skills (${data.skills.length})`);
  if (data.skills.length > 0) {
    const rows = data.skills.slice(0, 10).map(s => [
      escHtml(s.name || s.id || '--'),
      escHtml((s.description || '').slice(0, 60)),
      s.timesUsed || 0,
      s.successRate !== undefined ? `${(s.successRate * 100).toFixed(0)}%` : '--',
    ]);
    html += table(['Skill', 'Description', 'Uses', 'SR%'], rows);
  } else {
    html += '<div class="ov-empty">No distilled skills yet</div>';
  }

  // Genetic evolver (procedures as genomes)
  html += section(`Genetic Evolver — Procedure Pool (${data.procedures.length})`);
  if (data.procedures.length > 0) {
    const procs = data.procedures.map(p => ({
      ...p,
      fitness: (p.successRate || 0) * Math.sqrt((p.timesUsed || 0) + 1),
    })).sort((a, b) => b.fitness - a.fitness);

    // Population stats
    const fitnesses = procs.map(p => p.fitness);
    const mean = fitnesses.reduce((s, v) => s + v, 0) / fitnesses.length;
    const stdev = Math.sqrt(fitnesses.reduce((s, v) => s + (v - mean) ** 2, 0) / fitnesses.length);
    html += `<div class="ov-kv"><span>Population Size</span><span>${procs.length}</span></div>`;
    html += `<div class="ov-kv"><span>Mean Fitness</span><span>${mean.toFixed(2)}</span></div>`;
    html += `<div class="ov-kv"><span>Diversity (stdev)</span><span>${stdev.toFixed(2)}</span></div>`;

    // Top genomes
    html += '<div class="ov-genomes">';
    for (const p of procs.slice(0, 6)) {
      const stars = p.successRate >= 0.8 ? '★★★' : p.successRate >= 0.5 ? '★★○' : '★○○';
      html += `<div class="ov-genome"><span class="ov-genome-name">${escHtml(p.name || p.id || '--')}</span>`;
      html += `<span class="ov-genome-stars">${stars}</span>`;
      html += `${bar(p.fitness / (fitnesses[0] || 1), 'var(--cyan)', 80)}`;
      html += `<span class="ov-dim">fit:${p.fitness.toFixed(2)} uses:${p.timesUsed || 0}</span></div>`;
    }
    html += '</div>';

    // Mutation candidates
    const mutations = procs.filter(p => (p.successRate || 0) < 0.5 && (p.timesUsed || 0) > 3);
    if (mutations.length > 0) {
      html += `<div class="ov-mutation-label">Mutation Candidates (low SR, high usage): ${mutations.length}</div>`;
    }
  } else {
    html += '<div class="ov-empty">No procedures yet</div>';
  }

  // Reflections
  html += section(`Reflection Bank (${data.reflections.length})`);
  if (data.reflections.length > 0) {
    const sorted = [...data.reflections].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const r of sorted.slice(0, 10)) {
      const stars = (r.score ?? 0) >= 0.8 ? '★★★' : (r.score ?? 0) >= 0.5 ? '★★○' : '★○○';
      html += `<div class="ov-reflection"><span class="ov-reflection-stars">${stars}</span>${escHtml(r.summary || r.whatWorked || JSON.stringify(r).slice(0, 100))}</div>`;
    }
  } else {
    html += '<div class="ov-empty">No reflections yet</div>';
  }

  // Experiments
  html += section(`A/B Experiments (${data.experiments.length})`);
  if (data.experiments.length > 0) {
    const rows = data.experiments.slice(-8).reverse().map(e => {
      const elapsed = e.startTime ? Date.now() - e.startTime : 0;
      const prog = Math.min(1, elapsed / 3600000);
      return [
        e.status || '--',
        escHtml((e.description || e.id || '--').slice(0, 40)),
        bar(prog, 'var(--purple)', 60),
        e.result || '--',
      ];
    });
    html += table(['Status', 'Description', 'Progress', 'Result'], rows);
  } else {
    html += '<div class="ov-empty">No experiments yet</div>';
  }

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// F8 — Secure Vault
// ═══════════════════════════════════════════════════════════════

async function renderF8SecureVault(el, state, data) {
  if (!data.loaded) {
    el.innerHTML = '<div class="ov-loading">Loading config...</div>';
    data.config = await fetchJson('/api/config');
    data.loaded = true;
  }

  const config = data.config || {};
  let html = section('API Keys & Secrets');

  // Agent keys
  const agents = config.agents || {};
  html += '<div class="ov-vault-grid">';
  for (const [name, agent] of Object.entries(agents)) {
    const hasKey = agent.apiKey === '[HIDDEN]';
    const enabled = agent.enabled !== false;
    html += `<div class="ov-vault-card">`;
    html += `<div class="ov-vault-header"><span style="color:var(--cyan);text-transform:uppercase">${name}</span>`;
    html += `<span class="badge ${enabled ? 'badge-completed' : 'badge-pending'}">${enabled ? 'ON' : 'OFF'}</span></div>`;
    html += `<div class="ov-kv"><span>API Key</span><span style="color:${hasKey ? 'var(--green)' : 'var(--coral)'}">${hasKey ? '●●●●●●●● (set)' : 'NOT SET'}</span></div>`;
    html += `<div class="ov-kv"><span>Model</span><span>${agent.model || '--'}</span></div>`;
    html += `<div class="ov-kv"><span>Temperature</span><span>${agent.temperature ?? '--'}</span></div>`;
    html += '</div>';
  }
  html += '</div>';

  // Platform tokens
  html += section('Platform Tokens');
  const platforms = config.platforms || {};
  html += '<div class="ov-vault-grid">';
  for (const [name, plat] of Object.entries(platforms)) {
    const hasToken = plat.botToken === '[HIDDEN]';
    const enabled = plat.enabled !== false;
    html += `<div class="ov-vault-card">`;
    html += `<div class="ov-vault-header"><span style="text-transform:capitalize">${name}</span>`;
    html += `<span class="badge ${enabled ? 'badge-completed' : 'badge-pending'}">${enabled ? 'ON' : 'OFF'}</span></div>`;
    if (plat.botToken !== undefined) {
      html += `<div class="ov-kv"><span>Token</span><span style="color:${hasToken ? 'var(--green)' : 'var(--coral)'}">${hasToken ? '●●●●●●●● (set)' : 'NOT SET'}</span></div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  // Security limits
  html += section('Security Configuration');
  const sec = config.security || {};
  html += `<div class="ov-kv"><span>Max Cost/Task</span><span>${fmtCost(sec.maxCostPerTask)}</span></div>`;
  html += `<div class="ov-kv"><span>Max Cost/Session</span><span>${fmtCost(sec.maxCostPerSession)}</span></div>`;
  if (sec.blockedCommands?.length > 0) {
    html += `<div class="ov-kv"><span>Blocked Commands</span><span>${sec.blockedCommands.length} rules</span></div>`;
  }

  html += `<div class="ov-vault-actions"><a href="/settings" class="ov-btn active">Open Settings Page</a></div>`;

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// F9 — Network Sonar
// ═══════════════════════════════════════════════════════════════

function renderF9NetworkSonar(el, state) {
  const agents = state.agents || {};
  const platforms = state.platforms || {};
  const upMs = Date.now() - (state.startTime || Date.now());
  const upMin = Math.max(1, upMs / 60000);

  let html = section('Connection Map');

  // ASCII-style connection map
  html += '<pre class="ov-ascii-map">';
  html += '  PEPAGI\n';
  const connections = [];
  for (const [name, a] of Object.entries(agents)) {
    const avgLat = a.latencyMs?.length > 0 ? Math.round(a.latencyMs.reduce((s, v) => s + v, 0) / a.latencyMs.length) : 0;
    connections.push({ name: name.toUpperCase(), status: a.available ? '◉' : '○', latency: avgLat ? `${avgLat}ms` : '--', type: 'agent' });
  }
  for (const [name, p] of Object.entries(platforms)) {
    if (p.enabled) connections.push({ name: name.toUpperCase(), status: p.connected ? '◉' : '○', latency: p.connected ? 'CONNECTED' : 'DISCONNECTED', type: 'platform' });
  }
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i];
    const branch = i < connections.length - 1 ? '├──' : '└──';
    const statusColor = c.status === '◉' ? 'var(--green)' : 'var(--coral)';
    html += `  ${branch} <span style="color:${statusColor}">${c.status}</span> ${c.name}  ${c.latency}\n`;
  }
  html += '</pre>';

  // Rate limits
  html += section('Rate Limits');
  const RATE_LIMITS = { claude: 60, gpt: 60, gemini: 60, ollama: 999, lmstudio: 999 };
  const agentList = Object.entries(agents);
  if (agentList.length > 0) {
    const rows = agentList.map(([name, a]) => {
      const limit = RATE_LIMITS[name] || 60;
      const rate = a.requestsTotal / upMin;
      const usage = rate / limit;
      const color = usage >= 0.8 ? 'var(--coral)' : usage >= 0.5 ? 'var(--gold)' : 'var(--green)';
      return [
        `<span style="color:var(--cyan)">${name}</span>`,
        `${rate.toFixed(1)}/min`,
        `${limit}/min`,
        bar(Math.min(1, usage), color, 80),
      ];
    });
    html += table(['Provider', 'Rate', 'Limit', 'Usage'], rows);
  }

  // Bandwidth
  html += section('Bandwidth');
  const totalTokensIn = state.sessionTokensIn || 0;
  const totalTokensOut = state.sessionTokensOut || 0;
  const tokPerMin = (totalTokensIn + totalTokensOut) / upMin;
  html += `<div class="ov-kv"><span>Tokens In</span><span>${totalTokensIn.toLocaleString()}</span></div>`;
  html += `<div class="ov-kv"><span>Tokens Out</span><span>${totalTokensOut.toLocaleString()}</span></div>`;
  html += `<div class="ov-kv"><span>Throughput</span><span>${tokPerMin.toFixed(0)} tok/min</span></div>`;

  // Recent decisions as "API calls"
  html += section('Recent API Decisions');
  const decisions = state.decisions || [];
  if (decisions.length > 0) {
    const rows = decisions.slice(-10).reverse().map(d => [
      fmtTime(d.ts),
      d.decision?.action || '--',
      d.decision?.assignment?.agent || '--',
      `${((d.decision?.confidence || 0) * 100).toFixed(0)}%`,
    ]);
    html += table(['Time', 'Action', 'Agent', 'Confidence'], rows);
  } else {
    html += '<div class="ov-empty">No decisions yet</div>';
  }

  el.innerHTML = html;
}
