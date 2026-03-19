// PEPAGI Web Dashboard — Header Panel (TUI spec: 100%)

const BRAILLE_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
let spinnerFrame = 0;
let spinnerInterval = null;

function startSpinner() {
  if (spinnerInterval) return;
  const el = document.getElementById('header-spinner');
  if (!el) return;
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % BRAILLE_FRAMES.length;
    el.textContent = BRAILLE_FRAMES[spinnerFrame];
    el.style.display = '';
  }, 83); // ~12fps
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  const el = document.getElementById('header-spinner');
  if (el) el.style.display = 'none';
}

export function renderHeader(state) {
  // Uptime
  const uptime = document.getElementById('uptime');
  if (uptime) {
    const elapsed = Date.now() - (state.startTime || Date.now());
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    uptime.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // Cost + rate
  const cost = state.sessionCost || 0;
  const elapsed = (Date.now() - (state.startTime || Date.now())) / 1000;
  const costPerHour = elapsed > 60 ? (cost / elapsed * 3600) : 0;
  const costEl = document.getElementById('session-cost');
  if (costEl) costEl.textContent = '$' + cost.toFixed(3);
  const rateEl = document.getElementById('cost-rate');
  if (rateEl) {
    const rateColor = costPerHour > 5 ? 'var(--coral)' : costPerHour > 1 ? 'var(--gold)' : 'var(--green)';
    rateEl.textContent = `$${costPerHour.toFixed(2)}/hr`;
    rateEl.style.color = rateColor;
  }

  // Tasks
  const activeCount = Object.keys(state.activeTasks || {}).length;
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('tasks-active', activeCount);
  el('tasks-completed', state.totalCompleted || 0);
  el('tasks-failed', state.totalFailed || 0);

  // Agent count
  const agents = Object.values(state.agents || {});
  const online = agents.filter(a => a.available).length;
  el('agent-count', `${online}/${agents.length} agents`);

  // Learning multiplier
  const lmEl = document.getElementById('learning-multiplier');
  if (lmEl) {
    const qualia = state.currentQualia || {};
    const curiosity = qualia.curiosity || 0;
    const frustration = qualia.frustration || 0;
    const mult = 1.0 + curiosity * 0.6 + frustration * 0.4;
    const color = mult >= 1.6 ? 'var(--green)' : mult >= 1.2 ? 'var(--gold)' : 'var(--dim)';
    lmEl.textContent = `\u2211${mult.toFixed(1)}\u00d7`;
    lmEl.style.color = color;
  }

  // Animated braille spinner when tasks active
  if (activeCount > 0) {
    startSpinner();
  } else {
    stopSpinner();
  }
}
