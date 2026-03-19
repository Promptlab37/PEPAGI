// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — Floating Widgets
// Decision Replay (Ctrl+R) + Thought Graph (Ctrl+G)
// ═══════════════════════════════════════════════════════════════

let storeRef = null;

export function initWidgets(store) {
  storeRef = store;
}

// ── Decision Replay (Ctrl+R) ───────────────────────────────────

let replayEl = null;
let replayOpen = false;
let replayIdx = 0;
let replayMode = 'overview'; // overview | prompt | whatif

export function toggleDecisionReplay() {
  if (replayOpen) { closeDecisionReplay(); return; }
  openDecisionReplay();
}

function openDecisionReplay() {
  replayOpen = true;
  replayIdx = 0;
  replayMode = 'overview';
  if (!replayEl) {
    replayEl = document.createElement('div');
    replayEl.className = 'widget widget-replay';
    replayEl.innerHTML = `
      <div class="widget-header" data-drag="replay">
        <span class="widget-title">Decision Replay [Ctrl+R]</span>
        <div class="widget-controls">
          <button class="widget-btn" data-replay-mode="overview" title="Overview">O</button>
          <button class="widget-btn" data-replay-mode="prompt" title="Worker Prompt">P</button>
          <button class="widget-btn" data-replay-mode="whatif" title="What-If">W</button>
          <button class="widget-close">&times;</button>
        </div>
      </div>
      <div class="widget-nav">
        <button class="widget-btn" id="replay-prev">&larr;</button>
        <span id="replay-counter">0/0</span>
        <button class="widget-btn" id="replay-next">&rarr;</button>
      </div>
      <div class="widget-body" id="replay-body"></div>
    `;
    document.body.appendChild(replayEl);

    // Close button
    replayEl.querySelector('.widget-close').addEventListener('click', closeDecisionReplay);

    // Navigation
    replayEl.querySelector('#replay-prev').addEventListener('click', () => {
      if (replayIdx > 0) { replayIdx--; renderReplay(); }
    });
    replayEl.querySelector('#replay-next').addEventListener('click', () => {
      const decisions = storeRef?.getAll()?.decisions || [];
      if (replayIdx < decisions.length - 1) { replayIdx++; renderReplay(); }
    });

    // Mode buttons
    replayEl.querySelectorAll('[data-replay-mode]').forEach(btn => {
      btn.addEventListener('click', () => { replayMode = btn.dataset.replayMode; renderReplay(); });
    });

    makeDraggable(replayEl, '[data-drag="replay"]');
  }
  replayEl.style.display = 'flex';
  renderReplay();
}

function closeDecisionReplay() {
  replayOpen = false;
  if (replayEl) replayEl.style.display = 'none';
}

function renderReplay() {
  const body = document.getElementById('replay-body');
  const counter = document.getElementById('replay-counter');
  if (!body || !storeRef) return;

  const decisions = storeRef.getAll()?.decisions || [];
  counter.textContent = decisions.length > 0 ? `${replayIdx + 1}/${decisions.length}` : '0/0';

  // Highlight active mode
  replayEl.querySelectorAll('[data-replay-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.replayMode === replayMode);
  });

  if (decisions.length === 0) {
    body.innerHTML = '<div class="ov-empty">No decisions recorded yet</div>';
    return;
  }

  const rec = decisions[replayIdx];
  const d = rec.decision || {};

  if (replayMode === 'overview') {
    let html = `<div class="widget-section">`;
    html += `<div class="ov-kv"><span>Time</span><span>${new Date(rec.ts).toLocaleTimeString('en-GB')}</span></div>`;
    html += `<div class="ov-kv"><span>Task</span><span>${(rec.taskId || '').slice(0, 12)}</span></div>`;
    html += `<div class="ov-kv"><span>Action</span><span style="color:var(--cyan)">${d.action || '--'}</span></div>`;
    html += `<div class="ov-kv"><span>Confidence</span><span>${((d.confidence || 0) * 100).toFixed(0)}%</span></div>`;
    if (d.reasoning) html += `<div class="widget-reasoning">${esc(d.reasoning)}</div>`;
    if (d.assignment?.agent) html += `<div class="ov-kv"><span>Assigned To</span><span>${d.assignment.agent}</span></div>`;
    if (d.subtasks?.length) {
      html += `<div class="widget-subtasks">Subtasks: ${d.subtasks.length}`;
      for (const st of d.subtasks) {
        html += `<div class="widget-subtask">• ${esc(st.title || st.description || JSON.stringify(st).slice(0, 60))}</div>`;
      }
      html += '</div>';
    }
    if (d.consciousnessNote) html += `<div class="widget-note">${esc(d.consciousnessNote)}</div>`;
    html += '</div>';
    body.innerHTML = html;

  } else if (replayMode === 'prompt') {
    const prompt = d.assignment?.prompt || d.workerPrompt || '(no prompt recorded)';
    body.innerHTML = `<pre class="widget-prompt">${esc(prompt)}</pre>`;

  } else if (replayMode === 'whatif') {
    let html = '<div class="widget-section">';
    // Show alternatives if recorded
    if (d.alternatives?.length) {
      html += '<div class="ov-section-title">Rejected Alternatives</div>';
      for (const alt of d.alternatives) {
        html += `<div class="widget-alt"><span style="color:var(--dim)">option</span> ${esc(alt.action || JSON.stringify(alt).slice(0, 80))} — conf:${((alt.confidence || 0) * 100).toFixed(0)}%</div>`;
      }
    }
    // Synthetic what-if comparison
    html += '<div class="ov-section-title">What-If Cost Comparison</div>';
    const agents = storeRef.getAll()?.agents || {};
    for (const [name, a] of Object.entries(agents)) {
      const avgCostPer1k = a.costTotal > 0 && a.tokensOut > 0 ? (a.costTotal / a.tokensOut) * 1000 : 0;
      const estCost = avgCostPer1k * 0.5; // ~500 output tokens
      const chosen = d.assignment?.agent === name;
      html += `<div class="widget-whatif-row ${chosen ? 'chosen' : ''}">`;
      html += `<span>${chosen ? '►' : ' '} ${name}</span>`;
      html += `<span>${estCost > 0 ? `~$${estCost.toFixed(4)}` : '--'}</span>`;
      html += `<span style="color:var(--dim)">${chosen ? 'CHOSEN' : 'option'}</span>`;
      html += '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  }
}

// ── Thought Graph (Ctrl+G) ────────────────────────────────────

let graphEl = null;
let graphOpen = false;
let graphData = null;
let graphTaskIdx = 0;

export function toggleThoughtGraph() {
  if (graphOpen) { closeThoughtGraph(); return; }
  openThoughtGraph();
}

async function openThoughtGraph() {
  graphOpen = true;
  graphTaskIdx = 0;
  if (!graphEl) {
    graphEl = document.createElement('div');
    graphEl.className = 'widget widget-graph';
    graphEl.innerHTML = `
      <div class="widget-header" data-drag="graph">
        <span class="widget-title">Thought Graph [Ctrl+G]</span>
        <div class="widget-controls">
          <button class="widget-btn" id="graph-refresh" title="Refresh">R</button>
          <button class="widget-close">&times;</button>
        </div>
      </div>
      <div class="widget-nav">
        <button class="widget-btn" id="graph-prev">&larr;</button>
        <span id="graph-counter">0/0</span>
        <button class="widget-btn" id="graph-next">&rarr;</button>
      </div>
      <div class="widget-body" id="graph-body"></div>
    `;
    document.body.appendChild(graphEl);

    graphEl.querySelector('.widget-close').addEventListener('click', closeThoughtGraph);
    graphEl.querySelector('#graph-prev').addEventListener('click', () => {
      if (graphTaskIdx > 0) { graphTaskIdx--; renderGraph(); }
    });
    graphEl.querySelector('#graph-next').addEventListener('click', () => {
      if (graphData && graphTaskIdx < graphData.tasks.length - 1) { graphTaskIdx++; renderGraph(); }
    });
    graphEl.querySelector('#graph-refresh').addEventListener('click', () => { graphData = null; loadAndRenderGraph(); });

    makeDraggable(graphEl, '[data-drag="graph"]');
  }
  graphEl.style.display = 'flex';
  await loadAndRenderGraph();
}

function closeThoughtGraph() {
  graphOpen = false;
  if (graphEl) graphEl.style.display = 'none';
}

async function loadAndRenderGraph() {
  const body = document.getElementById('graph-body');
  if (!body) return;
  if (!graphData) {
    body.innerHTML = '<div class="ov-loading">Loading causal data...</div>';
    graphData = await fetchJson('/api/causal');
    if (!graphData) graphData = { tasks: [] };
  }
  renderGraph();
}

function renderGraph() {
  const body = document.getElementById('graph-body');
  const counter = document.getElementById('graph-counter');
  if (!body || !graphData) return;

  const tasks = graphData.tasks || [];
  counter.textContent = tasks.length > 0 ? `${graphTaskIdx + 1}/${tasks.length}` : '0/0';

  if (tasks.length === 0) {
    body.innerHTML = '<div class="ov-empty">No causal chain data. Run tasks to generate.</div>';
    return;
  }

  const task = tasks[graphTaskIdx];
  const nodes = task.data?.nodes || [];

  let html = `<div class="widget-section">`;
  html += `<div class="ov-kv"><span>Task</span><span>${task.taskId?.slice(0, 12) || task.file}</span></div>`;
  html += `<div class="ov-kv"><span>Nodes</span><span>${nodes.length}</span></div>`;

  const success = nodes.filter(n => n.outcome === 'success').length;
  const failed = nodes.filter(n => n.outcome === 'failure').length;
  const pending = nodes.filter(n => n.outcome === 'pending').length;
  const counterfactuals = nodes.filter(n => n.counterfactual).length;
  html += `<div class="ov-kv"><span>Outcomes</span><span><span style="color:var(--green)">✓${success}</span> <span style="color:var(--coral)">✗${failed}</span> <span style="color:var(--dim)">○${pending}</span></span></div>`;
  if (counterfactuals > 0) html += `<div class="ov-kv"><span>Counterfactuals</span><span>${counterfactuals}</span></div>`;

  // Build tree
  const parentMap = {};
  for (const n of nodes) {
    const pid = n.parentNodeId || '__root__';
    if (!parentMap[pid]) parentMap[pid] = [];
    parentMap[pid].push(n);
  }

  html += '<pre class="widget-tree">';
  const roots = parentMap['__root__'] || nodes.filter(n => !n.parentNodeId);
  for (const root of roots) {
    html += renderTreeNode(root, parentMap, '', true);
  }
  html += '</pre>';
  html += '</div>';

  body.innerHTML = html;
}

function renderTreeNode(node, parentMap, prefix, isLast) {
  const branch = isLast ? '└─' : '├─';
  const outcomeChar = node.outcome === 'success' ? '✓' : node.outcome === 'failure' ? '✗' : '○';
  const outcomeColor = node.outcome === 'success' ? 'var(--green)' : node.outcome === 'failure' ? 'var(--coral)' : 'var(--dim)';
  let html = `${prefix}${branch} <span style="color:${outcomeColor}">${outcomeChar}</span> ${esc(node.action || '--')}`;
  if (node.reason) html += `\n${prefix}${isLast ? '  ' : '│ '}  <span style="color:var(--dim)">${esc(node.reason.slice(0, 70))}</span>`;
  if (node.counterfactual) html += `\n${prefix}${isLast ? '  ' : '│ '}  <span style="color:var(--gold)">↯ ${esc(node.counterfactual.slice(0, 70))}</span>`;
  html += '\n';

  const children = parentMap[node.id] || [];
  for (let i = 0; i < children.length; i++) {
    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    html += renderTreeNode(children[i], parentMap, childPrefix, i === children.length - 1);
  }
  return html;
}

// ── Draggable widget support ──────────────────────────────────

function makeDraggable(el, handleSelector) {
  const handle = el.querySelector(handleSelector);
  if (!handle) return;
  let isDragging = false;
  let offsetX = 0, offsetY = 0;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = el.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    el.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    el.style.left = `${e.clientX - offsetX}px`;
    el.style.top = `${e.clientY - offsetY}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    el.style.transition = '';
  });
}

// ── Helpers ────────────────────────────────────────────────────

function esc(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

export function isWidgetOpen() { return replayOpen || graphOpen; }
