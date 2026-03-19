// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — Client State Store
// ═══════════════════════════════════════════════════════════════

export class StateStore {
  constructor() {
    this.data = this._defaultState();
    /** @type {Array} Events received since last full state sync */
    this._pendingEvents = [];
    /** @type {number} Incremented on every state mutation — used by app.js to skip redundant renders */
    this._version = 0;
  }

  _defaultState() {
    return {
      startTime: Date.now(),
      sessionCost: 0,
      sessionTokensIn: 0,
      sessionTokensOut: 0,
      costHistory: [],
      costPerMinute: [],
      activeTasks: {},
      completedTasks: [],
      totalCompleted: 0,
      totalFailed: 0,
      agents: {},
      qualiaHistory: {},
      currentQualia: {},
      consciousnessProfile: 'STANDARD',
      innerMonologue: [],
      introspectionHistory: [],
      eventLog: [],
      securityEvents: [],
      threatScore: 0,
      anomalies: [],
      decisions: [],
      platforms: {
        telegram: { enabled: false, connected: false, messageCount: 0 },
        whatsapp: { enabled: false, connected: false, messageCount: 0 },
        discord:  { enabled: false, connected: false, messageCount: 0 },
      },
      memoryStats: { episodes: 0, facts: 0, procedures: 0, skills: 0, working: 0, decayedFacts: 0, vectors: 0, lastLoaded: 0 },
      memoryLevelHistory: { l2: [], l3: [], l4: [], l5: [] },
      watchdogLastPing: 0,
    };
  }

  /** Replace entire state (from init/state WS messages). */
  setFullState(state) {
    this.data = state;
    this._version++;
    // Merge any pending events that arrived between state snapshots
    for (const evt of this._pendingEvents) {
      this._appendEvent(evt);
    }
    this._pendingEvents = [];
  }

  /** Apply a single event (from event WS messages). */
  applyEvent(event) {
    this._appendEvent(event);
    this._version++;
    this._pendingEvents.push(event);
    // Keep pending buffer small — state sync every 500ms will clear it
    if (this._pendingEvents.length > 100) {
      this._pendingEvents = this._pendingEvents.slice(-50);
    }
  }

  _appendEvent(event) {
    if (!this.data.eventLog) this.data.eventLog = [];
    // Avoid duplicate events (same ts + message)
    const last = this.data.eventLog[this.data.eventLog.length - 1];
    if (last && last.ts === event.ts && last.message === event.description) return;
    const entry = {
      ts: event.ts,
      level: event.level,
      source: event.source,
      message: event.description,
    };
    if (event.details) entry.detail = event.details;
    if (event.qualiaDeltas) entry.qualiaDeltas = event.qualiaDeltas;
    this.data.eventLog.push(entry);
    if (this.data.eventLog.length > 500) {
      this.data.eventLog = this.data.eventLog.slice(-500);
    }
  }

  get(key) { return this.data[key]; }
  getAll() { return this.data; }
  getVersion() { return this._version; }
}
