// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Central Dashboard State
// ═══════════════════════════════════════════════════════════════
//
// Mutable singleton passed to all panels/views.
// Event handlers write to it; the redraw timer reads from it.
// No external dependencies — pure data model.

import type { AgentProvider, MediatorDecision, Task } from "../core/types.js";

// ── Sub-types ─────────────────────────────────────────────────

export interface AgentStat {
  provider:        AgentProvider;
  model:           string;
  available:       boolean;
  requestsTotal:   number;
  requestsActive:  number;
  tokensIn:        number;
  tokensOut:       number;
  costTotal:       number;
  latencyMs:       number[];   // rolling last 20
  errorCount:      number;
  lastUsed:        number | null;
  /** Current task title being worked on (null when idle) */
  currentTaskId:   string | null;
  currentTask:     string | null;
  /** Last activity description (tool call, thinking, etc.) */
  lastActivity:    string | null;
  lastActivityTs:  number | null;
  /** Recent activity log (last 8 actions) for expanded agent view */
  recentActions:   Array<{ ts: number; text: string }>;
}

export interface TaskRow {
  id:            string;
  title:         string;
  status:        Task["status"];
  agent:         AgentProvider | null;
  difficulty:    Task["difficulty"];
  confidence:    number;
  cost:          number;
  durationMs:    number | null;
  createdAt:     number;
  assignedAt:    number | null;   // epoch ms when task:assigned fired
  startedAt:     number | null;   // epoch ms when task:started fired
  swarmBranches: number;          // >0 when task triggered swarm mode
  result:        string | null;   // task output summary (answer text)
}

export interface QualiaHistory {
  timestamps:          number[];
  pleasure:            number[];
  arousal:             number[];
  dominance:           number[];
  clarity:             number[];
  curiosity:           number[];
  confidence:          number[];
  frustration:         number[];
  satisfaction:        number[];
  selfCoherence:       number[];
  existentialComfort:  number[];
  purposeAlignment:    number[];
}

export interface LogEntry {
  ts:      number;
  level:   "info" | "warn" | "error" | "debug";
  source:  string;
  message: string;
  detail?: string[];  // optional indented sub-lines for tree display
}

export interface SecurityEvent {
  ts:      number;
  type:    "blocked" | "cost_warning" | "injection" | "tripwire";
  message: string;
  taskId:  string;
}

export interface AnomalyRecord {
  id:           string;
  ts:           number;
  type:         string;
  severity:     "low" | "medium" | "high";
  message:      string;
  acknowledged: boolean;
}

export interface DecisionRecord {
  ts:       number;
  taskId:   string;
  decision: MediatorDecision;
  thought:  string;
}

export interface CostBucket {
  ts:   number;   // minute boundary (floored to minute)
  cost: number;
}

// ── Main state shape ──────────────────────────────────────────

export interface DashboardState {
  // ── System ─────────────────────────────────────────────────
  startTime:       number;
  sessionCost:     number;
  sessionTokensIn: number;
  sessionTokensOut: number;
  costHistory:     number[];        // sparkline, MAX_SPARKLINE_POINTS pts
  costPerMinute:   CostBucket[];    // rolling 60 min

  // ── Tasks ───────────────────────────────────────────────────
  activeTasks:     Map<string, TaskRow>;
  completedTasks:  TaskRow[];       // last 100
  totalCompleted:  number;
  totalFailed:     number;

  // ── Agents ──────────────────────────────────────────────────
  agents: Map<AgentProvider, AgentStat>;

  // ── Consciousness / Qualia ───────────────────────────────────
  qualiaHistory:         QualiaHistory;
  currentQualia:         Record<string, number>;
  consciousnessProfile:  string;
  innerMonologue:        string[];   // last 20 thoughts
  introspectionHistory:  string[];   // last 50

  // ── Event log ───────────────────────────────────────────────
  eventLog: LogEntry[];              // last MAX_LOG_LINES

  // ── Security ────────────────────────────────────────────────
  securityEvents: SecurityEvent[];   // last 100
  threatScore:    number;            // 0-1 EMA

  // ── Anomalies ────────────────────────────────────────────────
  anomalies: AnomalyRecord[];        // last 50

  // ── Decisions (for replay) ───────────────────────────────────
  decisions: DecisionRecord[];       // last 200

  // ── Platforms ────────────────────────────────────────────────
  platforms: {
    telegram: { enabled: boolean; connected: boolean; messageCount: number };
    whatsapp: { enabled: boolean; connected: boolean; messageCount: number; qrCode?: string };
    discord:  { enabled: boolean; connected: boolean; messageCount: number };
  };

  // ── Memory stats (loaded async from ~/.pepagi) ─────────────────
  memoryStats: {
    episodes:     number;
    facts:        number;
    procedures:   number;
    skills:       number;
    working:      number;   // items in working.jsonl
    decayedFacts: number;   // facts with confidence < 0.3
    vectors:      number;   // files in ~/.pepagi/vectors/
    lastLoaded:   number;   // epoch ms, 0 = not yet loaded
  };

  // ── Memory level history (for sparklines) ─────────────────────
  memoryLevelHistory: {
    l2: number[];   // episodes over time
    l3: number[];   // facts over time
    l4: number[];   // procedures+skills over time
    l5: number[];   // skills (meta-level) over time
  };

  // ── Watchdog ─────────────────────────────────────────────────
  watchdogLastPing: number;  // epoch ms, 0 = never pinged

  // ── UI state ─────────────────────────────────────────────────
  activeView:   string | null;   // null = main dashboard, "F1".."F9" = overlay
  focusedPanel: string;          // "neural" | "consciousness" | "pipeline" | "agents" | "cost"
  paused:       boolean;         // freeze display updates
  replayIndex:  number;          // current index in decisions[] for Decision Replay
  searchQuery:  string;          // live search in log telescope
}

// ── Factory ───────────────────────────────────────────────────

export function createInitialState(): DashboardState {
  return {
    startTime:        Date.now(),
    sessionCost:      0,
    sessionTokensIn:  0,
    sessionTokensOut: 0,
    costHistory:      [],
    costPerMinute:    [],

    activeTasks:    new Map(),
    completedTasks: [],
    totalCompleted: 0,
    totalFailed:    0,

    agents: new Map(),

    qualiaHistory: {
      timestamps: [],
      pleasure: [], arousal: [], dominance: [], clarity: [],
      curiosity: [], confidence: [], frustration: [], satisfaction: [],
      selfCoherence: [], existentialComfort: [], purposeAlignment: [],
    },
    currentQualia:        {},
    consciousnessProfile: "STANDARD",
    innerMonologue:       [],
    introspectionHistory: [],

    eventLog:       [],
    securityEvents: [],
    threatScore:    0,
    anomalies:      [],
    decisions:      [],

    platforms: {
      telegram: { enabled: false, connected: false, messageCount: 0 },
      whatsapp: { enabled: false, connected: false, messageCount: 0 },
      discord:  { enabled: false, connected: false, messageCount: 0 },
    },

    memoryStats: { episodes: 0, facts: 0, procedures: 0, skills: 0, working: 0, decayedFacts: 0, vectors: 0, lastLoaded: 0 },
    memoryLevelHistory: { l2: [], l3: [], l4: [], l5: [] },
    watchdogLastPing: 0,

    activeView:   null,
    focusedPanel: "neural",
    paused:       false,
    replayIndex:  -1,
    searchQuery:  "",
  };
}

// ── Bounded-push helpers ──────────────────────────────────────

export function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

export function pushBoundedHistory(arr: number[], value: number, max: number): void {
  arr.push(value);
  if (arr.length > max) arr.shift();
}
