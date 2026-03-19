// PEPAGI Web Dashboard — Neural Stream Panel (TUI spec: 100%)

const LEVEL_ICONS = { info: '\u2139', warn: '\u26a0', error: '\u2718', debug: '\u2022' };

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

let currentFilter = 'all';
let autoScroll = true;
/** Set of event indices that are expanded */
const expandedEvents = new Set();

export function initEvents() {
  const filter = document.getElementById('event-filter');
  if (filter) {
    filter.addEventListener('change', (e) => {
      currentFilter = e.target.value;
    });
  }

  const body = document.getElementById('events-body');
  if (body) {
    body.addEventListener('scroll', () => {
      const atTop = body.scrollTop < 40;
      autoScroll = atTop;
    });
    // Delegate click for expand/collapse
    body.addEventListener('click', (e) => {
      const line = e.target.closest('[data-event-idx]');
      if (!line) return;
      const idx = line.getAttribute('data-event-idx');
      if (expandedEvents.has(idx)) {
        expandedEvents.delete(idx);
      } else {
        expandedEvents.add(idx);
      }
      // Re-render will happen on next frame
    });
  }
}

/** Detect category for color-coding source */
function sourceColor(source) {
  switch (source) {
    case 'mediator': return 'var(--cyan)';
    case 'tool': return 'var(--green)';
    case 'world': return 'var(--blue)';
    case 'planner': return 'var(--purple)';
    case 'causal': return 'var(--gold)';
    case 'watchdog': return 'var(--coral)';
    case 'security': return 'var(--coral)';
    case 'system': return 'var(--dim)';
    default: return 'var(--cyan)';
  }
}

/** Format qualia delta arrow */
function qualiaArrow(delta) {
  if (delta >= 0.05) return `<span style="color:var(--green)">\u2191${delta.toFixed(2)}</span>`;
  if (delta <= -0.05) return `<span style="color:var(--coral)">\u2193${Math.abs(delta).toFixed(2)}</span>`;
  return '';
}

export function renderEvents(state) {
  const body = document.getElementById('events-body');
  if (!body) return;

  const events = state.eventLog || [];
  const filtered = currentFilter === 'all' ? events : events.filter(e => e.level === currentFilter);
  const toShow = filtered.slice(-200);
  const offset = filtered.length - toShow.length;

  const html = [];
  // Render newest first — reverse iteration
  for (let i = toShow.length - 1; i >= 0; i--) {
    const e = toShow[i];
    const globalIdx = String(offset + i);
    const levelClass = 'event-level-' + e.level;
    const hasDetails = e.detail && e.detail.length > 0;
    const isExpanded = expandedEvents.has(globalIdx);
    const expandIcon = hasDetails ? (isExpanded ? ' \u25BC' : ' \u25B6') : '';
    const clickAttr = hasDetails ? `data-event-idx="${globalIdx}"` : '';
    const cursor = hasDetails ? 'style="cursor:pointer"' : '';

    // Qualia arrows (if present in detail)
    let qualiaHtml = '';
    if (e.qualiaDeltas && e.qualiaDeltas.length > 0) {
      qualiaHtml = e.qualiaDeltas.map(q => {
        const arrow = qualiaArrow(q.delta);
        return arrow ? `<span class="qualia-delta">${q.key}${arrow}</span>` : '';
      }).filter(Boolean).join(' ');
      if (qualiaHtml) qualiaHtml = ` <span class="qualia-deltas">${qualiaHtml}</span>`;
    }

    html.push(`<div class="event-line" ${clickAttr} ${cursor}>
      <span class="event-time">${fmtTime(e.ts)}</span>
      <span class="event-level ${levelClass}">${LEVEL_ICONS[e.level] || '\u2022'}</span>
      <span class="event-source" style="color:${sourceColor(e.source)}">${e.source}</span>
      <span class="event-msg">${escapeHtml(e.message)}${expandIcon}${qualiaHtml}</span>
    </div>`);

    // Detail sub-lines (tree display)
    if (hasDetails && isExpanded) {
      const details = e.detail;
      for (let j = 0; j < details.length; j++) {
        const branch = j === details.length - 1 ? '\u2514\u2500' : '\u251C\u2500';
        html.push(`<div class="event-detail">
          <span class="event-branch">${branch}</span>
          <span class="event-detail-text">${escapeHtml(details[j])}</span>
        </div>`);
      }
    }
  }

  body.innerHTML = html.join('');

  if (autoScroll) {
    body.scrollTop = 0;
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
