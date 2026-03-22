// PEPAGI Web Dashboard — Pipeline Panel (TUI spec: 100%)

const STATUS_ICONS = {
  pending: '\u25cb', queued: '\u25cc', assigned: '\u25d0', running: '\u25cf',
  waiting_subtasks: '\u2299', review: '\u25c9', completed: '\u2713', failed: '\u2717', cancelled: '\u2012',
};

function badgeClass(status) {
  if (status === 'completed') return 'badge badge-completed';
  if (status === 'failed') return 'badge badge-failed';
  if (status === 'running') return 'badge badge-running';
  if (status === 'assigned') return 'badge badge-assigned';
  if (status === 'waiting_subtasks') return 'badge badge-assigned';
  return 'badge badge-pending';
}

function diffBadge(diff) {
  return `<span class="badge badge-${diff || 'unknown'}">${diff || '?'}</span>`;
}

function confBar(conf) {
  const pct = Math.round((conf || 0) * 100);
  const color = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--coral)';
  return `<span class="conf-bar">
    <span class="conf-bar-track"><span class="conf-bar-fill" style="width:${pct}%;background:${color}"></span></span>
    <span class="conf-bar-label">${pct}%</span>
  </span>`;
}

function fmtDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
}

function fmtCost(n) {
  return '$' + (n || 0).toFixed(4);
}

function trunc(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Stage timeline visualization */
function stageTimeline(t) {
  const now = Date.now();
  const stages = [];
  const pendMs = t.assignedAt ? t.assignedAt - t.createdAt : (t.startedAt ? t.startedAt - t.createdAt : now - t.createdAt);
  stages.push({ label: 'pend', done: !!t.assignedAt || !!t.startedAt, ms: pendMs });
  if (t.assignedAt) {
    const asgnMs = t.startedAt ? t.startedAt - t.assignedAt : now - t.assignedAt;
    stages.push({ label: 'asgn', done: !!t.startedAt, ms: asgnMs });
  }
  if (t.startedAt) {
    const runMs = t.durationMs ? (t.durationMs - (t.startedAt - t.createdAt)) : (now - t.startedAt);
    stages.push({ label: 'run', done: t.status === 'completed' || t.status === 'failed', ms: Math.max(0, runMs) });
  }
  if (t.status === 'completed' || t.status === 'failed') {
    stages.push({ label: t.status === 'completed' ? 'done' : 'fail', done: true, ms: 0 });
  }

  const icons = stages.map(s => {
    const icon = s.done ? '\u2713' : '\u25ce';
    return `<span class="stage-node ${s.done ? 'stage-done' : 'stage-active'}">${icon}${s.label}</span>`;
  }).join('<span class="stage-line">\u2500</span>');

  const timings = stages.filter(s => s.ms > 0).map(s => `${s.label}:${fmtDuration(s.ms)}`).join(' \u00b7 ');

  return `<div class="stage-timeline">${icons}</div>
    <div class="stage-timings">${timings}</div>`;
}

/** Swarm visualization */
function swarmViz(branches) {
  if (!branches || branches <= 0) return '';
  return `<div class="swarm-badge">\u27e8SWARM: ${branches} branches\u27e9</div>`;
}

/** Streaming token counter */
let prevTokIn = 0, prevTokOut = 0, prevTokTs = 0;
let tokenRateIn = 0, tokenRateOut = 0;

function updateStreamingCounter(state) {
  const now = Date.now();
  const dt = (now - prevTokTs) / 1000;
  if (dt > 0.5 && prevTokTs > 0) {
    const dIn = (state.sessionTokensIn || 0) - prevTokIn;
    const dOut = (state.sessionTokensOut || 0) - prevTokOut;
    tokenRateIn = Math.round((dIn / dt) * 60);
    tokenRateOut = Math.round((dOut / dt) * 60);
  }
  prevTokIn = state.sessionTokensIn || 0;
  prevTokOut = state.sessionTokensOut || 0;
  prevTokTs = now;
}

function streamingBadge(state) {
  const active = Object.values(state.activeTasks || {}).some(t => t.status === 'running');
  if (!active && tokenRateIn === 0 && tokenRateOut === 0) return '';
  const pulse = Math.floor(Date.now() / 400) % 2 === 0 ? '\u25cf' : '\u25cb';
  return `<span class="streaming-badge">${pulse} STREAMING \u2191${tokenRateIn} tok/min \u2193${tokenRateOut} tok/min</span>`;
}

/** Set of task IDs whose detail is expanded */
const expandedTasks = new Set();

/** Current view mode: 'table' or 'kanban' */
let viewMode = 'table';

/** Map task status to kanban column */
function statusToKanban(status) {
  if (status === 'pending' || status === 'queued') return 'todo';
  if (status === 'assigned' || status === 'running' || status === 'waiting_subtasks') return 'doing';
  if (status === 'review') return 'review';
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'todo';
}

/** Render a kanban card */
function kanbanCard(t) {
  const pct = Math.round((t.confidence || 0) * 100);
  const confColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--coral)';
  return `<div class="kanban-card" title="${escapeHtml(t.title)}">
    <div class="kanban-card-title">${trunc(t.title, 40)}</div>
    <div class="kanban-card-meta">
      <span class="kanban-card-agent">${t.agent || '-'}</span>
      <span class="kanban-card-conf"><span class="kanban-card-conf-fill" style="width:${pct}%;background:${confColor}"></span></span>
      <span class="kanban-card-cost">${fmtCost(t.cost)}</span>
      ${t.difficulty ? diffBadge(t.difficulty) : ''}
    </div>
  </div>`;
}

/** Render the kanban board */
function renderKanban(state) {
  const active = Object.values(state.activeTasks || {});
  const completed = (state.completedTasks || []).slice(-20).reverse();
  const all = [...active, ...completed];

  const columns = { todo: [], doing: [], review: [], done: [], failed: [] };
  for (const t of all) {
    const col = statusToKanban(t.status);
    columns[col].push(t);
  }

  for (const [col, tasks] of Object.entries(columns)) {
    const el = document.getElementById(`kanban-${col}`);
    if (!el) continue;
    if (tasks.length === 0) {
      el.innerHTML = `<div class="kanban-col-empty">empty</div>`;
    } else {
      el.innerHTML = tasks.map(kanbanCard).join('');
    }
  }
}

/** Toggle between table and kanban views */
export function toggleTaskView() {
  viewMode = viewMode === 'table' ? 'kanban' : 'table';
  const table = document.getElementById('tasks-table');
  const kanban = document.getElementById('kanban-board');
  const btn = document.getElementById('task-view-toggle');
  if (table) table.style.display = viewMode === 'table' ? '' : 'none';
  if (kanban) kanban.style.display = viewMode === 'kanban' ? '' : 'none';
  if (btn) btn.innerHTML = viewMode === 'table' ? '&#9638; Kanban' : '&#9776; Table';
}

// Expose toggle globally for onclick
if (typeof window !== 'undefined') {
  window.__toggleTaskView = toggleTaskView;
}

export function renderTasks(state) {
  updateStreamingCounter(state);
  const tbody = document.getElementById('tasks-tbody');
  const empty = document.getElementById('tasks-empty');
  if (!tbody) return;

  const active = Object.values(state.activeTasks || {});
  const completed = (state.completedTasks || []).slice(-20).reverse();
  const all = [...active, ...completed];

  // Streaming counter in panel header
  const panelHeader = document.querySelector('#panel-tasks .panel-header');
  if (panelHeader) {
    let badge = panelHeader.querySelector('.streaming-badge');
    const html = streamingBadge(state);
    if (html) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'streaming-badge';
        panelHeader.appendChild(badge);
      }
      badge.outerHTML = html;
    } else if (badge) {
      badge.remove();
    }
  }

  if (all.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }

  if (empty) empty.style.display = 'none';

  const rows = [];
  for (const t of all) {
    const isExpanded = expandedTasks.has(t.id);
    const expandIcon = isExpanded ? ' \u25BC' : ' \u25B6';
    const isRunning = t.status === 'running';

    rows.push(`<tr class="task-row task-clickable" data-task-id="${t.id}">
      <td><span class="${badgeClass(t.status)}">${STATUS_ICONS[t.status] || '?'} ${t.status}${isRunning ? ' \u25cf' : ''}</span></td>
      <td title="${escapeHtml(t.title)}">${trunc(t.title, 50)}${expandIcon}</td>
      <td style="color:var(--cyan)">${t.agent || '-'}</td>
      <td>${diffBadge(t.difficulty)}</td>
      <td>${confBar(t.confidence)}</td>
      <td style="color:var(--gold)">${fmtCost(t.cost)}</td>
      <td>${t.durationMs ? fmtDuration(t.durationMs) : (t.createdAt ? fmtDuration(Date.now() - t.createdAt) : '-')}</td>
    </tr>`);

    // Result preview for completed/failed tasks (visible without expanding)
    if ((t.status === 'completed' || t.status === 'failed') && t.result) {
      const icon = t.status === 'failed' ? '\u2717 ' : '\u2713 ';
      const full = escapeHtml(t.result);
      rows.push(`<tr class="task-result-preview-row" data-task-id="${t.id}">
        <td colspan="7">
          <div class="task-result-preview">${icon}${full}</div>
        </td>
      </tr>`);
    }

    // Expanded detail view
    if (isExpanded) {
      rows.push(`<tr class="task-detail-row"><td colspan="7">
        <div class="task-detail-grid">
          <div class="task-detail-section">
            <div class="task-detail-item"><span class="td-label">ID</span><span class="td-value">${t.id}</span></div>
            <div class="task-detail-item"><span class="td-label">Status</span><span class="td-value">${t.status}</span></div>
            <div class="task-detail-item"><span class="td-label">Agent</span><span class="td-value" style="color:var(--cyan)">${t.agent || 'unassigned'}</span></div>
            <div class="task-detail-item"><span class="td-label">Difficulty</span><span class="td-value">${t.difficulty || '?'}</span></div>
            <div class="task-detail-item"><span class="td-label">Confidence</span><span class="td-value">${Math.round((t.confidence || 0) * 100)}%</span></div>
            <div class="task-detail-item"><span class="td-label">Cost</span><span class="td-value" style="color:var(--gold)">${fmtCost(t.cost)}</span></div>
            <div class="task-detail-item"><span class="td-label">Duration</span><span class="td-value">${fmtDuration(t.durationMs)}</span></div>
          </div>
          <div class="task-detail-section">
            ${stageTimeline(t)}
            ${swarmViz(t.swarmBranches)}
          </div>
        </div>
        ${t.result ? `<div class="task-result-text">${escapeHtml(t.result)}</div>` : ''}
      </td></tr>`);
    }
  }

  tbody.innerHTML = rows.join('');

  // Attach click handlers for expand/collapse
  tbody.querySelectorAll('[data-task-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-task-id');
      if (expandedTasks.has(id)) {
        expandedTasks.delete(id);
      } else {
        expandedTasks.add(id);
      }
      renderTasks(state);
    });
  });

  // Also render kanban view (it may be hidden but keeps data fresh)
  renderKanban(state);
}
