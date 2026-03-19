// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — Global Keyboard Shortcuts
// ═══════════════════════════════════════════════════════════════

import { openOverlay, closeOverlay, isOverlayOpen, refreshOverlay } from './overlays.js';
import { toggleDecisionReplay, toggleThoughtGraph, isWidgetOpen } from './widgets.js';
import { acknowledgeAnomalies } from './anomaly.js';

let eventsPaused = false;

export function initKeyboard() {
  document.addEventListener('keydown', handleKeyDown);
}

function handleKeyDown(e) {
  // Don't capture when typing in inputs
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  // Escape — close overlay or widget
  if (e.key === 'Escape') {
    if (isOverlayOpen()) { closeOverlay(); e.preventDefault(); return; }
    return;
  }

  // F1-F9 — open overlays
  if (e.key >= 'F1' && e.key <= 'F9') {
    e.preventDefault();
    if (isOverlayOpen() && e.key === 'Escape') { closeOverlay(); return; }
    openOverlay(e.key);
    return;
  }

  // Ctrl+R — Decision Replay
  if (e.ctrlKey && e.key === 'r') {
    e.preventDefault();
    toggleDecisionReplay();
    return;
  }

  // Ctrl+G — Thought Graph
  if (e.ctrlKey && e.key === 'g') {
    e.preventDefault();
    toggleThoughtGraph();
    return;
  }

  // If overlay is open, let overlay handle keys
  if (isOverlayOpen()) return;

  // 'a' — acknowledge anomalies
  if (e.key === 'a') {
    acknowledgeAnomalies();
    return;
  }

  // '/' — focus search/task input
  if (e.key === '/') {
    e.preventDefault();
    const input = document.getElementById('task-input');
    if (input) input.focus();
    return;
  }

  // Space — pause event feed
  if (e.key === ' ') {
    e.preventDefault();
    eventsPaused = !eventsPaused;
    const indicator = document.getElementById('pause-indicator');
    if (indicator) {
      indicator.style.display = eventsPaused ? 'inline' : 'none';
    }
    return;
  }
}

export function isEventsPaused() { return eventsPaused; }
