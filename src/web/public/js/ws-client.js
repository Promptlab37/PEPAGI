// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — WebSocket Client
// ═══════════════════════════════════════════════════════════════

export class WSClient {
  /**
   * @param {string} url
   * @param {import('./state.js').StateStore} store
   * @param {() => void} onUpdate
   */
  constructor(url, store, onUpdate) {
    this.url = url;
    this.store = store;
    this.onUpdate = onUpdate;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.pingInterval = null;
    this.connected = false;
  }

  connect() {
    this.setStatus('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.setStatus('connected');
      // Start ping every 30s
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this.handleMessage(msg);
      } catch { /* ignore */ }
    };

    this.ws.onclose = () => {
      this.cleanup();
      this.setStatus('disconnected');
      // Reconnect with backoff
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'init':
      case 'state':
        // Full state snapshot — replace everything
        this.store.setFullState(msg.state);
        this.onUpdate();
        break;
      case 'event':
        // Append event to local log for immediate display
        this.store.applyEvent(msg.event);
        this.onUpdate();
        break;
      case 'pong':
        break;
      case 'task_created':
        break;
    }
  }

  /** Submit a task via WebSocket. */
  submitTask(description) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'submit_task', description }));
    }
  }

  setStatus(status) {
    const dot = document.getElementById('ws-status');
    if (!dot) return;
    dot.className = 'ws-dot ws-' + status;
    dot.title = 'WebSocket ' + status;
  }

  cleanup() {
    this.connected = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
