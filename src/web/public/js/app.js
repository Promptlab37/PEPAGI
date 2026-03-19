// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — App Bootstrap
// ═══════════════════════════════════════════════════════════════

import { StateStore } from './state.js';
import { WSClient } from './ws-client.js';
import { renderHeader } from './panels/header.js';
import { renderTasks } from './panels/tasks.js';
import { renderAgents } from './panels/agents.js';
import { initEvents, renderEvents } from './panels/events.js';
import { renderConsciousness } from './panels/consciousness.js';
import { renderThoughts } from './panels/thoughts.js';
import { renderMemory } from './panels/memory.js';
import { renderCost } from './panels/cost.js';
import { renderPlatforms } from './panels/platforms.js';
import { renderSecurity } from './panels/security.js';
import { initOverlays, refreshOverlay, isOverlayOpen } from './overlays.js';
import { initWidgets } from './widgets.js';
import { initAnomalyPulse } from './anomaly.js';
import { initKeyboard } from './keyboard.js';
import { renderBottomBar } from './bottom-bar.js';

const store = new StateStore();
let renderScheduled = false;

// ── Interaction guard ────────────────────────────────────────
// When user is scrolling or clicking inside panels, defer full
// DOM re-renders to prevent scroll resets and dropdown closures.

let userInteracting = false;
let interactionTimer = null;
let deferredRender = false;
let lastRenderVersion = -1;

function markInteracting() {
  userInteracting = true;
  clearTimeout(interactionTimer);
  interactionTimer = setTimeout(() => {
    userInteracting = false;
    if (deferredRender) {
      deferredRender = false;
      scheduleRender();
    }
  }, 1500);
}

document.addEventListener('scroll', markInteracting, true);
document.addEventListener('mousedown', markInteracting, true);
document.addEventListener('focusin', markInteracting, true);

// ── Render scheduling ────────────────────────────────────────

/** Schedule a full render — skips if no state change or user is interacting. */
function scheduleRender() {
  if (renderScheduled) return;
  const ver = store.getVersion();
  if (ver === lastRenderVersion) return; // no state change

  if (userInteracting) {
    deferredRender = true;
    return;
  }

  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    lastRenderVersion = store.getVersion();
    renderAll();
  });
}

/** Track last shown response to avoid redundant DOM updates */
let lastResponseId = null;

function renderLastResponse(state) {
  const panel = document.getElementById('last-response');
  const titleEl = document.getElementById('last-response-title');
  const bodyEl = document.getElementById('last-response-body');
  if (!panel || !titleEl || !bodyEl) return;

  const completed = state.completedTasks || [];
  if (completed.length === 0) { panel.style.display = 'none'; return; }

  // Most recent completed task (array is oldest→newest)
  const last = completed[completed.length - 1];
  if (!last.result || last.id === lastResponseId) return;

  lastResponseId = last.id;
  const icon = document.querySelector('.last-response-icon');
  if (icon) icon.innerHTML = last.status === 'failed' ? '&#10007;' : '&#10003;';
  titleEl.textContent = last.title || 'Response';
  bodyEl.textContent = last.result;
  panel.style.display = '';
}

function renderAll() {
  const state = store.getAll();
  renderHeader(state);
  renderTasks(state);
  renderAgents(state);
  renderEvents(state);
  renderConsciousness(state);
  renderThoughts(state);
  renderMemory(state);
  renderCost(state);
  renderPlatforms(state);
  renderSecurity(state);
  renderBottomBar(state);
  renderLastResponse(state);
  // Refresh active overlay if open
  if (isOverlayOpen()) refreshOverlay();
}

// ── Lightweight timer updates ────────────────────────────────
// Updates ONLY time-dependent text elements (uptime, cost rate)
// without touching DOM structure or innerHTML. Runs every 1s.

function renderTimers() {
  const state = store.getAll();

  // Uptime counter
  const uptime = document.getElementById('uptime');
  if (uptime) {
    const elapsed = Date.now() - (state.startTime || Date.now());
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    uptime.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // Session cost (may change between full renders)
  const costEl = document.getElementById('session-cost');
  const cost = state.sessionCost || 0;
  if (costEl) costEl.textContent = '$' + cost.toFixed(3);

  // Cost rate
  const elapsedSec = (Date.now() - (state.startTime || Date.now())) / 1000;
  const costPerHour = elapsedSec > 60 ? (cost / elapsedSec * 3600) : 0;
  const rateEl = document.getElementById('cost-rate');
  if (rateEl) {
    const rateColor = costPerHour > 5 ? 'var(--coral)' : costPerHour > 1 ? 'var(--gold)' : 'var(--green)';
    rateEl.textContent = `$${costPerHour.toFixed(2)}/hr`;
    rateEl.style.color = rateColor;
  }
}

// ── WebSocket ─────────────────────────────────────────────────

const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProto}//${location.host}/ws`;
const ws = new WSClient(wsUrl, store, scheduleRender);

// ── Task submission ───────────────────────────────────────────

function setupTaskInput() {
  const input = document.getElementById('task-input');
  const btn = document.getElementById('task-submit');
  if (!input || !btn) return;

  const submit = () => {
    const desc = input.value.trim();
    if (!desc) return;
    ws.submitTask(desc);
    input.value = '';
    // Optimistic UI feedback
    input.placeholder = 'Task submitted! Enter another...';
    setTimeout(() => { input.placeholder = 'Submit a task...'; }, 2000);
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  // Initialize event panel scroll tracking
  initEvents();

  // Setup task input
  setupTaskInput();

  // Close button for last-response panel
  const closeBtn = document.getElementById('last-response-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const panel = document.getElementById('last-response');
      if (panel) panel.style.display = 'none';
    });
  }

  // Initialize overlay system, widgets, anomaly, keyboard
  initOverlays(store);
  initWidgets(store);
  initAnomalyPulse(store);
  initKeyboard();

  // Fetch initial state via REST
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const state = await res.json();
      store.setFullState(state);
      renderAll();
      lastRenderVersion = store.getVersion();
    }
  } catch (err) {
    console.warn('Failed to fetch initial state:', err);
  }

  // Connect WebSocket for real-time updates
  ws.connect();

  // Lightweight timer for uptime/cost — does NOT trigger full re-render
  setInterval(renderTimers, 1000);
}

init();
