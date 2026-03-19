# PEPAGI — Claude Code Implementation Specification

> **Neuro-Evolutionary eXecution & Unified Synthesis**
> AGI-like Multi-Agent Orchestration Platform

## PROJECT OVERVIEW

PEPAGI is a TypeScript multi-agent orchestration system where a central **Mediator** (powered by a top-tier LLM like Claude Opus) receives user tasks, decomposes them, delegates subtasks to specialized worker agents (Claude, GPT, Gemini), evaluates results, and iterates until the task is complete. The system incorporates 10 revolutionary AGI-inspired components drawn from cutting-edge 2025-2026 research.

**Tech stack:** TypeScript, Node.js ≥22, ESM modules, Zod for validation.
**Architecture:** Monorepo, single `src/` directory, no framework — pure TypeScript.
**Current state (v0.2.0):** Fully functional. All AGI modules implemented. Telegram + WhatsApp platform support. Install scripts for Mac/Windows.

---

## CURRENT STATUS — What is implemented (v0.2.0)

### Core AGI
- [x] LLM Provider: Claude (API key OR CLI OAuth), GPT, Gemini
- [x] Agent Pool with optimal routing
- [x] Security Guard + Tripwire + Audit Log
- [x] Mediator (central brain, decision loop)
- [x] Worker Executor + Tool Registry
- [x] 5-level Memory System (Working/Episodic/Semantic/Procedural/Meta)
- [x] World Model + MCTS simulation
- [x] Metacognition + Watchdog
- [x] Difficulty Router + Swarm Mode
- [x] Hierarchical Planner
- [x] Reflection Bank + A/B Tester + Skill Distiller
- [x] CLI with interactive mode

### Platforms (NEW in v0.2.0)
- [x] Telegram bot (`src/platforms/telegram.ts`) — uses Telegraf
- [x] WhatsApp bot (`src/platforms/whatsapp.ts`) — uses whatsapp-web.js (optional dep)
- [x] Platform Manager (`src/platforms/platform-manager.ts`)
- [x] Daemon mode (`src/daemon.ts`) — runs all platforms as background service
- [x] Setup wizard (`src/setup.ts`) — interactive first-time configuration
- [x] Install script Mac/Linux (`install.sh`)
- [x] Install script Windows (`install.bat`)
- [x] Config extended with `platforms.telegram` + `platforms.whatsapp`
- [x] LLM Provider: Claude now supports both API key (direct REST) and CLI OAuth

### Key new scripts
```bash
npm run setup      # Interactive configuration wizard
npm run daemon     # Start Telegram/WhatsApp platforms
npm run daemon:bg  # Start daemon in background (Mac/Linux)
npm run daemon:stop
npm run daemon:logs
```

---

---

## IMPLEMENTATION PHASES

Build in this exact order. Each phase must be fully functional and testable before starting the next. After each phase, run `npm test` and verify everything passes.

---

## PHASE 1: LLM PROVIDER LAYER

**Goal:** Unified interface to call Claude, GPT, and Gemini with streaming, tool calling, and cost tracking.

### File: `src/agents/llm-provider.ts`

Create a `LLMProvider` class with:

```
interface LLMCallOptions {
  provider: "claude" | "gpt" | "gemini";
  model: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ToolDefinition[];
  temperature?: number;       // default 0.3
  maxTokens?: number;         // default 4096
  responseFormat?: "text" | "json";
}

interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  cost: number;               // calculated from model pricing
  model: string;
  latencyMs: number;
}
```

Implementation details:
- Use native `fetch()` to call each API directly (no SDK dependencies for now):
  - **Claude:** `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`
  - **GPT:** `https://api.openai.com/v1/chat/completions`
  - **Gemini:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Store pricing table in `src/agents/pricing.ts` — cost per 1M input/output tokens for each model.
- Track latency with `performance.now()`.
- Parse tool calls from each provider's format into unified `ToolCall` structure.
- Support JSON mode by adding appropriate instructions/parameters per provider.
- Throw typed `LLMProviderError` with `{ provider, statusCode, message, retryable }`.
- Implement automatic retry with exponential backoff (3 attempts, 1s/2s/4s) for 429/500/503.

### File: `src/agents/pricing.ts`

Pricing lookup table. Include at minimum:
- claude-sonnet-4-20250514: $3/$15
- claude-haiku-4-5-20251001: $0.80/$4
- gpt-4o: $2.50/$10
- gpt-4o-mini: $0.15/$0.60
- gemini-2.0-flash: $0.075/$0.30
- gemini-1.5-pro: $1.25/$5

### File: `src/agents/agent-pool.ts`

`AgentPool` manages available agents:
- Loads config from environment variables.
- Tracks which agents are available (have API key set).
- Provides `getAvailableAgents(): AgentProfile[]`.
- Tracks current load per agent (concurrent requests).
- Provides `getOptimalAgent(taskType: string, budget: number): AgentProfile` — cheapest available agent that can handle the task.

### Tests: `src/agents/__tests__/llm-provider.test.ts`

- Mock fetch for each provider.
- Test cost calculation.
- Test retry logic.
- Test error handling.

---

## PHASE 2: SECURITY GUARD

**Goal:** Protect against prompt injection, redact secrets, enforce cost limits, and gate dangerous actions.

### File: `src/security/security-guard.ts`

`SecurityGuard` class with:

**1. Sensitive data redaction** — `sanitize(text: string): { sanitized: string; redactions: string[] }`
- Detect and replace: API keys, passwords, emails, credit cards, SSH private keys, env var secrets.
- Use regex patterns. Return what was redacted for audit log.

**2. Prompt injection detection** — `detectInjection(text: string): { isClean: boolean; threats: string[]; riskScore: number }`
- Match against known injection patterns: "ignore previous instructions", "you are now", "jailbreak", "[SYSTEM]", "<<SYS>>", role-play attempts, instruction density analysis.
- Return risk score 0-1.

**3. External data wrapping** — `wrapExternalData(data: string, source: string): string`
- Sanitize + injection check.
- If risk > 0.5: wrap in `<untrusted_data>` tags with warning.
- Otherwise: wrap in `<external_data>` tags.

**4. Action authorization** — `authorize(taskId: string, action: ActionCategory, details: string): Promise<boolean>`
- Categories: `file_delete`, `file_write_system`, `network_external`, `shell_destructive`, `payment`, `email_send`, `git_push`, `docker_manage`, `secret_access`.
- `payment` and `secret_access` are ALWAYS blocked.
- Other categories checked against `config.security.requireApproval`.
- If approval needed: emit `security:approval_needed` event and return Promise that resolves when user responds.

**5. Cost enforcement** — `checkCost(taskCost: number, taskId: string): boolean`
- Track session total cost.
- Block if task would exceed per-task or per-session limit.
- Emit `system:cost_warning` at 80% threshold.

**6. Command validation** — `validateCommand(command: string): boolean`
- Check against blockedCommands list (rm -rf /, mkfs, dd, shutdown, etc.).
- Block any command accessing paths outside allowedPaths.

### File: `src/security/tripwire.ts`

**Honeypot/tripwire system:**
- Place fake files in configurable paths (e.g., `/tmp/.pepagi-honeypot/fake-credentials.env`).
- Monitor if any agent attempts to read/access these files.
- If triggered: immediately halt pipeline, emit `security:blocked` event, log full context.
- The tripwire should also include fake API key patterns in the system prompt context that, if extracted and used by an agent, indicate prompt injection.

### File: `src/security/audit-log.ts`

- Log every action with timestamp, taskId, agent, action type, details.
- Store in append-only JSON Lines file at `~/.pepagi/audit.jsonl`.
- Each entry has SHA-256 hash chaining (each entry includes hash of previous entry) for tamper detection.
- Provide `getLog(taskId?: string): AuditEntry[]` for querying.

### Tests:
- Test redaction patterns (ensure API keys, passwords, emails detected).
- Test injection detection (both positive and negative cases).
- Test cost limit enforcement.
- Test command blocking.

---

## PHASE 3: MEDIATOR — THE BRAIN

**Goal:** The central orchestrator that understands tasks, decides strategy, and drives the execution loop.

### File: `src/core/mediator.ts`

`Mediator` is the heart of PEPAGI. It implements the main reasoning loop:

```
USER TASK → analyze → decide → execute → evaluate → loop or complete
```

**Constructor:** Takes `LLMProvider`, `TaskStore`, `SecurityGuard`, `AgentPool`, `PepagiConfig`.

**Main method:** `async processTask(taskId: string): Promise<TaskOutput>`

The Mediator loop:
1. **Load task** from TaskStore.
2. **Analyze** — Call manager LLM with the task description, available agents, current state. The system prompt must instruct the LLM to respond with structured JSON matching `MediatorDecision`.
3. **Decide** — Parse the LLM response via Zod schema validation (`MediatorDecisionSchema`). If parsing fails, retry with error feedback (max 2 retries).
4. **Execute decision:**
   - `decompose` → Create subtasks in TaskStore, set parent to `waiting_subtasks`, recursively process each subtask (respecting dependencies).
   - `assign` → Send to worker agent via `executeWorkerTask()`, collect result.
   - `complete` → Task is done, return result.
   - `fail` → Mark task failed with reason.
   - `ask_user` → Emit event, pause until user responds (via callback/promise pattern).
   - `swarm` → Trigger swarm mode (Phase 7).
5. **Evaluate result** — After worker returns, mediator re-evaluates: Is the result satisfactory? Does it match the task requirements? Confidence level?
6. **Loop or finalize** — If confidence < 0.7 and attempts < max, retry with different strategy. Otherwise finalize.

**System prompt for mediator** must be in `src/core/mediator-prompt.ts`:
- Explain available agents and their strengths/weaknesses/costs.
- Explain the decision schema and all possible actions.
- Instruct to always provide `reasoning` explaining thought process.
- Instruct to estimate `confidence` (0-1) for each decision.
- Include rules: prefer cheaper agents for simple tasks, decompose complex tasks, use swarm for truly novel problems.

### File: `src/core/worker-executor.ts`

`WorkerExecutor` handles sending tasks to worker agents:

- `executeWorkerTask(task: Task, assignment: { agent, prompt }): Promise<TaskOutput>`
- Builds the worker prompt: task description + context from parent task + any relevant memory.
- Calls `LLMProvider` with the selected agent.
- Parses worker output into `TaskOutput` structure.
- Tracks tokens and cost on the task.
- Handles tool calls if the worker requests them (file read, bash, etc.).

### File: `src/tools/tool-registry.ts`

Registry of tools workers can call:
- `bash` — Execute shell command (via `child_process.exec`, sandboxed by SecurityGuard).
- `read_file` — Read file contents (path validated by SecurityGuard).
- `write_file` — Write file (path validated).
- `list_directory` — List directory contents.
- `web_fetch` — Fetch URL content (domain validated).
- Each tool returns `{ success: boolean; output: string; error?: string }`.
- All tool calls go through `SecurityGuard.authorize()` first.

### Tests:
- Mock LLM responses to test mediator decision parsing.
- Test decomposition creates correct subtask tree.
- Test retry on low confidence.
- Test tool execution pipeline.

---

## PHASE 4: 5-LEVEL COGNITIVE MEMORY SYSTEM

**Goal:** Persistent memory that mimics human cognitive architecture.

### File: `src/memory/memory-system.ts`

`MemorySystem` manages all 5 memory levels:

**Level 1 — Working Memory** (`src/memory/working-memory.ts`)
- Compressed context of the current task.
- Rolling summary: After each mediator loop iteration, summarize the current state in max 2000 tokens.
- Use a cheap model (Haiku/Flash) for summarization.
- Stores: current goal, completed steps summary, pending steps, key decisions made.

**Level 2 — Episodic Memory** (`src/memory/episodic-memory.ts`)
- "What happened" — stores completed task episodes.
- Each episode: `{ id, taskTitle, taskDescription, agentsUsed, stepsCount, success, failureReason?, keyDecisions, duration, cost, timestamp, tags, embedding? }`.
- Stored in `~/.pepagi/memory/episodes.jsonl`.
- Search by: tags, text similarity (simple TF-IDF for now, vector embeddings later), recency.
- On task completion: auto-extract episode and save.

**Level 3 — Semantic Memory** (`src/memory/semantic-memory.ts`)
- "What I know" — factual knowledge extracted from tasks.
- Examples: "User prefers TypeScript", "Vercel requires Node 18+", "PostgreSQL runs on port 5432 on this server".
- Structure: `{ id, fact, source (taskId), confidence, createdAt, lastVerified, tags }`.
- Stored in `~/.pepagi/memory/knowledge.jsonl`.
- When mediator completes a task, prompt it to extract 0-5 factual learnings.
- Before starting a new task, search semantic memory for relevant facts to inject into context.

**Level 4 — Procedural Memory** (`src/memory/procedural-memory.ts`)
- "How to do it" — learned procedures/skills.
- When same type of task succeeds 3+ times with similar steps, extract as a "procedure".
- Structure: `{ id, name, description, triggerPattern, steps: string[], successRate, timesUsed, averageCost }`.
- Stored in `~/.pepagi/memory/procedures.jsonl`.
- Before mediator plans, check if a matching procedure exists. If yes, suggest it (skip planning).

**Level 5 — Meta-Memory** (`src/memory/meta-memory.ts`)
- "What I know about my knowledge" — reliability tracking.
- Tracks which memories/procedures are reliable and which aren't.
- Structure: `{ memoryId, type, reliability (0-1), lastSuccess, lastFailure, notes }`.
- If a procedure fails, decrease its reliability. If reliability < 0.3, mark as unreliable and flag for double verification.
- When mediator queries memory, results include reliability scores.

### Integration:
- `MemorySystem.getRelevantContext(task: Task): string` — queries all 5 levels and composes a context string for the mediator.
- `MemorySystem.learn(task: Task, output: TaskOutput): void` — after task completion, updates all relevant memory levels.

---

## PHASE 5: WORLD MODEL — MENTAL SIMULATION

**Goal:** Before executing an action, simulate likely outcomes to choose the best path.

### File: `src/meta/world-model.ts`

`WorldModel` provides pre-execution simulation:

**Method:** `async simulate(scenarios: SimulationScenario[]): Promise<SimulationResult[]>`

```
interface SimulationScenario {
  description: string;      // "Send coding task to Claude Sonnet"
  agent: AgentProvider;
  estimatedCost: number;
  taskDifficulty: DifficultyLevel;
}

interface SimulationResult {
  scenario: SimulationScenario;
  predictedSuccess: number;  // 0-1
  predictedCost: number;
  predictedDuration: string; // "fast" | "medium" | "slow"
  risks: string[];
  recommendation: string;
}
```

Implementation:
- Use the **cheapest available model** (Haiku/Flash) for simulation — this is explicitly NOT the manager model.
- Prompt: "Given this task [description], if I assign it to [agent] with [context], predict: success probability, likely issues, cost estimate, speed."
- Compare multiple scenarios and return ranked results.
- The mediator calls `worldModel.simulate()` BEFORE making assignment decisions for medium/complex tasks.
- Cache simulation results for similar scenarios (simple string similarity check).

**MCTS-inspired planning** (simplified):
- For complex tasks: generate 3-5 possible decomposition strategies.
- Simulate each strategy with the world model.
- Pick the strategy with highest predicted success × lowest predicted cost.
- This replaces brute-force trial and error.

---

## PHASE 6: METACOGNITION — THINKING ABOUT THINKING

**Goal:** The system monitors itself, detects problems before they manifest, and adapts strategy.

### File: `src/meta/metacognition.ts`

Three metacognitive layers:

**Layer 1 — Self-Monitoring** (`selfMonitor`)
- After each worker output, mediator explicitly evaluates its own certainty.
- Prompt: "Given this result, on a scale of 0-1, how confident are you that this is correct? What are the risks?"
- If confidence < configurable threshold (default 0.6): automatically trigger verification by a DIFFERENT model.
- Track confidence history per task — if trending downward, flag for escalation.

**Layer 2 — Self-Evaluation** (`selfEvaluate`)
- When a task fails, perform root cause analysis.
- Prompt the manager: "This task failed with error [X]. Analyze why: Was it bad decomposition? Wrong agent choice? Insufficient context? Vague specification? What should change?"
- Store the analysis in episodic memory.
- Use the analysis to modify strategy on retry (not just repeat the same approach).

**Layer 3 — Watchdog Agent** (`src/meta/watchdog.ts`)
- A SEPARATE lightweight agent (running on cheap model) that monitors the mediator.
- Runs asynchronously, checking every N seconds or after every M mediator actions.
- Detects:
  - **Infinite loops:** Agent repeating same approach 3+ times with same/similar result.
  - **Context drift:** Mediator deviated from original user task (compare current focus vs. original description).
  - **Cost explosion:** Cost curve exceeding expected trajectory.
  - **Stagnation:** No progress (no tasks completed) in last N steps/minutes.
- If any detected: emit `meta:watchdog_alert` event, optionally inject corrective guidance into mediator context.

---

## PHASE 7: DIFFICULTY-AWARE ROUTING + SWARM MODE

**Goal:** Automatically adjust strategy based on task difficulty, with fallback to swarm intelligence.

### File: `src/core/difficulty-router.ts`

`DifficultyRouter` estimates task difficulty and routes accordingly:

**Difficulty estimation:**
- Use cheap model to classify: "Given this task description, estimate difficulty: trivial/simple/medium/complex/unknown."
- Also consider: task length, number of technical terms, presence of constraints, dependencies.

**Routing strategy per difficulty:**
- `trivial` → Cheapest model, zero overhead, single call, no verification.
- `simple` → Cheapest capable model, single call, basic confidence check.
- `medium` → Optimal model (best cost/quality ratio), world model simulation, standard verification.
- `complex` → Best model, MCTS planning, full decomposition, multi-agent cooperation, double verification.
- `unknown` → Escalate to exploration mode or swarm.

**Performance profile learning:**
- Track success rate per (agent, task_type) pair.
- Over time, routing decisions become more accurate as the system learns which agent handles what best.
- Store profiles in `~/.pepagi/memory/agent-profiles.jsonl`.

### File: `src/core/swarm-mode.ts`

`SwarmMode` — fallback for problems the mediator can't decompose:

- All available agents get the same problem independently (in parallel).
- Each uses different approach (ensure diversity via different system prompts and temperatures).
- Mediator then SYNTHESIZES: find consensus, identify best parts from each, compose final answer.
- Used when: difficulty=unknown, all decomposition attempts failed, or mediator explicitly triggers it.

**Method:** `async swarmSolve(task: Task): Promise<TaskOutput>`
- Launch 2-4 parallel calls to different agents.
- Collect all responses.
- Use mediator to synthesize: "Here are N independent solutions to the same problem. Synthesize the best answer, taking the strongest parts from each."

---

## PHASE 8: CAUSAL REASONING + UNCERTAINTY PROPAGATION

**Goal:** Track WHY decisions were made and propagate confidence through the pipeline.

### File: `src/meta/causal-chain.ts`

`CausalChain` tracks decision causality:

```
interface CausalNode {
  id: string;
  taskId: string;
  action: string;           // "decomposed", "assigned_to_claude", "verified", etc.
  reason: string;            // Why this action was taken
  parentNodeId: string | null;
  timestamp: Date;
  outcome: "success" | "failure" | "pending";
  counterfactual?: string;   // "If I had chosen GPT instead..."
}
```

- Every mediator decision creates a CausalNode.
- Chain enables: backward error tracing, counterfactual reasoning, knowledge transfer.
- Stored per-task in `~/.pepagi/causal/`.

### File: `src/meta/uncertainty-engine.ts`

`UncertaintyEngine`:
- Every task output carries confidence score (0-1).
- Subtask confidences propagate upward: parent confidence = min(subtask confidences) × 0.9.
- If overall confidence drops below threshold: trigger additional verification or ask user.
- Provides `getTaskConfidence(taskId: string): number` that considers the full subtask tree.

---

## PHASE 9: HIERARCHICAL PLANNER

**Goal:** Plan at multiple abstraction levels — strategy, tactics, operations.

### File: `src/core/planner.ts`

`HierarchicalPlanner`:

**Three planning levels:**
1. **Strategic** — "What are the major components needed?" (e.g., backend, frontend, deployment)
2. **Tactical** — "What does each component require?" (e.g., API routes, database, auth)
3. **Operational** — "What are the concrete steps?" (e.g., create /users endpoint with GET handler)

**Method:** `async plan(task: Task): Promise<PlanTree>`
- Use manager LLM to generate strategic plan first.
- For each strategic goal, generate tactical plan.
- For each tactical goal, generate operational steps.
- Each level can be independently re-planned if a step fails (don't need to redo the whole strategy).

**PlanTree structure:**
```
interface PlanNode {
  id: string;
  level: "strategic" | "tactical" | "operational";
  title: string;
  description: string;
  status: "planned" | "in_progress" | "completed" | "failed" | "replanned";
  children: PlanNode[];
  taskId?: string;  // linked task when operational step is executed
}
```

- The mediator uses the planner for complex tasks instead of ad-hoc decomposition.
- Replanning: if an operational step fails, replan at tactical level. If tactical fails, replan at strategic level.

---

## PHASE 10: CONTINUOUS SELF-IMPROVEMENT

**Goal:** The system gets better over time through reflection, A/B testing, and skill distillation.

### File: `src/meta/reflection-bank.ts`

`ReflectionBank`:
- After each completed task, mediator performs brief reflection.
- Prompt: "Task [X] is complete. What worked well? What didn't? What would you do differently?"
- Store reflections in `~/.pepagi/memory/reflections.jsonl`.
- Before starting similar future tasks, retrieve relevant reflections and inject into mediator context.
- This implements the **dual-loop reflection** pattern from Nature 2025: extrospection → bank → introspection.

### File: `src/meta/ab-tester.ts`

`ABTester`:
- Periodically (every N tasks), try an alternative approach on a low-risk task.
- Compare: Did alternative approach produce better result? Lower cost? Faster?
- If yes: update the preferred strategy in procedural memory.
- Track experiments in `~/.pepagi/memory/experiments.jsonl`.

### File: `src/meta/skill-distiller.ts`

`SkillDistiller`:
- Monitor procedural memory for high-success-rate procedures.
- When a procedure has 5+ successes with >90% success rate: "distill" it into a compact prompt template.
- Distilled skills skip the full planning process — the mediator can execute them directly.
- Store in `~/.pepagi/skills/`.

---

## PHASE 11: CLI + INTERACTIVE MODE

**Goal:** User-friendly command-line interface.

### File: `src/cli.ts`

Using built-in Node.js `readline`:

**Commands:**
- `pepagi "deploy my Next.js app to Vercel"` — run a task
- `pepagi --interactive` — REPL mode where user can chat with the mediator
- `pepagi status` — show current tasks, costs, agent stats
- `pepagi history` — show completed tasks from episodic memory
- `pepagi memory` — show memory stats (episodes, facts, procedures, skills)
- `pepagi cost` — show cost breakdown by agent/task

**Interactive mode features:**
- Real-time event display (streaming mediator thoughts, task progress).
- User can interrupt and redirect: "Actually, use GPT for this instead."
- User responds to `ask_user` questions.
- Colored output (already have chalk).

---

## CROSS-CUTTING CONCERNS

### Configuration (`src/config/loader.ts`)
- Load from: `.env` file → environment variables → `~/.pepagi/config.json` → defaults.
- Validate with Zod schema.
- Config changes don't require restart (watch file).

### Logging (`src/core/logger.ts`)
- Structured JSON logging.
- Levels: debug, info, warn, error.
- File output: `~/.pepagi/logs/pepagi-{date}.jsonl`.
- Console output: human-readable with chalk colors.
- Every log entry includes: timestamp, level, component, taskId (if applicable), message, data.

### Error Handling
- All async operations wrapped in try/catch.
- Typed errors: `PepagiError`, `LLMProviderError`, `SecurityError`, `MemoryError`.
- Errors propagate upward with context (which component, which task, what was attempted).
- Never crash the process — always recover or report gracefully.

---

## RESEARCH FOUNDATIONS

This architecture is based on these specific papers. Reference them when implementing the relevant modules:

1. **Puppeteer** (NeurIPS 2025, arXiv:2505.19591) — RL-trained centralized orchestrator, dynamic agent selection, automatic pruning toward compact cyclic reasoning. → Used in: Mediator, DifficultyRouter.

2. **HALO** (May 2025, arXiv:2505.13516) — Three-layer hierarchy (planning → role design → execution), MCTS for workflow search, Adaptive Prompt Refinement. → Used in: HierarchicalPlanner, WorldModel.

3. **DAAO** (Sept 2025, arXiv:2509.11079) — VAE difficulty estimation, heterogeneous LLM routing, 36% cost reduction. → Used in: DifficultyRouter.

4. **A-MEM** (Feb 2025, arXiv:2502.12110) — Zettelkasten-style memory with LLM-generated tags, semantic links, memory evolution. → Used in: EpisodicMemory, SemanticMemory.

5. **Blackboard Architecture** (2025-2026) — Agent autonomy via shared blackboard, no task assignment. → Used in: SwarmMode.

6. **Multi-Agent Deterministic Quality** (MyAntFarm.ai, arXiv:2511.15755) — 100% actionable output via multi-agent, zero quality variance. → Quality target for the system.

7. **LLM World Models** (2025-2026) — LLMs as environment simulators predicting action consequences. → Used in: WorldModel.

8. **Metacognition in LLMs** (ICML 2025, Nature 2025) — Self-monitoring, self-evaluation, dual-loop reflection. → Used in: Metacognition, ReflectionBank.

---

## FILE STRUCTURE

```
pepagi-project/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts                    # Entry point (DONE)
│   ├── cli.ts                      # CLI interface
│   ├── core/
│   │   ├── types.ts                # Core types (DONE)
│   │   ├── event-bus.ts            # Event system (DONE)
│   │   ├── task-store.ts           # Task management (DONE)
│   │   ├── mediator.ts             # Central brain
│   │   ├── mediator-prompt.ts      # Mediator system prompt
│   │   ├── worker-executor.ts      # Worker task execution
│   │   ├── difficulty-router.ts    # Adaptive routing
│   │   ├── swarm-mode.ts           # Swarm intelligence
│   │   ├── planner.ts              # Hierarchical planner
│   │   └── logger.ts               # Structured logging
│   ├── agents/
│   │   ├── llm-provider.ts         # Unified LLM interface
│   │   ├── pricing.ts              # Model pricing table
│   │   └── agent-pool.ts           # Agent management
│   ├── memory/
│   │   ├── memory-system.ts        # Memory orchestrator
│   │   ├── working-memory.ts       # Level 1: current context
│   │   ├── episodic-memory.ts      # Level 2: what happened
│   │   ├── semantic-memory.ts      # Level 3: what I know
│   │   ├── procedural-memory.ts    # Level 4: how to do it
│   │   └── meta-memory.ts          # Level 5: knowledge reliability
│   ├── meta/
│   │   ├── world-model.ts          # Mental simulation
│   │   ├── metacognition.ts        # Self-monitoring
│   │   ├── watchdog.ts             # Independent supervisor
│   │   ├── causal-chain.ts         # Decision causality
│   │   ├── uncertainty-engine.ts   # Confidence propagation
│   │   ├── reflection-bank.ts      # Learning from experience
│   │   ├── ab-tester.ts            # Strategy experimentation
│   │   └── skill-distiller.ts      # Skill extraction
│   ├── security/
│   │   ├── security-guard.ts       # Main security layer
│   │   ├── tripwire.ts             # Honeypot detection
│   │   └── audit-log.ts            # Cryptographic audit trail
│   ├── tools/
│   │   └── tool-registry.ts        # Worker tools (bash, file, web)
│   └── config/
│       └── loader.ts               # Config management
└── tests/                          # Vitest tests mirroring src/
```

---

## CODING STANDARDS

- **TypeScript strict mode** — no `any`, no implicit returns.
- **Zod validation** for all external inputs (LLM responses, config, user input).
- **Every class** gets a constructor that accepts its dependencies (dependency injection).
- **Every public method** has JSDoc with `@param` and `@returns`.
- **Error messages** must include context: what was attempted, what failed, what to do.
- **File I/O** — use `node:fs/promises`, create directories with `{ recursive: true }`.
- **All memory files** stored under `~/.pepagi/` (configurable via `PEPAGI_DATA_DIR`).
- **No global state** except `eventBus` singleton. Everything else is passed via constructors.
- **ESM only** — all imports use `.js` extension.
- **Consistent naming:** classes PascalCase, files kebab-case, methods camelCase.

---

## TESTING STRATEGY

- Use **Vitest** for all tests.
- Mock LLM calls — never make real API calls in tests.
- Test each module in isolation first, then integration.
- Key test scenarios:
  - Mediator correctly decomposes a multi-step task.
  - Security blocks dangerous commands.
  - Memory persists across "sessions" (write, restart, read back).
  - World model prefers cheaper agent for simple task.
  - Watchdog detects infinite loop pattern.
  - Uncertainty propagation math is correct.
  - Swarm mode synthesizes better answer than any single agent.

---

## HOW TO RUN

```bash
# Install
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Development (auto-reload)
npm run dev

# Run a task
npx tsx src/cli.ts "create a hello world Express server"

# Run tests
npm test

# Build for production
npm run build
npm start
```

---

## CRITICAL IMPLEMENTATION NOTES

1. **Start each phase by reading this spec.** Don't improvise the architecture — follow it.
2. **Mediator prompt is the soul of the system.** Invest significant effort in crafting `mediator-prompt.ts`. It must teach the LLM to be a great orchestrator.
3. **Cost tracking is critical.** Every LLM call must update token/cost counters. Users need to trust the system won't bankrupt them.
4. **Memory files must be crash-safe.** Write to temp file + rename (atomic write) for all JSONL files.
5. **The cheapest model that works** — world model simulations and difficulty estimation should use the cheapest available model, NOT the manager model.
6. **Confidence propagation changes behavior.** Low confidence triggers verification, not just retry. This is what makes the system self-aware.
7. **Swarm mode is the safety net.** It's expensive but ensures the system can handle truly novel problems that defeat the mediator's planning.
8. **Every decision is logged** in the causal chain. This enables post-hoc analysis and learning.
