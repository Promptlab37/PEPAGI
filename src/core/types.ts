// ═══════════════════════════════════════════════════════════════
// PEPAGI — Core Type Definitions
// ═══════════════════════════════════════════════════════════════

export type AgentProvider = "claude" | "gpt" | "gemini" | "ollama" | "lmstudio";
export type TaskStatus = "pending" | "queued" | "assigned" | "running" | "waiting_subtasks" | "review" | "completed" | "failed" | "cancelled";
export type TaskPriority = "critical" | "high" | "medium" | "low";
export type DifficultyLevel = "trivial" | "simple" | "medium" | "complex" | "unknown";

// ─── Task ────────────────────────────────────────────────────
export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  difficulty: DifficultyLevel;
  assignedTo: AgentProvider | null;
  assignmentReason: string | null;
  input: Record<string, unknown>;
  output: TaskOutput | null;
  subtaskIds: string[];
  dependsOn: string[];
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  tokensUsed: { input: number; output: number };
  estimatedCost: number;
  confidence: number; // 0-1, uncertainty quantification
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  tags: string[];
}

export interface TaskOutput {
  success: boolean;
  result: unknown;
  summary: string;
  artifacts: Artifact[];
  confidence: number;
}

export interface Artifact {
  id: string;
  type: "file" | "code" | "data" | "text";
  name: string;
  content?: string;
  path?: string;
}

// ─── Agent ───────────────────────────────────────────────────
export interface AgentProfile {
  provider: AgentProvider;
  model: string;
  displayName: string;
  costPerMInputTokens: number;
  costPerMOutputTokens: number;
  maxContextTokens: number;
  supportsTools: boolean;
  available: boolean;
  /** API key for this provider (loaded from config/env) */
  apiKey?: string;
  /** Max agentic turns override (0 or undefined = auto-detect) */
  maxAgenticTurns?: number;
  /** Max output tokens override */
  maxOutputTokens?: number;
}

// ─── Events ──────────────────────────────────────────────────
export type PepagiEvent =
  | { type: "task:created"; task: Task }
  | { type: "task:assigned"; taskId: string; agent: AgentProvider }
  | { type: "task:started"; taskId: string }
  | { type: "task:completed"; taskId: string; output: TaskOutput; cost?: number; agent?: string }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "mediator:thinking"; taskId: string; thought: string }
  | { type: "mediator:decision"; taskId: string; decision: MediatorDecision }
  | { type: "system:cost_warning"; currentCost: number; limit: number }
  | { type: "security:blocked"; taskId: string; reason: string }
  | { type: "meta:watchdog_alert"; message: string }
  | { type: "system:alert"; message: string; level: "warn" | "critical" }
  | { type: "system:goal_result"; goalName: string; message: string; success: boolean; userId?: string }
  | { type: "tool:call";     taskId: string; tool: string; input?: Record<string, unknown> }
  | { type: "tool:result";   taskId: string; tool: string; success: boolean; output: string }
  | { type: "world:simulated"; taskId: string; scenarios: number; winner: string; predictedSuccess: number }
  | { type: "planner:plan";  taskId: string; level: "strategic" | "tactical" | "operational"; steps: number }
  | { type: "causal:node";   taskId: string; action: string; reason: string; parentAction: string | null; counterfactual?: string }
  // SECURITY: SEC-01+ — Security events for comprehensive threat monitoring
  | { type: "security:injection_detected"; source: string; riskScore: number; trustLevel: string }
  | { type: "security:credential_access"; credential: string; accessor: string }
  | { type: "security:tool_blocked"; tool: string; reason: string; taskId: string }
  | { type: "security:approval_needed"; action: string; taskId: string; timeout: number }
  | { type: "security:approval_granted"; action: string; taskId: string; approver: string }
  | { type: "security:approval_denied"; action: string; taskId: string }
  | { type: "security:approval_timeout"; action: string; taskId: string }
  | { type: "security:memory_poisoning_detected"; memoryId: string; reason: string }
  | { type: "security:agent_isolated"; agent: string; reason: string }
  | { type: "security:drift_detected"; sessionId: string; distance: number }
  | { type: "security:skill_blocked"; skill: string; reason: string }
  | { type: "security:mcp_auth_failed"; ip: string }
  | { type: "security:session_violation"; userId: string; attempted: string }
  | { type: "security:consciousness_anomaly"; dimension: string; delta: number }
  | { type: "security:quarantine_entered"; reason: string }
  | { type: "consciousness:qualia"; qualia: Record<string, number> };

// ─── Mediator Decision ───────────────────────────────────────
export interface MediatorDecision {
  action: "decompose" | "assign" | "complete" | "fail" | "ask_user" | "swarm";
  reasoning: string;
  subtasks?: { title: string; description: string; suggestedAgent: AgentProvider | null; priority: TaskPriority }[];
  assignment?: { agent: AgentProvider; reason: string; prompt: string };
  result?: string;
  failReason?: string;
  question?: string;
  confidence: number;

  // Consciousness output fields (C8.2) — optional
  introspection?: {
    currentFeeling: string;        // 'Cítím se jistý/nejistý/zvědavý...'
    emotionalState?: {
      pleasure?: number;
      confidence?: number;
      frustration?: number;
      curiosity?: number;
    };
    relevantThoughts?: string[];   // z inner monologue
    valueCheck: boolean;           // je toto rozhodnutí v souladu s hodnotami?
  };
  consciousnessNote?: string;      // meta-poznámka o vlastním fungování
  alternatives?: Array<{           // rejected alternatives (if mediator emits them)
    action: string;
    agent?: string;
    reasoning: string;
    estimatedCost?: number;
  }>;
}

// ─── Config ──────────────────────────────────────────────────
export interface PepagiConfig {
  managerProvider: AgentProvider;
  managerModel: string;
  agents: Record<AgentProvider, { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number }>;
  security: { maxCostPerTask: number; maxCostPerSession: number; blockedCommands: string[]; requireApproval: string[] };
  queue: { maxConcurrentTasks: number; taskTimeoutMs: number };
}
