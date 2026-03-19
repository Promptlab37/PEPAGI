// PEPAGI Web Dashboard — Security Panel

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function threatColor(score) {
  if (score > 0.7) return 'var(--coral)';
  if (score > 0.3) return 'var(--gold)';
  return 'var(--green)';
}

function threatLevel(score) {
  if (score > 0.7) return 'DANGER';
  if (score > 0.3) return 'CAUTION';
  return 'SAFE';
}

const EVENT_COLORS = {
  blocked: 'var(--coral)',
  cost_warning: 'var(--gold)',
  injection: 'var(--coral)',
  tripwire: 'var(--coral)',
};

export function renderSecurity(state) {
  const gauge = document.getElementById('threat-gauge');
  const list = document.getElementById('security-events');
  if (!gauge) return;

  const score = state.threatScore || 0;
  const pct = Math.round(score * 100);
  const color = threatColor(score);
  const level = threatLevel(score);

  gauge.innerHTML = `
    <span class="threat-label" style="color:${color}">${level}</span>
    <div class="threat-bar">
      <div class="threat-fill" style="width:${pct}%;background:${color}"></div>
    </div>
    <span class="threat-label" style="color:${color}">${pct}%</span>
  `;

  // Security events
  if (list) {
    const events = (state.securityEvents || []).slice(-15).reverse();
    if (events.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:8px">No security events</div>';
      return;
    }
    list.innerHTML = events.map(e => `
      <div class="sec-event">
        <span class="event-time">${fmtTime(e.ts)}</span>
        <span class="sec-event-type" style="color:${EVENT_COLORS[e.type] || 'var(--dim)'}">${e.type}</span>
        <span class="sec-event-msg">${escapeHtml(e.message)}</span>
      </div>
    `).join('');
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
