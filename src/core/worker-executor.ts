// ═══════════════════════════════════════════════════════════════
// PEPAGI — Worker Task Executor
// ═══════════════════════════════════════════════════════════════

import type { Task, TaskOutput, AgentProvider, DifficultyLevel } from "./types.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import { LLMProviderError } from "../agents/llm-provider.js";
import type { SecurityGuard } from "../security/security-guard.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { AgentPool } from "../agents/agent-pool.js";
import { buildWorkerSystemPrompt, type PersonaProfile } from "./mediator-prompt.js";
import { Logger } from "./logger.js";
import { eventBus } from "./event-bus.js";
// SECURITY: SEC-01 — Context boundary enforcement for worker prompts
import { wrapWithBoundary } from "../security/context-boundary.js";
// SECURITY: SEC-34 — Output sanitization for LLM responses
import { sanitizeForPlatform } from "../security/output-sanitizer.js";
// SECURITY: Task content guard — defense-in-depth for system file access
import { scanTaskContent, scanOutputForLeaks, logContentGuardViolation } from "../security/task-content-guard.js";

/** Fallback max time — actual timeout comes from getAgentBudget() per-task */
const MAX_AGENT_TIMEOUT_MS = 600_000;

const logger = new Logger("WorkerExecutor");

const AGENT_STRENGTHS: Record<AgentProvider, string> = {
  claude: "Deep reasoning, code generation, analysis, nuanced understanding",
  gpt: "Structured output, broad knowledge, instruction following",
  gemini: "Long context processing, multimodal analysis, speed",
  ollama: "Local model, privacy-first, zero API cost, works offline",
  lmstudio: "Local model via LM Studio, privacy-first, zero API cost, works offline",
};

/**
 * Budget table driven by DifficultyLevel from DifficultyRouter.
 * Single source of truth for all agent resource limits.
 *
 * | Difficulty | maxTokens | agenticMaxTurns | timeoutMs |
 * |-----------|-----------|-----------------|-----------|
 * | trivial   |     2048  |        5        |    60s    |
 * | simple    |     4096  |       15        |   180s    |
 * | medium    |    16384  |       30        |   360s    |
 * | complex   |    32768  |       50        |   600s    |
 * | unknown   |    16384  |       30        |   360s    |
 */
const DIFFICULTY_BUDGETS: Record<DifficultyLevel, { maxTokens: number; agenticMaxTurns: number; timeoutMs: number }> = {
  trivial:  { maxTokens:  2048, agenticMaxTurns:  5, timeoutMs:  60_000 },
  simple:   { maxTokens:  4096, agenticMaxTurns: 15, timeoutMs: 180_000 },
  medium:   { maxTokens: 16384, agenticMaxTurns: 30, timeoutMs: 360_000 },
  complex:  { maxTokens: 32768, agenticMaxTurns: 50, timeoutMs: 600_000 },
  unknown:  { maxTokens: 16384, agenticMaxTurns: 30, timeoutMs: 360_000 },
};

// Keywords that indicate real tool work (promotes difficulty if task is trivial/simple)
const TOOL_KEYWORDS_ASCII = /\b(code|file|script|install|deploy|build|test|write|create|fix|debug|web|fetch|bash|run|execute|generate|implement|analyze|search|download|edit|refactor|configure|setup|server|bug|error|compile|pdf|report)\b/i;
const TOOL_KEYWORDS_CZECH = /(?:^|\W)(soubor|napiš|vytvoř|oprav|spusť|najdi|stáhni|kód|skript|projekt|chybu?|bug|sestav|kompiluj|uprav|přepiš|vylepši|analyzuj|prozkoumej|projdi|zkontroluj)(?:$|\W)/i;

/**
 * Determine agent resource budget from task difficulty + config overrides.
 *
 * Uses task.difficulty (set by DifficultyRouter in mediator) as primary input.
 * Promotes budget if keyword analysis suggests the task needs tools but
 * was classified too low (e.g. short Czech message about a complex coding task).
 */
function getAgentBudget(task: Task, configOverride?: { maxAgenticTurns?: number; maxOutputTokens?: number }): { maxTokens: number; agenticMaxTurns: number; timeoutMs: number } {
  // Config override — when user sets explicit limits in agent profile, use those
  if (configOverride?.maxAgenticTurns && configOverride.maxAgenticTurns > 0) {
    return {
      maxTokens: configOverride.maxOutputTokens ?? 16384,
      agenticMaxTurns: configOverride.maxAgenticTurns,
      timeoutMs: Math.min(Math.max(configOverride.maxAgenticTurns * 20_000, 20_000), 600_000),
    };
  }

  let difficulty = task.difficulty ?? "unknown";

  // Safety net: if DifficultyRouter classified as trivial/simple but the task
  // clearly needs tools (coding keywords), promote to at least "medium".
  // This catches short Czech messages like "najdi chybu v kódu" (5 words, 0
  // English technical terms → trivial) that actually need full agent capabilities.
  if (difficulty === "trivial" || difficulty === "simple") {
    const text = `${task.title} ${task.description}`;
    const needsTools = TOOL_KEYWORDS_ASCII.test(text) || TOOL_KEYWORDS_CZECH.test(text);
    if (needsTools) {
      difficulty = "medium";
    }
  }

  return DIFFICULTY_BUDGETS[difficulty];
}

/** Extract confidence score from worker output */
function extractConfidence(output: string): number {
  const match = output.match(/CONFIDENCE:\s*([\d.]+)/);
  if (match && match[1]) {
    const val = parseFloat(match[1]);
    if (!isNaN(val)) return Math.min(1, Math.max(0, val));
  }
  return 0.7; // default
}

/** Extract summary from worker output */
function extractSummary(output: string): string {
  const summaryMatch = output.match(/---SUMMARY---\n([\s\S]*?)(?:\nCONFIDENCE:|$)/);
  if (summaryMatch && summaryMatch[1]) return summaryMatch[1].trim();
  // Fallback: first 200 chars
  return output.slice(0, 200).trim();
}

/** Get content before the summary section */
function extractResult(output: string): string {
  const sepIdx = output.indexOf("---SUMMARY---");
  return sepIdx >= 0 ? output.slice(0, sepIdx).trim() : output.trim();
}

export class WorkerExecutor {
  /** Track running executions so we can abort them. Key = taskId */
  private runningTasks = new Map<string, { agent: AgentProvider; abortController: AbortController; startedAt: number }>();

  constructor(
    private llm: LLMProvider,
    private guard: SecurityGuard,
    private tools: ToolRegistry,
    private pool: AgentPool,
    private profile?: PersonaProfile,
  ) {}

  /** Kill a running agent execution. Aborts the child process via AbortController. */
  killAgent(provider: AgentProvider): boolean {
    for (const [taskId, entry] of this.runningTasks) {
      if (entry.agent === provider && !entry.abortController.signal.aborted) {
        logger.warn(`Killing agent ${provider} on task ${taskId}`);
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent ${provider} killed by user` });
        entry.abortController.abort();
        return true;
      }
    }
    return false;
  }

  /** Get info about running tasks per agent */
  getRunningTasks(): Array<{ taskId: string; agent: AgentProvider; startedAt: number }> {
    return [...this.runningTasks.entries()]
      .filter(([, e]) => !e.abortController.signal.aborted)
      .map(([taskId, e]) => ({ taskId, agent: e.agent, startedAt: e.startedAt }));
  }

  /**
   * Execute a task on a worker agent.
   * @param task - The task to execute
   * @param assignment - Agent and prompt from mediator's decision
   * @param memoryContext - Relevant context from memory system
   */
  async executeWorkerTask(
    task: Task,
    assignment: { agent: AgentProvider; reason: string; prompt: string },
    memoryContext = "",
  ): Promise<TaskOutput> {
    const { prompt } = assignment;

    // ── SECURITY: Defense-in-depth — block system file access ──
    // Even if mediator missed it, refuse before calling external agent.
    const contentCheck = scanTaskContent(`${task.title} ${task.description} ${prompt}`);
    if (contentCheck.blocked) {
      logContentGuardViolation(`${task.title} ${task.description}`, contentCheck, task.id, "worker");
      return { success: false, result: null, summary: `Security: ${contentCheck.reason}`, artifacts: [], confidence: 0 };
    }

    logger.info("executeWorkerTask: starting", { taskId: task.id, preferredAgent: assignment.agent, reason: assignment.reason.slice(0, 100) });

    // Build fallback chain: preferred agent → gpt → gemini → claude
    const fallbackChain = this.pool.getFallbackChain(assignment.agent);
    if (fallbackChain.length === 0) {
      logger.warn("executeWorkerTask: no agents in fallback chain", { taskId: task.id, preferredAgent: assignment.agent });
      eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: "No agents available in fallback chain — cannot execute" });
      return { success: false, result: null, summary: "No agents available", artifacts: [], confidence: 0 };
    }

    // Determine resource budget from DifficultyRouter classification + config overrides
    const preferredProfile = this.pool.getAgent(assignment.agent);
    const configOverride = preferredProfile ? {
      maxAgenticTurns: preferredProfile.maxAgenticTurns ?? 0,
      maxOutputTokens: preferredProfile.maxOutputTokens ?? 0,
    } : undefined;
    const { maxTokens, agenticMaxTurns, timeoutMs } = getAgentBudget(task, configOverride);
    logger.info("executeWorkerTask: budget", { taskId: task.id, difficulty: task.difficulty, maxTokens, agenticMaxTurns, timeoutSec: timeoutMs / 1000, fallbackChain });

    // SECURITY: SEC-01 — Wrap each context segment with trust-level boundaries
    const convHistory = typeof task.input?.conversationHistory === "string" ? task.input.conversationHistory : "";
    const userMessage = [
      memoryContext ? wrapWithBoundary(`## Relevant Context\n${memoryContext}`, "SYSTEM", "memory_context") + "\n\n" : "",
      convHistory ? wrapWithBoundary(`## Previous Conversation\n${convHistory}`, "SYSTEM", "conversation_history") + "\n\n" : "",
      wrapWithBoundary(`## Task\n${task.title}\n\n${task.description}`, "TRUSTED_USER", "user_task") + "\n\n",
      wrapWithBoundary(`## Worker Instructions\n${prompt}`, "SYSTEM", "mediator_instruction"),
    ].filter(Boolean).join("");

    for (const agent of fallbackChain) {
      const agentProfile = this.pool.getAgent(agent);
      if (!agentProfile?.available || this.pool.isRateLimited(agent)) {
        const reason = !agentProfile?.available ? "unavailable" : "rate-limited";
        logger.info(`executeWorkerTask: skipping ${agent} (${reason})`, { taskId: task.id });
        continue;
      }

      logger.info(`Assigning task to ${agent}`, { taskId: task.id, reason: assignment.reason });
      eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Worker starting on ${agent} (${agenticMaxTurns} max turns, ${maxTokens} max tokens)...` });
      this.pool.incrementLoad(agent);
      // AbortController for kill support — aborts child process when triggered
      const abortController = new AbortController();
      this.runningTasks.set(task.id, { agent, abortController, startedAt: Date.now() });

      // Auto-timeout: abort after difficulty-based timeout (with MAX_AGENT_TIMEOUT_MS cap)
      const effectiveTimeout = Math.min(timeoutMs, MAX_AGENT_TIMEOUT_MS);
      const timeoutId = setTimeout(() => {
        if (!abortController.signal.aborted) {
          logger.warn(`Agent ${agent} timed out after ${effectiveTimeout / 1000}s`, { taskId: task.id });
          eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Agent ${agent} timed out after ${effectiveTimeout / 1000}s — aborting` });
          abortController.abort();
        }
      }, effectiveTimeout);

      // Claude runs in agentic mode with real tools; others (GPT, Gemini, Ollama) are text-only.
      const useAgenticMode = agent === "claude";
      const systemPrompt = buildWorkerSystemPrompt(task.title, AGENT_STRENGTHS[agent], useAgenticMode, this.profile);

      try {
        logger.info(`executeWorkerTask: calling LLM`, { taskId: task.id, agent, model: agentProfile.model, agenticMode: useAgenticMode, agenticMaxTurns, maxTokens, timeoutSec: timeoutMs / 1000 });
        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Calling ${agent}/${agentProfile.model} (agentic=${useAgenticMode}, turns=${agenticMaxTurns}, timeout=${timeoutMs / 1000}s)...` });

        const response = await this.llm.call({
          provider: agent,
          model: agentProfile.model,
          systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          maxTokens,
          agenticMode: useAgenticMode,
          agenticMaxTurns,
          taskId: task.id,
          abortController,
          timeoutMs,
        });
        clearTimeout(timeoutId);

        this.guard.recordCost(response.cost);
        task.tokensUsed.input += response.usage.inputTokens;
        task.tokensUsed.output += response.usage.outputTokens;
        task.estimatedCost += response.cost;

        // SECURITY: SEC-34 — Sanitize LLM output before downstream use
        const sanitizedContent = sanitizeForPlatform(response.content);

        // SECURITY: Output leak scan — detect if agent read system files
        const leakCheck = scanOutputForLeaks(sanitizedContent);
        if (leakCheck.blocked) {
          logContentGuardViolation(sanitizedContent.slice(0, 500), leakCheck, task.id, "output-scan");
          this.pool.decrementLoad(agent);
          this.runningTasks.delete(task.id);
          return { success: false, result: null, summary: `Security: ${leakCheck.reason}`, artifacts: [], confidence: 0 };
        }

        const confidence = extractConfidence(sanitizedContent);
        const summary = extractSummary(sanitizedContent);
        let result = extractResult(sanitizedContent);

        // Fallback: if result is empty but agent worked (cost > 0), use summary or raw content
        if (!result && response.cost > 0) {
          result = summary || sanitizedContent || "Task completed (no text output — agent used tools only)";
          logger.debug("Worker result empty, using fallback", { taskId: task.id, fallbackLen: result.length });
        }

        logger.info(`Worker completed task`, {
          taskId: task.id,
          agent,
          confidence,
          cost: response.cost,
          latencyMs: response.latencyMs,
          toolsUsed: response.toolCalls.map(t => t.name),
        });

        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Worker ${agent} done (confidence: ${(confidence * 100).toFixed(0)}%, cost: $${response.cost.toFixed(4)})` });

        this.pool.decrementLoad(agent);
        this.runningTasks.delete(task.id);
        return { success: true, result, summary, artifacts: [], confidence };

      } catch (err) {
        clearTimeout(timeoutId);
        this.pool.decrementLoad(agent);
        this.runningTasks.delete(task.id);

        const isLLMError = err instanceof LLMProviderError;
        const statusCode = isLLMError ? err.statusCode : 0;
        const msg = err instanceof Error ? err.message : String(err);

        // Rate limit (429) or auth error (401) → try next agent in chain
        if (isLLMError && (statusCode === 429 || statusCode === 401)) {
          const reason = statusCode === 429 ? "rate-limited" : "auth failed (no API key?)";
          logger.warn(`${agent} ${reason}, switching to next agent`, { taskId: task.id, status: statusCode });
          eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `${agent} ${reason} — trying next agent...` });
          if (statusCode === 429) this.pool.markRateLimited(agent);
          continue;
        }

        // Any other error → fail immediately
        logger.error(`Worker execution failed`, { taskId: task.id, agent, error: msg });
        eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `Worker ${agent} failed: ${msg.slice(0, 120)}` });
        return { success: false, result: null, summary: `Task failed: ${msg}`, artifacts: [], confidence: 0 };
      }
    }

    logger.warn("executeWorkerTask: ALL agents exhausted — no agent could handle the task", { taskId: task.id, fallbackChain });
    eventBus.emit({ type: "mediator:thinking", taskId: task.id, thought: `ALL agents exhausted (${fallbackChain.join(", ")}) — returning failure` });
    return { success: false, result: null, summary: "All agents exhausted (rate limits or unavailable)", artifacts: [], confidence: 0 };
  }
}
