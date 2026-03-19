// PEPAGI Web Dashboard — Thought Process Panel (dedicated)
// Shows mediator thinking, agent progress, tool calls in real-time

const THOUGHT_CATEGORIES = {
  analyzing:   { color: 'var(--blue)',   icon: '\u25B6' },  // Analyzing task
  routing:     { color: 'var(--purple)', icon: '\u25C6' },  // Difficulty routing
  assigning:   { color: 'var(--cyan)',   icon: '\u25B8' },  // Agent assignment
  agent:       { color: 'var(--green)',  icon: '\u25CF' },  // Agent working
  tool:        { color: 'var(--gold)',   icon: '\u2726' },  // Tool call
  decision:    { color: 'var(--cyan)',   icon: '\u25A0' },  // Decision made
  error:       { color: 'var(--coral)',  icon: '\u2716' },  // Error/failure
  done:        { color: 'var(--green)',  icon: '\u2714' },  // Completed
  info:        { color: 'var(--dim)',    icon: '\u00B7' },  // General
};

function categorize(text) {
  const t = text.toLowerCase();
  // Agent stream-json events (tool calls, agent text, tool results)
  if (t.startsWith('\u{1F527}') || t.startsWith('🔧')) return 'tool';         // 🔧 Read: /path...
  if (t.startsWith('\u{1F4CB}') || t.startsWith('📋')) return 'agent';        // 📋 result: ...
  if (t.startsWith('\u{1F4AD}') || t.startsWith('💭')) return 'agent';        // 💭 agent thinking text
  if (t.includes('analyzing') || t.includes('retrieving') || t.includes('memory context')) return 'analyzing';
  if (t.includes('difficulty') || t.includes('routing') || t.includes('simulating') || t.includes('worldmodel') || t.includes('planner')) return 'routing';
  if (t.includes('assigning to') || t.includes('worker starting')) return 'assigning';
  if (t.includes('agent') || t.includes('worker') || t.includes('cli') || t.includes('turn ')) return 'agent';
  if (t.includes('tool:') || t.includes('tool call')) return 'tool';
  if (t.includes('decision:') || t.includes('loop ')) return 'decision';
  if (t.includes('fail') || t.includes('error') || t.includes('exhaust') || t.includes('timeout')) return 'error';
  if (t.includes('completed') || t.includes('done') || t.includes('finished')) return 'done';
  return 'info';
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Track previous monologue length to detect new items
let lastMonologueLen = 0;

export function renderThoughts(state) {
  const feed = document.getElementById('thoughts-feed');
  const empty = document.getElementById('thoughts-empty');
  const countEl = document.getElementById('thoughts-count');
  if (!feed) return;

  const thoughts = state.innerMonologue || [];

  if (thoughts.length === 0) {
    feed.innerHTML = '';
    if (empty) empty.style.display = '';
    if (countEl) countEl.textContent = '';
    lastMonologueLen = 0;
    return;
  }
  if (empty) empty.style.display = 'none';
  if (countEl) countEl.textContent = `${thoughts.length} thoughts`;

  // Show all thoughts, newest first (max 30)
  const display = thoughts.slice(-30).reverse();

  feed.innerHTML = display.map((t, idx) => {
    const cat = categorize(t);
    const style = THOUGHT_CATEGORIES[cat] || THOUGHT_CATEGORIES.info;
    const isNew = idx === 0 && thoughts.length > lastMonologueLen;
    return `<div class="thought-line${isNew ? ' thought-new' : ''}" style="border-left-color:${style.color}">
      <span class="thought-icon" style="color:${style.color}">${style.icon}</span>
      <span class="thought-text">${escapeHtml(t)}</span>
    </div>`;
  }).join('');

  lastMonologueLen = thoughts.length;
}
