// ═══════════════════════════════════════════════════════════════
// PEPAGI Settings Page — JavaScript
// ═══════════════════════════════════════════════════════════════

const HIDDEN = '[HIDDEN]';
let currentConfig = null;

const AGENT_PROVIDERS = ['claude', 'gpt', 'gemini', 'ollama'];
const AGENT_COLORS = {
  claude: 'var(--cyan)', gpt: 'var(--green)', gemini: 'var(--blue)', ollama: 'var(--purple)',
};
const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-6', gpt: 'gpt-4o', gemini: 'gemini-2.0-flash', ollama: 'ollama/llama3.2',
};

const PLATFORM_NAMES = ['telegram', 'whatsapp', 'discord', 'imessage'];
const PLATFORM_ICONS = { telegram: '\ud83d\udcf1', whatsapp: '\ud83d\udcac', discord: '\ud83c\udfae', imessage: '\ud83d\udcac' };

const APPROVAL_ACTIONS = [
  'file_delete', 'file_write_system', 'network_external',
  'shell_destructive', 'git_push', 'docker_manage',
];

// ── Tab switching ────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Status messages ──────────────────────────────────────────

function showStatus(msg, type) {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  bar.textContent = msg;
  bar.className = 'status-bar ' + type;
  bar.style.display = '';
  if (type !== 'loading') {
    setTimeout(() => { bar.style.display = 'none'; }, 4000);
  }
}

// ── Load config ──────────────────────────────────────────────

async function loadConfig() {
  showStatus('Loading configuration...', 'loading');
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(await res.text());
    currentConfig = await res.json();
    renderConfig(currentConfig);
    document.getElementById('status-bar').style.display = 'none';
  } catch (err) {
    showStatus('Failed to load config: ' + err.message, 'error');
  }
}

// ── Render config into forms ─────────────────────────────────

function renderConfig(c) {
  // General
  setVal('managerProvider', c.managerProvider || 'claude');
  setVal('managerModel', c.managerModel || '');

  // Profile
  const p = c.profile || {};
  setVal('profileUserName', p.userName || '');
  setVal('profileAssistantName', p.assistantName || 'PEPAGI');
  setVal('profileLanguage', p.language || 'cs');
  setVal('profileCommunicationStyle', p.communicationStyle || 'human');
  setChecked('profileSubscriptionMode', p.subscriptionMode || false);
  setChecked('profileGptSubscriptionMode', p.gptSubscriptionMode || false);

  // Agents
  renderAgents(c.agents || {});

  // Platforms
  renderPlatforms(c.platforms || {});

  // Security
  const sec = c.security || {};
  setVal('secMaxCostPerTask', sec.maxCostPerTask ?? 1.0);
  setVal('secMaxCostPerSession', sec.maxCostPerSession ?? 10.0);
  setVal('secBlockedCommands', (sec.blockedCommands || []).join('\n'));
  renderApprovalCheckboxes(sec.requireApproval || []);

  // Queue
  const q = c.queue || {};
  setVal('queueMaxConcurrent', q.maxConcurrentTasks ?? 4);
  setVal('queueTimeout', q.taskTimeoutMs ?? 120000);

  // Consciousness
  const con = c.consciousness || {};
  setVal('consciousnessProfile', con.profile || 'STANDARD');
  setChecked('consciousnessEnabled', con.enabled !== false);
}

function renderAgents(agents) {
  const grid = document.getElementById('agents-config');
  if (!grid) return;

  grid.innerHTML = AGENT_PROVIDERS.map(prov => {
    const a = agents[prov] || {};
    const color = AGENT_COLORS[prov] || 'var(--text)';
    const hasKey = a.apiKey === HIDDEN;
    const keyPlaceholder = hasKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (set)' : 'Enter API key...';

    return `<div class="agent-config-card" style="border-top:3px solid ${color}">
      <div class="agent-config-header">
        <span class="agent-config-name" style="color:${color}">${prov}</span>
        <label class="toggle">
          <input type="checkbox" data-agent="${prov}" data-field="enabled" ${a.enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="form-grid" style="gap:10px">
        <div class="form-group full-width">
          <label>API Key</label>
          <div class="apikey-group">
            <input type="password" class="form-input" data-agent="${prov}" data-field="apiKey"
              placeholder="${keyPlaceholder}" value="">
            <button type="button" class="btn-test" data-test-agent="${prov}">Test</button>
          </div>
        </div>
        <div class="form-group">
          <label>Model</label>
          <input type="text" class="form-input" data-agent="${prov}" data-field="model"
            value="${escapeAttr(a.model || DEFAULT_MODELS[prov] || '')}" placeholder="${DEFAULT_MODELS[prov] || ''}">
        </div>
        <div class="form-group">
          <label>Temperature</label>
          <div class="range-group">
            <input type="range" class="form-range" data-agent="${prov}" data-field="temperature"
              min="0" max="2" step="0.1" value="${a.temperature ?? 0.3}">
            <span class="range-value" data-temp-display="${prov}">${(a.temperature ?? 0.3).toFixed(1)}</span>
          </div>
        </div>
        <div class="form-group">
          <label>Max Output Tokens</label>
          <input type="number" class="form-input" data-agent="${prov}" data-field="maxOutputTokens"
            value="${a.maxOutputTokens ?? 4096}" min="100" max="128000">
        </div>
      </div>
    </div>`;
  }).join('');

  // Wire temperature range displays
  grid.querySelectorAll('.form-range[data-field="temperature"]').forEach(range => {
    const prov = range.dataset.agent;
    range.addEventListener('input', () => {
      const display = grid.querySelector(`[data-temp-display="${prov}"]`);
      if (display) display.textContent = parseFloat(range.value).toFixed(1);
    });
  });

  // Wire test buttons
  grid.querySelectorAll('.btn-test').forEach(btn => {
    btn.addEventListener('click', () => testAgent(btn.dataset.testAgent, btn));
  });
}

function renderPlatforms(platforms) {
  const grid = document.getElementById('platforms-config');
  if (!grid) return;

  const cards = [];

  // Telegram
  const tg = platforms.telegram || {};
  cards.push(platformCard('telegram', tg, [
    { field: 'botToken', label: 'Bot Token', type: 'password', placeholder: tg.botToken === HIDDEN ? '\u2022\u2022\u2022\u2022\u2022\u2022 (set)' : 'Enter bot token...' },
    { field: 'allowedUserIds', label: 'Allowed User IDs', type: 'text', value: (tg.allowedUserIds || []).join(', '), placeholder: '123456789, 987654321' },
    { field: 'welcomeMessage', label: 'Welcome Message', type: 'textarea', value: tg.welcomeMessage || '' },
  ]));

  // WhatsApp
  const wa = platforms.whatsapp || {};
  cards.push(platformCard('whatsapp', wa, [
    { field: 'allowedNumbers', label: 'Allowed Numbers', type: 'text', value: (wa.allowedNumbers || []).join(', '), placeholder: '+420123456789' },
    { field: 'sessionPath', label: 'Session Path', type: 'text', value: wa.sessionPath || '' },
    { field: 'welcomeMessage', label: 'Welcome Message', type: 'textarea', value: wa.welcomeMessage || '' },
  ]));

  // Discord
  const dc = platforms.discord || {};
  cards.push(platformCard('discord', dc, [
    { field: 'botToken', label: 'Bot Token', type: 'password', placeholder: dc.botToken === HIDDEN ? '\u2022\u2022\u2022\u2022\u2022\u2022 (set)' : 'Enter bot token...' },
    { field: 'allowedUserIds', label: 'Allowed User IDs', type: 'text', value: (dc.allowedUserIds || []).join(', '), placeholder: 'user-id-1, user-id-2' },
    { field: 'allowedChannelIds', label: 'Allowed Channel IDs', type: 'text', value: (dc.allowedChannelIds || []).join(', '), placeholder: 'channel-id-1' },
    { field: 'commandPrefix', label: 'Command Prefix', type: 'text', value: dc.commandPrefix || '!' },
    { field: 'welcomeMessage', label: 'Welcome Message', type: 'textarea', value: dc.welcomeMessage || '' },
  ]));

  // iMessage
  const im = platforms.imessage || {};
  cards.push(platformCard('imessage', im, [
    { field: 'allowedNumbers', label: 'Allowed Numbers', type: 'text', value: (im.allowedNumbers || []).join(', '), placeholder: '+420123456789' },
  ]));

  grid.innerHTML = cards.join('');
}

function platformCard(name, data, fields) {
  const icon = PLATFORM_ICONS[name] || '';
  const fieldsHtml = fields.map(f => {
    if (f.type === 'textarea') {
      return `<div class="form-group full-width">
        <label>${f.label}</label>
        <textarea class="form-textarea" data-platform="${name}" data-field="${f.field}" rows="2">${escapeHtml(f.value || '')}</textarea>
      </div>`;
    }
    const inputType = f.type === 'password' ? 'password' : 'text';
    return `<div class="form-group">
      <label>${f.label}</label>
      <input type="${inputType}" class="form-input" data-platform="${name}" data-field="${f.field}"
        value="${escapeAttr(f.value || '')}" placeholder="${f.placeholder || ''}">
    </div>`;
  }).join('');

  return `<div class="platform-config-card">
    <div class="platform-config-header">
      <span class="platform-config-name">${icon} ${name}</span>
      <label class="toggle">
        <input type="checkbox" data-platform="${name}" data-field="enabled" ${data.enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="form-grid" style="gap:10px">
      ${fieldsHtml}
    </div>
  </div>`;
}

function renderApprovalCheckboxes(selected) {
  const container = document.getElementById('secApprovalCheckboxes');
  if (!container) return;
  container.innerHTML = APPROVAL_ACTIONS.map(action => {
    const checked = selected.includes(action) ? 'checked' : '';
    const label = action.replace(/_/g, ' ');
    return `<label class="checkbox-item">
      <input type="checkbox" data-approval="${action}" ${checked}>
      ${label}
    </label>`;
  }).join('');
}

// ── Collect form values ──────────────────────────────────────

function collectConfig() {
  const config = {};

  // General
  config.managerProvider = getVal('managerProvider');
  config.managerModel = getVal('managerModel');

  // Profile
  config.profile = {
    userName: getVal('profileUserName'),
    assistantName: getVal('profileAssistantName'),
    language: getVal('profileLanguage'),
    communicationStyle: getVal('profileCommunicationStyle'),
    subscriptionMode: getChecked('profileSubscriptionMode'),
    gptSubscriptionMode: getChecked('profileGptSubscriptionMode'),
  };

  // Agents
  config.agents = {};
  for (const prov of AGENT_PROVIDERS) {
    config.agents[prov] = {};
    const fields = document.querySelectorAll(`[data-agent="${prov}"]`);
    for (const el of fields) {
      const field = el.dataset.field;
      if (field === 'enabled') {
        config.agents[prov][field] = el.checked;
      } else if (field === 'apiKey') {
        // Only send if user typed something new
        const val = el.value.trim();
        config.agents[prov][field] = val || HIDDEN; // HIDDEN = keep existing
      } else if (field === 'temperature') {
        config.agents[prov][field] = parseFloat(el.value);
      } else if (field === 'maxOutputTokens') {
        config.agents[prov][field] = parseInt(el.value, 10);
      } else {
        config.agents[prov][field] = el.value;
      }
    }
  }

  // Platforms
  config.platforms = {};
  for (const name of PLATFORM_NAMES) {
    config.platforms[name] = {};
    const fields = document.querySelectorAll(`[data-platform="${name}"]`);
    for (const el of fields) {
      const field = el.dataset.field;
      if (field === 'enabled') {
        config.platforms[name][field] = el.checked;
      } else if (field === 'botToken') {
        const val = el.value.trim();
        config.platforms[name][field] = val || HIDDEN;
      } else if (field === 'allowedUserIds') {
        const val = el.value.trim();
        if (name === 'telegram') {
          config.platforms[name][field] = val ? val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)) : [];
        } else {
          config.platforms[name][field] = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
        }
      } else if (field === 'allowedNumbers' || field === 'allowedChannelIds') {
        const val = el.value.trim();
        config.platforms[name][field] = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
      } else {
        config.platforms[name][field] = el.value;
      }
    }
  }

  // Security
  config.security = {
    maxCostPerTask: parseFloat(getVal('secMaxCostPerTask')) || 1.0,
    maxCostPerSession: parseFloat(getVal('secMaxCostPerSession')) || 10.0,
    blockedCommands: getVal('secBlockedCommands').split('\n').map(s => s.trim()).filter(Boolean),
    requireApproval: [...document.querySelectorAll('[data-approval]:checked')].map(el => el.dataset.approval),
  };

  // Queue
  config.queue = {
    maxConcurrentTasks: parseInt(getVal('queueMaxConcurrent'), 10) || 4,
    taskTimeoutMs: parseInt(getVal('queueTimeout'), 10) || 120000,
  };

  // Consciousness
  config.consciousness = {
    profile: getVal('consciousnessProfile'),
    enabled: getChecked('consciousnessEnabled'),
  };

  return config;
}

// ── Save config ──────────────────────────────────────────────

async function saveConfig() {
  const config = collectConfig();
  const btn = document.getElementById('save-btn');
  if (btn) btn.disabled = true;
  showStatus('Saving...', 'loading');

  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const result = await res.json();
    if (res.ok && result.success) {
      showStatus('Configuration saved successfully!', 'success');
      // Reload to get updated (scrubbed) values
      await loadConfig();
    } else {
      showStatus('Failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showStatus('Save failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Test agent connectivity ──────────────────────────────────

async function testAgent(provider, btn) {
  btn.className = 'btn-test testing';
  btn.textContent = 'Testing...';

  const keyInput = document.querySelector(`input[data-agent="${provider}"][data-field="apiKey"]`);
  const modelInput = document.querySelector(`input[data-agent="${provider}"][data-field="model"]`);

  const body = { provider };
  if (keyInput && keyInput.value.trim()) {
    body.apiKey = keyInput.value.trim();
  }
  if (modelInput && modelInput.value.trim()) {
    body.model = modelInput.value.trim();
  }

  try {
    const res = await fetch('/api/config/test-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.success) {
      btn.className = 'btn-test success';
      btn.textContent = `OK (${result.latencyMs}ms)`;
    } else {
      btn.className = 'btn-test failed';
      btn.textContent = 'Failed';
      showStatus(result.message, 'error');
    }
  } catch (err) {
    btn.className = 'btn-test failed';
    btn.textContent = 'Error';
    showStatus('Test failed: ' + err.message, 'error');
  }

  // Reset after 3s
  setTimeout(() => {
    btn.className = 'btn-test';
    btn.textContent = 'Test';
  }, 3000);
}

// ── Helpers ──────────────────────────────────────────────────

function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; }
function setChecked(id, v) { const el = document.getElementById(id); if (el) el.checked = v; }

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ─────────────────────────────────────────────────────

function init() {
  setupTabs();

  document.getElementById('save-btn')?.addEventListener('click', saveConfig);

  loadConfig();
}

init();
