// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — Bottom Status Bar
// ═══════════════════════════════════════════════════════════════

export function renderBottomBar(state) {
  const bar = document.getElementById('bottom-bar');
  if (!bar) return;

  const activeTasks = Object.values(state.activeTasks || {}).length;
  const agents = Object.entries(state.agents || {});
  const activeAgents = agents.filter(([, a]) => (a.requestsActive || 0) > 0).length;
  const anomalies = (state.anomalies || []).filter(a => !a.acknowledged).length;
  const totalReqs = agents.reduce((s, [, a]) => s + (a.requestsTotal || 0), 0);
  const uptime = Date.now() - (state.startTime || Date.now());
  const tokPerMin = uptime > 60000 ? ((state.sessionTokensIn || 0) + (state.sessionTokensOut || 0)) / (uptime / 60000) : 0;

  let html = '<div class="bb-left">';
  html += `<span class="bb-item">Tasks: <span class="bb-val">${activeTasks}</span> active</span>`;
  html += `<span class="bb-sep">|</span>`;
  html += `<span class="bb-item">Agents: <span class="bb-val">${activeAgents}/${agents.length}</span></span>`;
  html += `<span class="bb-sep">|</span>`;
  html += `<span class="bb-item">Reqs: <span class="bb-val">${totalReqs}</span></span>`;
  html += `<span class="bb-sep">|</span>`;
  html += `<span class="bb-item">${tokPerMin.toFixed(0)} tok/min</span>`;
  html += '</div>';

  html += '<div class="bb-center">';
  html += '<span id="pause-indicator" class="bb-pause" style="display:none">PAUSED</span>';
  html += `<span id="anomaly-indicator" class="anomaly-indicator anomaly-clear">${anomalies > 0 ? anomalies + ' anomalies' : 'nominal'}</span>`;
  html += '</div>';

  html += '<div class="bb-right">';
  html += '<span class="bb-shortcuts">';
  html += '<kbd>F1</kbd>-<kbd>F9</kbd> overlays';
  html += ' <kbd>Ctrl+R</kbd> replay';
  html += ' <kbd>Ctrl+G</kbd> graph';
  html += ' <kbd>/</kbd> search';
  html += '</span>';
  html += '</div>';

  bar.innerHTML = html;
}
