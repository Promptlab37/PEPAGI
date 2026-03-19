// PEPAGI Web Dashboard — Memory Panel

function sparklineSVG(data, color, width, height) {
  if (!data || data.length < 2) return '';
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

export function renderMemory(state) {
  const grid = document.getElementById('memory-grid');
  if (!grid) return;

  const m = state.memoryStats || {};
  const h = state.memoryLevelHistory || {};

  const cards = [
    { label: 'Episodes', value: m.episodes || 0, color: 'var(--cyan)', data: h.l2 },
    { label: 'Facts', value: m.facts || 0, color: 'var(--blue)', data: h.l3, sub: m.decayedFacts ? `(${m.decayedFacts} decayed)` : '' },
    { label: 'Procedures', value: m.procedures || 0, color: 'var(--green)', data: h.l4 },
    { label: 'Skills', value: m.skills || 0, color: 'var(--purple)', data: h.l5 },
  ];

  grid.innerHTML = cards.map(c => `
    <div class="memory-card">
      <div class="memory-card-label">${c.label}</div>
      <div class="memory-card-value" style="color:${c.color}">${c.value}${c.sub ? ` <span style="font-size:0.7rem;color:var(--dim)">${c.sub}</span>` : ''}</div>
      <div class="memory-sparkline">${sparklineSVG(c.data, c.color, 160, 24)}</div>
    </div>
  `).join('');

  // Add working + vectors as small stats
  if (m.working || m.vectors) {
    grid.innerHTML += `
      <div class="memory-card" style="grid-column: 1/-1; display:flex; gap:24px; padding:8px 12px">
        <span style="font-size:0.75rem;color:var(--text-secondary)">Working: <span style="color:var(--text);font-family:var(--font-mono)">${m.working || 0}</span></span>
        <span style="font-size:0.75rem;color:var(--text-secondary)">Vectors: <span style="color:var(--text);font-family:var(--font-mono)">${m.vectors || 0}</span></span>
      </div>`;
  }
}
