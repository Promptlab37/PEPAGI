// PEPAGI Web Dashboard — Cost Panel (TUI spec: 100%)

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n || 0);
}

/** Linear regression on cost history for trend detection */
function linearRegression(data) {
  const n = data.length;
  if (n < 3) return { slope: 0, trend: 'stable', r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += data[i]; sumXY += i * data[i]; sumX2 += i * i; sumY2 += data[i] * data[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, trend: 'stable', r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const ssRes = data.reduce((s, y, i) => { const yhat = (sumY / n) + slope * (i - sumX / n); return s + (y - yhat) ** 2; }, 0);
  const ssTot = data.reduce((s, y) => s + (y - sumY / n) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const trend = slope > 0.001 ? 'rising' : slope < -0.001 ? 'falling' : 'stable';
  return { slope, trend, r2 };
}

export function renderCost(state) {
  const stats = document.getElementById('cost-stats');
  const chart = document.getElementById('cost-chart');
  if (!stats) return;

  const cost = state.sessionCost || 0;
  const tokIn = state.sessionTokensIn || 0;
  const tokOut = state.sessionTokensOut || 0;

  // Rate estimation
  const elapsed = (Date.now() - (state.startTime || Date.now())) / 1000;
  const costPerHour = elapsed > 60 ? (cost / elapsed * 3600) : 0;
  const rateColor = costPerHour > 5 ? 'var(--coral)' : costPerHour > 1 ? 'var(--gold)' : 'var(--green)';

  // Monthly projection
  const monthlyProjection = costPerHour * 24 * 30;

  // Per-agent cost breakdown
  const agents = Object.values(state.agents || {});
  const totalAgentCost = agents.reduce((sum, a) => sum + (a.costTotal || 0), 0);
  const agentBreakdown = agents
    .filter(a => a.costTotal > 0)
    .sort((a, b) => b.costTotal - a.costTotal)
    .map(a => {
      const pct = totalAgentCost > 0 ? ((a.costTotal / totalAgentCost) * 100).toFixed(0) : 0;
      const color = AGENT_COLORS[a.provider] || 'var(--text)';
      return `<div class="cost-agent-row">
        <span class="cost-agent-name" style="color:${color}">${a.provider}</span>
        <span class="cost-agent-bar-wrap">
          <span class="cost-agent-bar" style="width:${pct}%;background:${color}"></span>
        </span>
        <span class="cost-agent-val">$${a.costTotal.toFixed(3)} (${pct}%)</span>
      </div>`;
    }).join('');

  // Budget progress (per-session limit — from security config defaults)
  const sessionLimit = 10.0;
  const budgetPct = Math.min((cost / sessionLimit) * 100, 100);
  const budgetColor = budgetPct > 80 ? 'var(--coral)' : budgetPct > 50 ? 'var(--gold)' : 'var(--green)';
  const timeToLimit = costPerHour > 0 ? ((sessionLimit - cost) / costPerHour) : Infinity;
  const timeToLimitStr = timeToLimit === Infinity ? '\u221e' :
    timeToLimit < 1 ? `${Math.round(timeToLimit * 60)}m` : `${timeToLimit.toFixed(1)}h`;

  // Linear regression trend
  const costData = state.costHistory || [];
  const lr = linearRegression(costData);
  const trendIcon = lr.trend === 'rising' ? '\u2197' : lr.trend === 'falling' ? '\u2198' : '\u2192';
  const trendColor = lr.trend === 'rising' ? 'var(--coral)' : lr.trend === 'falling' ? 'var(--green)' : 'var(--dim)';

  stats.innerHTML = `
    <div class="cost-stat">
      <div class="cost-stat-label">Session Cost</div>
      <div class="cost-stat-value" style="color:var(--gold)">$${cost.toFixed(3)}</div>
    </div>
    <div class="cost-stat">
      <div class="cost-stat-label">Rate</div>
      <div class="cost-stat-value" style="color:${rateColor}">$${costPerHour.toFixed(2)}/hr</div>
    </div>
    <div class="cost-stat">
      <div class="cost-stat-label">Monthly est.</div>
      <div class="cost-stat-value" style="color:var(--dim)">\u2248$${monthlyProjection.toFixed(2)}/mo</div>
    </div>
    <div class="cost-stat">
      <div class="cost-stat-label">Trend</div>
      <div class="cost-stat-value" style="color:${trendColor}">${trendIcon} ${lr.trend} <span style="font-size:0.6rem;color:var(--dim)">R\u00b2=${lr.r2.toFixed(2)}</span></div>
    </div>
    <div class="cost-stat">
      <div class="cost-stat-label">Tokens</div>
      <div class="cost-stat-value" style="color:var(--blue)">\u2191${fmtTokens(tokIn)} \u2193${fmtTokens(tokOut)}</div>
    </div>
  `;

  // Budget bar
  stats.innerHTML += `<div class="cost-budget" style="grid-column:1/-1;margin-top:6px">
    <div class="cost-budget-header">
      <span class="cost-stat-label">Budget</span>
      <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--dim)">ETA: ${timeToLimitStr}</span>
    </div>
    <div class="cost-budget-track">
      <div class="cost-budget-fill" style="width:${budgetPct}%;background:${budgetColor}"></div>
    </div>
    <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--dim);text-align:right">$${cost.toFixed(2)} / $${sessionLimit.toFixed(2)}</div>
  </div>`;

  // Per-agent breakdown
  if (agentBreakdown) {
    stats.innerHTML += `<div class="cost-agent-breakdown" style="grid-column:1/-1;margin-top:8px">
      <div class="cost-stat-label" style="margin-bottom:4px">Per-Agent</div>
      ${agentBreakdown || '<span style="color:var(--dim);font-size:0.75rem">No agent costs yet</span>'}
    </div>`;
  }

  // Cost chart (SVG polyline)
  if (chart) {
    const data = state.costHistory || [];
    if (data.length < 2) {
      chart.innerHTML = '<text x="200" y="50" text-anchor="middle" fill="#666677" font-size="12" font-family="var(--font-sans)">Waiting for data...</text>';
      return;
    }
    const max = Math.max(...data, 0.001);
    const w = 400, h = 100;
    const points = data.map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * (h - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const areaPoints = `0,${h} ${points} ${w},${h}`;
    chart.innerHTML = `
      <defs>
        <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <polygon points="${areaPoints}" fill="url(#costGrad)"/>
      <polyline points="${points}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round"/>
    `;
  }
}

const AGENT_COLORS = {
  claude: 'var(--cyan)', gpt: 'var(--green)', gemini: 'var(--blue)',
  ollama: 'var(--purple)', lmstudio: 'var(--gold)',
};
