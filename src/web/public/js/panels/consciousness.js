// PEPAGI Web Dashboard — Consciousness Panel (TUI spec: 100%)

const QUALIA_COLORS = {
  frustration: 'var(--coral)', confidence: 'var(--cyan)', curiosity: 'var(--green)',
  autonomy: 'var(--gold)', coherence: 'var(--blue)', resourcefulness: 'var(--purple)',
  clarity: 'var(--cyan)', momentum: '#7dd3fc', synthesis: '#c084fc',
  surprise: '#fbbf24', uncertainty: '#fb923c',
  pleasure: 'var(--green)', arousal: 'var(--gold)', dominance: 'var(--blue)',
  satisfaction: 'var(--green)', selfCoherence: 'var(--blue)',
  existentialComfort: 'var(--cyan)', purposeAlignment: 'var(--green)',
};

const QUALIA_ORDER = [
  'frustration', 'confidence', 'curiosity', 'autonomy', 'coherence',
  'resourcefulness', 'clarity', 'momentum', 'synthesis', 'surprise', 'uncertainty',
  'pleasure', 'arousal', 'dominance', 'satisfaction', 'selfCoherence',
  'existentialComfort', 'purposeAlignment',
];

const MONOLOGUE_CATEGORIES = {
  planning: 'var(--blue)',
  reflection: 'var(--purple)',
  uncertainty: 'var(--gold)',
  error: 'var(--coral)',
  success: 'var(--green)',
  questioning: 'var(--cyan)',
};

function formatLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').toLowerCase();
}

/** Guess monologue category from content */
function guessCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('plan') || t.includes('strateg') || t.includes('decompos')) return 'planning';
  if (t.includes('reflect') || t.includes('learn') || t.includes('improv')) return 'reflection';
  if (t.includes('unsure') || t.includes('uncertain') || t.includes('nejist')) return 'uncertainty';
  if (t.includes('error') || t.includes('fail') || t.includes('chyb')) return 'error';
  if (t.includes('success') || t.includes('done') || t.includes('hotov') || t.includes('spln')) return 'success';
  if (t.includes('?') || t.includes('why') || t.includes('how') || t.includes('proč') || t.includes('jak')) return 'questioning';
  return null;
}

/** Block char bar: ░▒▓█ */
function blockBar(val, width) {
  const filled = Math.round(val * width);
  const full = Math.floor(filled);
  const frac = filled - full;
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i < full) bar += '\u2588';
    else if (i === full && frac >= 0.75) bar += '\u2593';
    else if (i === full && frac >= 0.5) bar += '\u2592';
    else if (i === full && frac >= 0.25) bar += '\u2591';
    else bar += '\u2591';
  }
  return bar;
}

let breachFlash = false;
let breachTimer = null;

export function renderConsciousness(state) {
  const barsEl = document.getElementById('qualia-bars');
  const feed = document.getElementById('monologue-feed');
  const emoji = document.getElementById('qualia-emoji');
  const panel = document.getElementById('panel-consciousness');
  if (!barsEl) return;

  const qualia = state.currentQualia || {};

  // Breach detection: confidence < 0.3 || frustration > 0.8
  const conf = qualia.confidence || 0;
  const frust = qualia.frustration || 0;
  const isBreach = conf < 0.3 && conf > 0 || frust > 0.8;

  if (panel) {
    if (isBreach) {
      if (!breachTimer) {
        breachTimer = setInterval(() => {
          breachFlash = !breachFlash;
          panel.classList.toggle('breach-flash', breachFlash);
        }, 600);
      }
    } else {
      if (breachTimer) {
        clearInterval(breachTimer);
        breachTimer = null;
        breachFlash = false;
        panel.classList.remove('breach-flash');
      }
    }
  }

  // Filter to only show qualia that have values
  const activeQualia = QUALIA_ORDER.filter(key => qualia[key] !== undefined && qualia[key] !== 0);
  const displayQualia = activeQualia.length > 0 ? activeQualia : QUALIA_ORDER.slice(0, 11);

  // Qualia bars with block characters
  barsEl.innerHTML = displayQualia.map(key => {
    const val = qualia[key] || 0;
    const pct = Math.round(val * 100);
    const color = QUALIA_COLORS[key] || 'var(--dim)';
    const blocks = blockBar(val, 10);
    return `<div class="qualia-row">
      <span class="qualia-label">${formatLabel(key)}</span>
      <span class="qualia-track">
        <span class="qualia-fill" style="width:${pct}%;background:${color}"></span>
      </span>
      <span class="qualia-blocks" style="color:${color}">${blocks}</span>
      <span class="qualia-value">${pct}%</span>
    </div>`;
  }).join('');

  // Learning multiplier bar
  const curiosity = qualia.curiosity || 0;
  const frustration = qualia.frustration || 0;
  const mult = 1.0 + curiosity * 0.6 + frustration * 0.4;
  const multPct = Math.min(((mult - 1.0) / 1.0) * 100, 100); // 1.0-2.0 scale
  const multColor = mult >= 1.6 ? 'var(--green)' : mult >= 1.2 ? 'var(--gold)' : 'var(--dim)';
  barsEl.innerHTML += `<div class="learning-mult-row">
    <span class="qualia-label">Learning\u00d7</span>
    <span class="learning-mult-bar">
      <span class="learning-mult-fill" style="width:${multPct}%;background:${multColor}"></span>
    </span>
    <span class="qualia-value" style="color:${multColor}">${mult.toFixed(2)}\u00d7</span>
  </div>`;

  // Dominant emoji
  const QUALIA_EMOJIS = [
    { key: 'curiosity', emoji: '\ud83d\udd0d', label: 'curious' },
    { key: 'satisfaction', emoji: '\ud83d\ude0a', label: 'satisfied' },
    { key: 'frustration', emoji: '\ud83d\ude24', label: 'frustrated' },
    { key: 'confidence', emoji: '\ud83d\udcaa', label: 'confident' },
    { key: 'clarity', emoji: '\u2728', label: 'clear' },
    { key: 'purposeAlignment', emoji: '\ud83c\udfaf', label: 'aligned' },
  ];
  if (emoji) {
    let best = QUALIA_EMOJIS[0];
    let bestVal = qualia[best.key] || 0;
    for (const c of QUALIA_EMOJIS) {
      const v = qualia[c.key] || 0;
      if (v > bestVal) { best = c; bestVal = v; }
    }
    emoji.textContent = bestVal > 0.1 ? best.emoji : '';
    emoji.title = best.label;
  }

  // Inner monologue moved to dedicated Thought Process panel (panel-thoughts)
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
