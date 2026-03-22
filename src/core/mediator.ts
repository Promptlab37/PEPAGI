// ═══════════════════════════════════════════════════════════════
// PEPAGI — Mediator (Central Orchestrator Brain)
// ═══════════════════════════════════════════════════════════════

import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { eventBus } from "./event-bus.js";
import type { Task, TaskOutput, MediatorDecision, AgentProvider, TaskPriority } from "./types.js";
import type { TaskStore } from "./task-store.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { SecurityGuard } from "../security/security-guard.js";
import type { AgentPool } from "../agents/agent-pool.js";
import type { PepagiConfig } from "../config/loader.js";
import type { MemorySystem } from "../memory/memory-system.js";
import { WorkerExecutor } from "./worker-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { buildMediatorSystemPrompt } from "./mediator-prompt.js";
import { LLMProviderError } from "../agents/llm-provider.js";
import { Logger } from "./logger.js";
import type { ReflectionBank } from "../meta/reflection-bank.js";
import type { SkillDistiller } from "../meta/skill-distiller.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { UncertaintyEngine } from "../meta/uncertainty-engine.js";
import { CausalChain } from "../meta/causal-chain.js";
import { ABTester } from "../meta/ab-tester.js";
import type { DifficultyRouter } from "./difficulty-router.js";
import type { WorldModel } from "../meta/world-model.js";
import type { HierarchicalPlanner } from "./planner.js";
// SECURITY: SEC-01 — Input sanitization + context boundaries
import { inputSanitizer } from "../security/input-sanitizer.js";
import { wrapWithBoundary } from "../security/context-boundary.js";
import type { PredictiveContextLoader } from "../meta/predictive-context.js";
// SECURITY: SEC-13 — Cost explosion kill switch
import { costTracker } from "../security/cost-tracker.js";
// SECURITY: SEC-25 — Task-scoped credential lifecycle
import { credentialLifecycle } from "../security/credential-lifecycle.js";
// SECURITY: Task content guard — blocks system file access before agent assignment
import { scanTaskContent, logContentGuardViolation } from "../security/task-content-guard.js";

// Absolute project root — works regardless of where the process is launched from.
// dist/core/mediator.js → ../../ → project root
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const logger = new Logger("Mediator");

/** Attempt to repair truncated JSON by closing open strings, arrays, and objects */
function repairTruncatedJson(text: string): string {
  let s = text.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return s;

  // Close unterminated string — detect if we're inside a string
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  // Remove trailing comma if present
  s = s.replace(/,\s*$/, "");

  // Close unclosed brackets/braces
  const stack: string[] = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // Close remaining open brackets in reverse
  while (stack.length > 0) s += stack.pop();

  return s;
}

// ─── Zod schema for mediator decisions ───────────────────────

// OPUS: Sonnet hardcoded only 3 agent types; system supports 5
const SubtaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  suggestedAgent: z.string().nullable(),
  priority: z.enum(["critical", "high", "medium", "low"]),
});

const MediatorDecisionSchema = z.object({
  action: z.enum(["decompose", "assign", "complete", "fail", "ask_user", "swarm"]),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  subtasks: z.array(SubtaskSchema).optional(),
  // OPUS: must include all AgentProvider values — ollama/lmstudio were missing
  assignment: z.object({
    agent: z.string(),
    reason: z.string(),
    prompt: z.string(),
  }).optional(),
  result: z.string().optional(),
  failReason: z.string().optional(),
  question: z.string().optional(),
  // Consciousness output fields (C8.2)
  introspection: z.object({
    currentFeeling: z.string(),
    emotionalState: z.object({
      pleasure: z.number().optional(),
      confidence: z.number().optional(),
      frustration: z.number().optional(),
      curiosity: z.number().optional(),
    }).optional(),
    relevantThoughts: z.array(z.string()).optional(),
    valueCheck: z.boolean(),
  }).optional(),
  consciousnessNote: z.string().optional(),
});

export class Mediator {
  private executor: WorkerExecutor;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private consciousnessProvider: (() => string) | null = null;
  private predictiveContextLoader: PredictiveContextLoader | null = null;

  constructor(
    private llm: LLMProvider,
    private taskStore: TaskStore,
    private guard: SecurityGuard,
    private pool: AgentPool,
    private config: PepagiConfig,
    private memory: MemorySystem | null = null,
    private reflectionBank: ReflectionBank | null = null,
    private skillDistiller: SkillDistiller | null = null,
    private skillRegistry: SkillRegistry | null = null,
    private uncertaintyEngine: UncertaintyEngine | null = null,
    private causalChain: CausalChain | null = null,
    private abTester: ABTester | null = null,
    private difficultyRouter: DifficultyRouter | null = null,
    private worldModel: WorldModel | null = null,
    private planner: HierarchicalPlanner | null = null,
  ) {
    this.tools = new ToolRegistry();
    const persona = config.profile as import("./mediator-prompt.js").PersonaProfile | undefined;
    this.executor = new WorkerExecutor(llm, guard, this.tools, pool, persona);
    this.systemPrompt = buildMediatorSystemPrompt(pool.getAvailableAgents(), persona, undefined, PROJECT_ROOT);
    // Create defaults if not injected
    if (!this.uncertaintyEngine) this.uncertaintyEngine = new UncertaintyEngine(taskStore);
    if (!this.causalChain) this.causalChain = new CausalChain();
    if (!this.abTester) this.abTester = new ABTester();
  }

  /** Active A/B experiment ID for current round */
  private activeExperimentId: string | null = null;
  private abVariant: "control" | "treatment" = "control";
  /** Counter for auto-learn cycle trigger (consolidate + distill every 10 tasks) */
  private completedTaskCount = 0;

  /** Register a provider for dynamic consciousness context injection */
  setConsciousnessProvider(fn: () => string): void {
    this.consciousnessProvider = fn;
  }

  /** Wire in PredictiveContextLoader to pre-warm memory context before each task */
  setPredictiveContextLoader(loader: PredictiveContextLoader): void {
    this.predictiveContextLoader = loader;
  }

  /**
   * Hot-reload config at runtime (called after web UI saves new settings).
   * Updates managerProvider/managerModel and rebuilds system prompt with current agent pool.
   */
  updateConfig(newConfig: PepagiConfig): void {
    this.config = newConfig;
    this.systemPrompt = buildMediatorSystemPrompt(
      this.pool.getAvailableAgents(),
      newConfig.profile as import("./mediator-prompt.js").PersonaProfile | undefined,
      undefined,
      PROJECT_ROOT,
    );
  }

  /** Auto-consolidate episodic→semantic facts and distill high-success procedures into skills */
  private async autoLearnCycle(): Promise<void> {
    if (this.memory) {
      await this.memory.consolidate();
    }
    if (this.skillDistiller) {
      await this.skillDistiller.distill();
    }
    logger.info("Auto-learn cycle completed", { taskCount: this.completedTaskCount });
  }

  /** Kill a running agent execution. Returns true if found. */
  killAgent(provider: import("./types.js").AgentProvider): boolean {
    return this.executor.killAgent(provider);
  }

  /** Get running task executions for monitoring. */
  getRunningTasks(): Array<{ taskId: string; agent: import("./types.js").AgentProvider; startedAt: number }> {
    return this.executor.getRunningTasks();
  }

  /**
   * Main entry point: process a task to completion.
   */
  async processTask(taskId: string): Promise<TaskOutput> {
    const task = this.taskStore.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // ── SECURITY: Block tasks requesting system file access ────
    // Must run BEFORE any processing — blocks the task immediately
    // so it never reaches a worker agent (whose built-in tools
    // would bypass our ToolRegistry path-validator).
    const contentCheck = scanTaskContent(`${task.title} ${task.description}`);
    if (contentCheck.blocked) {
      logContentGuardViolation(`${task.title} ${task.description}`, contentCheck, taskId, "mediator");
      const blockedOutput: TaskOutput = {
        success: false,
        result: null,
        summary: `Security: ${contentCheck.reason}`,
        artifacts: [],
        confidence: 0,
      };
      this.taskStore.fail(taskId, contentCheck.reason);
      return blockedOutput;
    }

    task.status = "running";
    task.startedAt = new Date();
    task.attempts += 1;

    logger.info("Processing task", { taskId, title: task.title, attempt: task.attempts });
    eventBus.emit({ type: "mediator:thinking", taskId, thought: `Analyzing task: "${task.title}"` });

    // Check SkillRegistry — if a dynamic skill matches, execute it directly (bypass planning)
    if (this.skillRegistry) {
      const match = this.skillRegistry.findMatch(task.description);
      if (match) {
        const skillName = match.skill.name;
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `Skill match: "${skillName}" — executing directly` });
        logger.info("SkillRegistry match — executing skill directly", { skill: skillName, taskId });
        try {
          const skillResult = await this.skillRegistry.execute(task.description, task.id);
          if (skillResult !== null) {
            const output: TaskOutput = {
              success: skillResult.success,
              result: skillResult.output,
              summary: skillResult.success ? `Skill "${skillName}" dokončen` : "Skill selhal",
              artifacts: [],
              confidence: skillResult.success ? 0.9 : 0.2,
            };
            this.taskStore.complete(taskId, output);
            if (this.memory) await this.memory.learn(task, output).catch(e => logger.debug("memory.learn failed", { error: String(e) }));
            return output;
          }
        } catch (err) {
          logger.warn("Skill execution failed, falling through to mediator", { skill: skillName, error: String(err) });
        }
      }
    }

    // Get memory context (with predictive pre-loading when available)
    eventBus.emit({ type: "mediator:thinking", taskId, thought: "Retrieving relevant memory context..." });
    let memoryContext = this.memory ? await this.memory.getRelevantContext(task) : "";
    if (this.predictiveContextLoader && !memoryContext) {
      try {
        const predicted = await this.predictiveContextLoader.preloadContext(task, []);
        if (predicted.relevantMemories.length > 50 && predicted.confidence > 0.4) {
          memoryContext = `\n\n## Predictive Context (${predicted.taskType}, confidence: ${predicted.confidence.toFixed(2)})\n${predicted.relevantMemories}`;
        }
      } catch { /* non-blocking */ }
    }

    // ── DifficultyRouter + WorldModel ──────────────────────────
    let routingContext = "";
    let taskDifficulty: import("../core/types.js").DifficultyLevel = "medium";
    if (this.difficultyRouter) {
      try {
        const qualia = this.consciousnessProvider
          ? (() => {
              try {
                const ctx = this.consciousnessProvider();
                // Extract qualia proxy from consciousness context string (rough heuristic)
                // Matches both "frustration > 0.6" (behavioral guidance) and "frustrace = 0.x" (old format)
                const frustMatch = ctx.match(/frustrat?i(?:on|ce|ci)\s*[>=<:]\s*([\d.]+)/i);
                const confMatch = ctx.match(/confidence\s*[>=<:]\s*([\d.]+)|d[uů]v[eě]ra\s*[=:]\s*([\d.]+)/i);
                // If threshold-based ("frustration > 0.6"), use the threshold as approximation
                return {
                  frustration: frustMatch ? parseFloat(frustMatch[1]!) : 0,
                  confidence: confMatch ? parseFloat(confMatch[1] ?? confMatch[2] ?? "0.7") : 0.7,
                } as import("../consciousness/phenomenal-state.js").QualiaVector;
              } catch { return undefined; }
            })()
          : undefined;

        // Use task.title (the actual user message, max 80 chars) for difficulty
        // estimation, NOT task.description which includes conversation history
        // and context that inflates word count and confuses the LLM classifier.
        const routing = await this.difficultyRouter.route(task.title, qualia);
        // BUG-04: route() now returns null when no agents are available
        if (!routing) {
          const noAgentsOut: TaskOutput = { success: false, result: "No agents available", summary: "No agents available in pool", artifacts: [], confidence: 0 };
          this.taskStore.fail(taskId, "No agents available");
          return noAgentsOut;
        }
        taskDifficulty = routing.difficulty;
        task.difficulty = routing.difficulty;
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `Difficulty: ${routing.difficulty} — ${routing.reasoning.slice(0, 100)}` });

        let hint = `\n## Routing Analysis\n**Difficulty:** ${routing.difficulty} | **Recommended agent:** ${routing.recommendedAgent}\n**Reasoning:** ${routing.reasoning}`;

        // WorldModel simulation for medium/complex tasks
        if (routing.useWorldModel && this.worldModel) {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: "Simulating scenarios with WorldModel..." });
          const available = this.pool.getAvailableAgents().slice(0, 3);
          const scenarios = available.map(agent => ({
            description: task.description,
            agent: agent.provider,
            estimatedCost: agent.costPerMInputTokens / 1_000_000 * 1000,
            taskDifficulty: routing.difficulty,
          }));

          const simResults = await this.worldModel.simulate(scenarios);
          const bestIdx = this.worldModel.pickBest(simResults);
          const best = simResults[bestIdx];
          if (best) {
            hint += `\n**World Model — best scenario:** ${best.scenario.agent} (success: ${(best.predictedSuccess * 100).toFixed(0)}%, cost: $${best.predictedCost.toFixed(4)})\n**Risks:** ${best.risks.slice(0, 2).join("; ") || "none"}\n**Recommendation:** ${best.recommendation}`;
          }
          logger.debug("WorldModel simulation complete", { taskId, bestAgent: best?.scenario.agent, difficulty: routing.difficulty });
        }

        // HierarchicalPlanner — for complex tasks, generate a 3-level plan as context
        if ((routing.difficulty === "complex" || routing.difficulty === "unknown") && this.planner) {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: "Complex task — generating hierarchical plan..." });
          try {
            const planTree = await this.planner.plan(task);
            const formatted = this.planner.formatPlan(planTree);
            if (formatted) {
              hint += `\n\n## Hierarchical Plan (Strategic → Tactical → Operational)\n${formatted}`;
              logger.info("HierarchicalPlanner: plan generated", { taskId, difficulty: routing.difficulty });
            }
          } catch (planErr) {
            logger.debug("HierarchicalPlanner failed, continuing without", { error: String(planErr) });
          }
        }

        routingContext = hint;
        logger.debug("DifficultyRouter", { taskId, difficulty: routing.difficulty, agent: routing.recommendedAgent, useSwarm: routing.useSwarm });

        // If swarm mode is recommended and it's the first attempt, trigger swarm
        if (routing.useSwarm && task.attempts === 1 && routing.difficulty === "unknown") {
          logger.info("DifficultyRouter: escalating to swarm mode", { taskId, difficulty: routing.difficulty });
          const swarmOut = await this.processSwarm(task, memoryContext);
          this.taskStore.complete(taskId, swarmOut);
          if (this.memory) await this.memory.learn(task, swarmOut).catch(e => logger.debug("memory.learn failed", { error: String(e) }));
          await this.difficultyRouter.recordOutcome(
            this.pool.getAvailableAgents()[0]?.provider ?? "claude",
            "swarm", swarmOut.success, task.estimatedCost,
          ).catch(e => logger.debug("recordOutcome failed", { error: String(e) }));
          return swarmOut;
        }
      } catch (err) {
        logger.debug("DifficultyRouter failed, continuing without", { error: String(err) });
      }
    }

    // ── ABTester: check if we should run an experiment ─────────
    if (this.abTester) {
      const shouldExperiment = this.abTester.tick();
      if (shouldExperiment && !this.activeExperimentId && taskDifficulty !== "trivial") {
        try {
          const exp = await this.abTester.createExperiment({
            name: `routing-experiment-${Date.now()}`,
            hypothesis: "Difficulty-aware routing performs better than random assignment",
            controlStrategy: "difficultyRouter recommendation",
            treatmentStrategy: "cheapest available agent regardless of difficulty",
          });
          this.activeExperimentId = exp.id;
          this.abVariant = "control";
          logger.info("ABTester: new experiment started", { experimentId: exp.id });
        } catch { /* non-critical */ }
      }
    }

    const MAX_LOOPS = 5;
    let loops = 0;
    let consecutiveAssignFailures = 0;

    while (loops < MAX_LOOPS) {
      loops++;
      eventBus.emit({ type: "mediator:thinking", taskId, thought: `Loop ${loops}/${MAX_LOOPS}: building context for decision...` });

      // Build context for mediator
      const context = await this.buildContext(task, memoryContext, loops, routingContext);

      // Ask mediator to decide
      eventBus.emit({ type: "mediator:thinking", taskId, thought: `Asking ${this.config.managerProvider}/${this.config.managerModel} for decision...` });
      let decision: MediatorDecision;
      try {
        decision = await this.askMediator(context, task.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Mediator decision failed", { taskId, error: msg });
        this.taskStore.fail(taskId, msg);
        return { success: false, result: null, summary: msg, artifacts: [], confidence: 0 };
      }

      eventBus.emit({ type: "mediator:decision", taskId, decision });
      eventBus.emit({ type: "mediator:thinking", taskId, thought: `Decision: ${decision.action} (${(decision.confidence * 100).toFixed(0)}%) — ${decision.reasoning.slice(0, 120)}` });
      logger.info(`Mediator decision: ${decision.action}`, { taskId, confidence: decision.confidence, reasoning: decision.reasoning.slice(0, 100) });

      // CausalChain: record this decision
      const causalNode = this.causalChain?.addNode({
        taskId,
        action: decision.action,
        reason: decision.reasoning.slice(0, 200),
        counterfactual: decision.action === "assign" ? `Alternativa: swarm mode místo ${decision.assignment?.agent ?? "?"}` : undefined,
      });

      // ABTester: count task
      this.abTester?.tick();

      // Execute decision — wrapped in try/catch to prevent silent death
      let output: TaskOutput | null;
      try {
        output = await this.executeDecision(task, decision, memoryContext);
      } catch (execErr) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        logger.error("executeDecision threw unexpectedly", { taskId, action: decision.action, error: errMsg });
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `ERROR in executeDecision: ${errMsg.slice(0, 150)}` });
        task.lastError = errMsg;
        continue; // retry the mediator loop instead of silently dying
      }

      if (output !== null) {
        // Track consecutive assign failures — after 2, force the mediator to change strategy
        if (decision.action === "assign" && !output.success) {
          consecutiveAssignFailures++;
          task.attempts++;
          if (consecutiveAssignFailures >= 2) {
            // After 2 failures, inject error context to force strategy change
            const isTimeout = output.summary?.includes("timeout") || output.summary?.includes("CLI exited");
            if (isTimeout) {
              task.lastError = `CRITICAL: Agent timed out ${consecutiveAssignFailures}× in a row. The task is too complex for a single agent call. You MUST either: (1) use action="decompose" to split into smaller subtasks, (2) use action="complete" to answer from your own knowledge, or (3) use action="fail" if the task cannot be done. Do NOT use action="assign" again.`;
              logger.warn("Consecutive assign timeouts — forcing strategy change", { taskId, failures: consecutiveAssignFailures });
              eventBus.emit({ type: "mediator:thinking", taskId, thought: `${consecutiveAssignFailures} consecutive assign failures — forcing strategy change` });
              continue; // retry with the error context
            }
          }
          if (task.attempts >= task.maxAttempts) {
            // Max attempts reached — return the failure
            this.taskStore.complete(taskId, output);
            return output;
          }
        } else if (decision.action === "assign" && output.success) {
          consecutiveAssignFailures = 0; // reset on success
        }

        // UncertaintyEngine: recommend action based on confidence
        const ueAction = this.uncertaintyEngine?.recommendAction(output.confidence, task.attempts, task.maxAttempts);

        // Update CausalChain outcome
        if (causalNode) {
          this.causalChain?.updateOutcome(causalNode.id, taskId, output.success ? "success" : "failure");
        }

        if (output.success || decision.action === "fail") {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: output.success ? `Task completed with confidence ${(output.confidence * 100).toFixed(0)}%` : `Task failed: ${output.summary?.slice(0, 100) ?? "unknown reason"}` });
          this.taskStore.complete(taskId, output);
          if (this.memory) this.memory.learn(task, output).catch(e => logger.debug("memory.learn failed", { error: String(e) }));
          // Persist causal chain async
          this.causalChain?.persist(taskId).catch(e => logger.debug("causalChain.persist failed", { error: String(e) }));
          // Record outcome in DifficultyRouter for performance learning
          if (this.difficultyRouter && decision.assignment?.agent) {
            const taskType = task.tags[0] ?? "general";
            this.difficultyRouter.recordOutcome(decision.assignment.agent, taskType, output.success, task.estimatedCost).catch(e => logger.debug("recordOutcome failed", { error: String(e) }));
          }
          // Record in ABTester if experiment is active
          if (this.abTester && this.activeExperimentId) {
            this.abTester.recordResult(this.activeExperimentId, this.abVariant, {
              success: output.success, cost: task.estimatedCost,
              latencyMs: task.completedAt && task.startedAt ? task.completedAt.getTime() - task.startedAt.getTime() : 0,
              confidence: output.confidence,
            }).catch(e => logger.debug("abTester.recordResult failed", { error: String(e) }));
            // Alternate variant for next task
            this.abVariant = this.abVariant === "control" ? "treatment" : "control";
          }
          // Reflect on completed task — async, don't block response
          if (this.reflectionBank) {
            this.reflectionBank.reflect(task, output).catch(err =>
              logger.debug("ReflectionBank.reflect failed", { error: String(err) })
            );
          }
          // Auto-learn cycle: consolidate + distill every 10 completed tasks
          this.completedTaskCount++;
          if (this.completedTaskCount % 10 === 0) {
            this.autoLearnCycle().catch(e => logger.debug("Auto-learn cycle failed", { error: String(e) }));
          }
          return output;
        }

        // If not successful — check UncertaintyEngine recommendation
        if (ueAction === "verify" && task.attempts < task.maxAttempts) {
          logger.info("UncertaintyEngine: verify — retrying", { taskId, confidence: output.confidence, attempt: task.attempts });
          task.lastError = output.summary || "Low confidence — verification needed";
          continue;
        }
        if (ueAction === "ask_user") {
          logger.info("UncertaintyEngine: ask_user — low confidence", { taskId, confidence: output.confidence });
          // Fall through to complete with low confidence
        }

        // Backward compat: retry on low confidence
        if (decision.confidence < 0.5 && task.attempts < task.maxAttempts && ueAction !== "abort") {
          logger.info("Low confidence, retrying with different approach", { taskId, confidence: decision.confidence });
          task.lastError = output.summary || "Low confidence — retrying with different approach";
          continue;
        }

        this.taskStore.complete(taskId, output);
        if (this.memory) this.memory.learn(task, output).catch(e => logger.debug("memory.learn failed", { error: String(e) }));
        this.causalChain?.persist(taskId).catch(e => logger.debug("causalChain.persist failed", { error: String(e) }));
        if (this.reflectionBank) {
          this.reflectionBank.reflect(task, output).catch(err =>
            logger.debug("ReflectionBank.reflect failed", { error: String(err) })
          );
        }
        return output;
      }
    }

    const failOutput: TaskOutput = {
      success: false,
      result: null,
      summary: "Max mediator loops reached without resolution",
      artifacts: [],
      confidence: 0,
    };
    this.taskStore.complete(taskId, failOutput);
    // SECURITY: SEC-25 — Revoke task-scoped tokens on completion
    credentialLifecycle.revokeTaskTokens(taskId);
    return failOutput;
  }

  /** Ask the mediator LLM for a decision, with automatic fallback to GPT on rate limit */
  private async askMediator(context: string, taskId: string): Promise<MediatorDecision> {
    const MAX_PARSE_RETRIES = 2;

    // Build fallback chain: primary provider first, then others.
    // Each provider uses its OWN configured model (never mix provider+model from another).
    const primaryProvider = this.config.managerProvider ?? "claude";
    // Build fallback chain: custom providers first (user explicitly configured), then built-in.
    // This matches agent-pool.ts fallback order — custom before disabled built-in.
    const allProviders: Array<{ provider: string; model: string }> = [];
    const customProviders = this.config.customProviders ?? {};
    for (const [name, cpCfg] of Object.entries(customProviders)) {
      if (cpCfg.enabled && cpCfg.baseUrl) {
        allProviders.push({ provider: name, model: cpCfg.model });
      }
    }
    allProviders.push(
      { provider: "claude", model: this.config.agents.claude.model },
      { provider: "gpt",    model: this.config.agents.gpt.model },
      { provider: "gemini", model: this.config.agents.gemini.model },
    );
    // Primary provider: use managerModel (config ensures it matches the provider)
    const primaryEntry = allProviders.find(p => p.provider === primaryProvider);
    if (primaryEntry && this.config.managerModel) {
      primaryEntry.model = this.config.managerModel;
    }
    const providerChain = primaryEntry
      ? [primaryEntry, ...allProviders.filter(p => p.provider !== primaryProvider)]
      : allProviders;

    for (const { provider, model } of providerChain) {
      // Skip unavailable or rate-limited providers (primary is always tried unless rate-limited)
      if (provider !== primaryProvider) {
        const agentProfile = this.pool.getAgent(provider);
        if (!agentProfile?.available || this.pool.isRateLimited(provider)) continue;
      } else if (this.pool.isRateLimited(provider)) {
        continue;
      }

      const consciousnessCtx = this.consciousnessProvider ? this.consciousnessProvider() : "";
      const effectiveSystemPrompt = consciousnessCtx
        ? `${this.systemPrompt}\n\n## CONSCIOUSNESS CONTEXT\n\n${consciousnessCtx}`
        : this.systemPrompt;

      for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
        const errorFeedback = attempt > 0
          ? `\n\nIMPORTANT: Your previous response could not be parsed as JSON. Respond with ONLY valid JSON matching the schema. No markdown, no explanation.`
          : "";

        try {
          // SECURITY: SEC-13 — Per-minute LLM call rate check (warn, don't block mediator)
          if (!costTracker.checkCallRate()) {
            logger.warn("SEC-13: Per-minute LLM call rate exceeded — throttling");
          }

          const response = await this.llm.call({
            provider,
            model,
            systemPrompt: effectiveSystemPrompt,
            messages: [{ role: "user", content: context + errorFeedback }],
            responseFormat: "json",
            maxTokens: 16384,
          });

          this.guard.recordCost(response.cost);
          // SECURITY: SEC-13 — Track per-user cost (task-scoped, keyed by taskId root)
          costTracker.recordCost(taskId.split("-")[0] ?? "system", response.cost);
          if (provider !== primaryProvider) {
            logger.info(`Mediator using fallback provider: ${provider}`, { taskId });
          }

          let jsonText = response.content.trim();
          const codeBlockMatch = jsonText.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
          if (codeBlockMatch?.[1]) jsonText = codeBlockMatch[1];

          try {
            const raw = JSON.parse(jsonText) as unknown;
            return MediatorDecisionSchema.parse(raw) as MediatorDecision;
          } catch (parseErr) {
            // Attempt JSON repair for truncated responses
            const repaired = repairTruncatedJson(jsonText);
            if (repaired !== jsonText) {
              try {
                const raw = JSON.parse(repaired) as unknown;
                logger.info("Mediator JSON repaired after truncation", { attempt, provider });
                return MediatorDecisionSchema.parse(raw) as MediatorDecision;
              } catch { /* repair didn't help, fall through */ }
            }
            logger.warn("Failed to parse mediator decision", { attempt, provider, error: String(parseErr) });
            if (attempt === MAX_PARSE_RETRIES) break; // try next provider
          }

        } catch (err) {
          if (err instanceof LLMProviderError) {
            if (err.statusCode === 429) {
              logger.warn(`Mediator: ${provider} rate-limited, switching provider`, { taskId });
              this.pool.markRateLimited(provider);
              break; // break inner loop, try next provider in chain
            }
            if (err.retryable) {
              // Transient API error (overloaded, "API Error:", etc.) — retry same provider
              logger.warn(`Mediator: ${provider} transient error, retrying`, { taskId, error: err.message.slice(0, 150) });
              continue; // retry inner loop (next parse attempt)
            }
          }
          throw err; // non-retryable errors propagate
        }
      }
    }

    throw new Error("All mediator providers exhausted (rate limits or parse failures)");
  }

  /** Execute a mediator decision and return task output (or null if loop should continue) */
  private async executeDecision(task: Task, decision: MediatorDecision, memoryContext: string): Promise<TaskOutput | null> {
    switch (decision.action) {
      case "complete":
        return {
          success: true,
          result: decision.result ?? "Task completed",
          summary: decision.reasoning,
          artifacts: [],
          confidence: decision.confidence,
        };

      case "fail":
        return {
          success: false,
          result: null,
          summary: decision.failReason ?? "Task failed",
          artifacts: [],
          confidence: 0,
        };

      case "assign": {
        if (!decision.assignment) {
          return { success: false, result: null, summary: "Assignment missing from decision", artifacts: [], confidence: 0 };
        }
        logger.info("executeDecision: assign — start", { taskId: task.id, agent: decision.assignment.agent });

        // Track agent assignment so web UI / TUI show the agent name
        this.taskStore.assign(task.id, decision.assignment.agent, decision.assignment.reason);
        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Assigning to ${decision.assignment.agent} — ${decision.assignment.reason.slice(0, 80)}` });

        // Check if a distilled skill exists for this task — inject it into the prompt
        if (this.skillDistiller) {
          try {
            const skills = await this.skillDistiller.listSkills();
            const taskWords = new Set(task.description.toLowerCase().split(/\W+/).filter(w => w.length > 3));
            const matchingSkill = skills.find(skill => {
              const skillWords = skill.name.toLowerCase().split(/\W+/).filter(w => w.length > 3);
              return skillWords.some(w => taskWords.has(w));
            });
            if (matchingSkill) {
              const skillPrompt = this.skillDistiller.getSkillPrompt(matchingSkill, task.description);
              decision.assignment.prompt = `## Proven Skill Available\n${skillPrompt}\n\n## Original Instructions\n${decision.assignment.prompt}`;
              logger.info("Applied distilled skill to assignment", { skillId: matchingSkill.id, skillName: matchingSkill.name, taskId: task.id });
            }
          } catch (skillErr) {
            logger.warn("SkillDistiller.listSkills failed — continuing without skills", { taskId: task.id, error: String(skillErr) });
          }
        }

        logger.info("executeDecision: assign — calling executeWorkerTask", { taskId: task.id, agent: decision.assignment.agent });
        const output = await this.executor.executeWorkerTask(task, decision.assignment, memoryContext);
        logger.info("executeDecision: assign — executeWorkerTask returned", { taskId: task.id, success: output.success, confidence: output.confidence, recoveryStatus: output.recovery?.status });

        // ── Recovery-aware evaluation ──
        // Ingest recovery learnings into reflection bank (no LLM call)
        if (output.recoveryLearnings?.length && this.reflectionBank) {
          for (const learning of output.recoveryLearnings) {
            this.reflectionBank.ingestRecoveryLearning(task, learning).catch(e =>
              logger.debug("ingestRecoveryLearning failed", { error: String(e) })
            );
          }
        }

        if (output.recovery) {
          const { status } = output.recovery;
          if (status === "ESCALATED") {
            // ESCALATED → immediate failure
            logger.info("Recovery: ESCALATED — returning failure", { taskId: task.id });
            return output;
          }
          if (status === "RECOVERED" && output.confidence >= 0.5) {
            // RECOVERED with decent confidence → accept
            logger.info("Recovery: RECOVERED — accepting result", { taskId: task.id, confidence: output.confidence });
            return output;
          }
          if (status === "DEGRADED") {
            if (task.attempts >= task.maxAttempts || output.recovery.nextAgentCanProceed) {
              // DEGRADED but out of retries or next agent can proceed → accept
              logger.info("Recovery: DEGRADED — accepting (out of retries or nextAgentCanProceed)", { taskId: task.id });
              return output;
            }
            // DEGRADED with retries remaining → retry
            logger.info("Recovery: DEGRADED — retrying", { taskId: task.id, attempt: task.attempts });
            task.lastError = `Degraded result (${output.confidence}): ${output.summary}`;
            return null;
          }
        }

        // Standard evaluation (no recovery markers)
        if (output.confidence >= 0.7 || task.attempts >= task.maxAttempts) {
          return output;
        }
        task.lastError = `Low confidence (${output.confidence}): ${output.summary}`;
        return null; // retry
      }

      case "decompose": {
        if (!decision.subtasks || decision.subtasks.length === 0) {
          return { success: false, result: null, summary: "Decompose action with no subtasks", artifacts: [], confidence: 0 };
        }
        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Decomposing into ${decision.subtasks.length} subtasks...` });
        return await this.processDecomposition(task, decision.subtasks, memoryContext);
      }

      case "swarm":
        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: "Activating swarm mode — parallel multi-agent solving" });
        return await this.processSwarm(task, memoryContext);

      case "ask_user":
        logger.info("Mediator asks user", { question: decision.question, taskId: task.id });
        return {
          success: false,
          result: null,
          summary: `Needs user input: ${decision.question ?? "Unknown question"}`,
          artifacts: [],
          confidence: decision.confidence,
        };

      default:
        return null;
    }
  }

  /** Decompose into subtasks and process them */
  private async processDecomposition(
    task: Task,
    subtaskDefs: Array<{ title: string; description: string; suggestedAgent: AgentProvider | null; priority: TaskPriority }>,
    memoryContext: string,
  ): Promise<TaskOutput> {
    logger.info(`Decomposing into ${subtaskDefs.length} subtasks`, { taskId: task.id });

    // SECURITY: SEC-13 — Enforce subtask count limit
    if (!costTracker.checkSubtaskCount(subtaskDefs.length)) {
      return { success: false, result: null, summary: `SEC-13: Subtask count ${subtaskDefs.length} exceeds limit`, artifacts: [], confidence: 0 };
    }

    // SECURITY: SEC-13 — Enforce decomposition depth limit
    // Hard limit of 50 iterations prevents infinite loop if parent chain is circular
    const MAX_PARENT_TRAVERSAL = 50;
    let depth = 0;
    let parent = task.parentId ? this.taskStore.get(task.parentId) : null;
    const visited = new Set<string>();
    while (parent && depth < MAX_PARENT_TRAVERSAL) {
      if (visited.has(parent.id)) {
        logger.error("Circular parent chain detected in task decomposition", { taskId: task.id, loopAt: parent.id });
        break;
      }
      visited.add(parent.id);
      depth++;
      parent = parent.parentId ? this.taskStore.get(parent.parentId) : null;
    }
    if (!costTracker.checkDecompositionDepth(depth)) {
      return { success: false, result: null, summary: `SEC-13: Decomposition depth ${depth} exceeds limit`, artifacts: [], confidence: 0 };
    }

    task.status = "waiting_subtasks";

    // Phase 1: Validate + create subtasks (sequential — SEC-01 checks, stateful TaskStore operations)
    const validSubtasks: Array<{ subtaskId: string; title: string }> = [];
    const results: TaskOutput[] = [];

    for (const def of subtaskDefs) {
      // SECURITY: SEC-01 — Validate subtask descriptions against parent to prevent
      // injection via LLM-generated subtask descriptions (MAS Hijacking vector)
      const relevance = inputSanitizer.validateSubtaskRelevance(task.description, def.description);
      if (!relevance.valid) {
        logger.warn("Subtask description failed relevance check — skipping", {
          taskId: task.id,
          subtaskTitle: def.title,
          similarity: relevance.similarity,
        });
        results.push({ success: false, result: null, summary: `Subtask "${def.title}" rejected: suspicious description`, artifacts: [], confidence: 0 });
        continue;
      }

      const subtask = this.taskStore.create({
        title: def.title,
        description: def.description,
        parentId: task.id,
        priority: def.priority,
        tags: task.tags,
      });

      // Assign suggested agent if available
      if (def.suggestedAgent) {
        const agent = this.pool.getAgent(def.suggestedAgent);
        if (agent?.available) {
          this.taskStore.assign(subtask.id, def.suggestedAgent, "Mediator suggested");
        }
      }

      validSubtasks.push({ subtaskId: subtask.id, title: def.title });
    }

    // Phase 2: Execute processTask() calls in parallel with concurrency limit
    const concurrencyLimit = this.config.queue.maxConcurrentTasks;
    for (let i = 0; i < validSubtasks.length; i += concurrencyLimit) {
      const batch = validSubtasks.slice(i, i + concurrencyLimit);
      const settled = await Promise.allSettled(
        batch.map(({ subtaskId }) => this.processTask(subtaskId)),
      );
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j]!;
        const title = batch[j]!.title;
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          logger.error("Subtask failed unexpectedly", { subtaskId: batch[j]!.subtaskId, title, error: errMsg });
          results.push({ success: false, result: null, summary: `Subtask "${title}" selhal: ${errMsg}`, artifacts: [], confidence: 0 });
        }
      }
    }

    const allSuccess = results.every(r => r.success);
    const avgConfidence = results.length > 0 ? results.reduce((s, r) => s + r.confidence, 0) / results.length : 0;

    return {
      success: allSuccess,
      result: results.map(r => r.result).filter(Boolean),
      summary: `Completed ${results.filter(r => r.success).length}/${results.length} subtasks`,
      artifacts: results.flatMap(r => r.artifacts),
      confidence: Math.min(avgConfidence * 0.9, 1.0), // slight confidence penalty for decomposed tasks
    };
  }

  /** Swarm mode: run multiple agents in parallel and synthesize */
  private async processSwarm(task: Task, memoryContext: string): Promise<TaskOutput> {
    logger.info("Activating swarm mode", { taskId: task.id });

    const availableAgents = this.pool.getAvailableAgents();
    const swarmAgents = availableAgents.slice(0, 3);

    if (swarmAgents.length === 0) {
      return { success: false, result: null, summary: "No agents available for swarm", artifacts: [], confidence: 0 };
    }

    // Run all agents in parallel with different temperatures
    const swarmPromises = swarmAgents.map((agent, i) =>
      this.executor.executeWorkerTask(
        task,
        {
          agent: agent.provider,
          reason: `Swarm agent ${i + 1} of ${swarmAgents.length}`,
          prompt: `[SWARM MODE - Approach ${i + 1}] Use a ${["methodical", "creative", "critical"][i % 3]} approach.\n${task.description}`,
        },
        memoryContext,
      )
    );

    const swarmResults = await Promise.allSettled(swarmPromises);
    const successes = swarmResults
      .filter((r): r is PromiseFulfilledResult<TaskOutput> => r.status === "fulfilled" && r.value.success)
      .map(r => r.value);

    if (successes.length === 0) {
      return { success: false, result: null, summary: "All swarm agents failed", artifacts: [], confidence: 0 };
    }

    // Sanitize agent outputs before synthesis to prevent cross-agent injection
    const wrapResults = await Promise.allSettled(
      successes.map((r, i) => this.guard.wrapExternalData(String(r.result), `swarm_agent_${i + 1}`, task.id))
    );
    const wrappedSolutions = wrapResults
      .map((r, i) => r.status === "fulfilled" ? r.value : `[Agent ${i + 1} result unavailable]`);

    const synthesisPrompt = `Multiple agents independently solved this problem:\n\n${
      wrappedSolutions.map((sol, i) => `## Solution ${i + 1}\n${sol}`).join("\n\n")
    }\n\n## Your Task\nSynthesize these solutions into the best possible answer. Take the strongest elements from each. Output the synthesized solution.`;

    const synthesis = await this.llm.quickClaude(
      "You are an expert synthesizer. Combine multiple solutions into the optimal answer.",
      synthesisPrompt,
      this.config.managerModel,
    );

    this.guard.recordCost(synthesis.cost);

    return {
      success: true,
      result: synthesis.content,
      summary: `Swarm mode: synthesized ${successes.length} solutions`,
      artifacts: successes.flatMap(r => r.artifacts),
      confidence: successes.length > 0 ? Math.max(...successes.map(r => r.confidence)) * 0.95 : 0,
    };
  }

  /** Build context string for mediator decision */
  private async buildContext(task: Task, memoryContext: string, loop: number, routingContext = ""): Promise<string> {
    const parts: string[] = [];

    // SECURITY: SEC-01 — Wrap task description with trust boundary
    // Task title/description come from TRUSTED_USER (via platform handler)
    const taskSection = [
      `## Task (Loop ${loop})`,
      `**ID:** ${task.id}`,
      `**Title:** ${task.title}`,
      `**Description:** ${task.description}`,
      `**Priority:** ${task.priority}`,
      `**Attempts:** ${task.attempts}/${task.maxAttempts}`,
    ].join("\n");
    parts.push(wrapWithBoundary(taskSection, "TRUSTED_USER", "user_task"));

    // Conversation history — presented as a clearly labeled section so the mediator
    // understands what the user was talking about in previous messages.
    const convHistory = typeof task.input?.conversationHistory === "string" ? task.input.conversationHistory : "";
    if (convHistory) {
      parts.push(wrapWithBoundary(
        `## Previous Conversation\nThe user is continuing an ongoing conversation. Use this history to understand references like "previous", "that", "it", etc.\n${convHistory}`,
        "SYSTEM", "conversation_history",
      ));
    }

    // User preferences from PreferenceMemory
    const userPrefs = typeof task.input?.userPreferences === "string" ? task.input.userPreferences : "";
    if (userPrefs) {
      parts.push(wrapWithBoundary(`## User Preferences\n${userPrefs}`, "SYSTEM", "user_preferences"));
    }

    if (task.lastError) {
      // SECURITY: SEC-01 — Error messages could contain injected content
      parts.push(wrapWithBoundary(`## Previous Error\n${task.lastError}`, "TOOL_OUTPUT", "error_context"));
    }

    if (task.subtaskIds.length > 0) {
      const subtasks = task.subtaskIds.map(id => {
        const st = this.taskStore.get(id);
        return st ? `- ${st.title}: ${st.status}` : null;
      }).filter(Boolean);
      parts.push(`\n## Subtasks\n${subtasks.join("\n")}`);
    }

    if (memoryContext) {
      // SECURITY: SEC-01 — Memory context is SYSTEM-trusted (internally generated)
      parts.push(wrapWithBoundary(`## Memory Context\n${memoryContext}`, "SYSTEM", "memory_context"));
    }

    if (routingContext) {
      parts.push(routingContext);
    }

    // Inject past reflections — close the learning loop
    if (this.reflectionBank) {
      const reflectionCtx = await this.reflectionBank.getContextString(task.description);
      if (reflectionCtx) {
        parts.push(`\n${reflectionCtx}`);
      }
    }

    const stats = this.taskStore.getStats();
    parts.push(`\n## Session Stats\nTotal cost: $${stats.totalCost.toFixed(4)}`);
    parts.push(`\n## Available Agents\n${this.pool.getSummary()}`);
    parts.push(`\n## Decision Required\nAnalyze the task above and decide the best action. Respond with ONLY the JSON decision.`);

    return parts.join("\n");
  }
}
