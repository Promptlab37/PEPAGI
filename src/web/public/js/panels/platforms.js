// PEPAGI Web Dashboard — Platforms Panel

const PLATFORM_ICONS = {
  telegram: '\ud83d\udcf1',
  whatsapp: '\ud83d\udcac',
  discord:  '\ud83c\udfae',
};

export function renderPlatforms(state) {
  const grid = document.getElementById('platforms-grid');
  if (!grid) return;

  const platforms = state.platforms || {};
  const names = ['telegram', 'whatsapp', 'discord'];

  grid.innerHTML = names.map(name => {
    const p = platforms[name] || { enabled: false, connected: false, messageCount: 0 };
    const icon = PLATFORM_ICONS[name] || '';
    const dotClass = p.connected ? 'dot-online' : p.enabled ? 'dot-offline' : '';
    const status = p.connected ? 'Connected' : p.enabled ? 'Disconnected' : 'Disabled';
    const statusColor = p.connected ? 'var(--green)' : p.enabled ? 'var(--coral)' : 'var(--dim)';

    return `<div class="platform-card">
      <div class="platform-name">
        <span>${icon}</span>
        <span>${name.charAt(0).toUpperCase() + name.slice(1)}</span>
        ${dotClass ? `<span class="dot ${dotClass}"></span>` : ''}
      </div>
      <div class="platform-stat" style="color:${statusColor}">${status}</div>
      ${p.enabled ? `<div class="platform-stat">${p.messageCount} messages</div>` : ''}
    </div>`;
  }).join('');
}
