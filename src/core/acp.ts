// ═══════════════════════════════════════════════════════════════
// PEPAGI — Agent Client Protocol (ACP v1.0)
// Standardizes the request/response envelope between the Mediator
// and Worker agents. Makes worker communication explicit,
// auditable, and future-proof (HTTP transport, message queues).
//
// Current mode: in-process (direct function call)
// Future mode: HTTP/gRPC/WebSocket transport layer
// ═══════════════════════════════════════════════════════════════
// DEAD-02: ACP (Agent Client Protocol) is defined here as forward-looking infrastructure
// for a future peer-to-peer agent mesh protocol. WorkerExecutor currently calls LLMProvider
// directly; ACP will be wired in when the mesh networking layer is added.
// See roadmap: https://github.com/pepagi/pepagi/issues/TBD

import { nanoid } from "nanoid";
import type { AgentProvider, TaskPriority } from "./types.js";

export const ACP_VERSION = "1.0" as const;

// ─── ACP Request ──────────────────────────────────────────────

export interface ACPRequest {
  /** Unique request ID for tracing and deduplication */
  requestId: string;
  /** Protocol version */
  version: typeof ACP_VERSION;
  /** ISO timestamp when request was created */
  timestamp: string;

  /** Task information */
  task: {
    id: string;
    title: string;
    description: string;
    priority: TaskPriority;
    parentTaskId: string | null;
  };

  /** Context injected into the worker's prompt */
  context: {
    /** Relevant memory context (episodic, semantic, procedural summaries) */
    memoryContext: string;
    /** Conversation history if applicable */
    conversationContext: string;
  };

  /** Execution parameters */
  execution: {
    /** Which agent provider to use */
    agentProvider: AgentProvider;
    /** Specific model name */
    model: string;
    /** System prompt for the worker */
    systemPrompt: string;
    /** Mediator's instruction to the worker */
    workerPrompt: string;
    /** Max output tokens */
    maxTokens: number;
    /** Whether to run in agentic mode (with tools) */
    agenticMode: boolean;
    /** Max agentic turns */
    agenticMaxTurns: number;
    /** Response format preference */
    responseFormat: "text" | "json";
  };

  /** Arbitrary metadata for extensions */
  metadata: Record<string, unknown>;
}

// ─── ACP Response ─────────────────────────────────────────────

export interface ACPResponse {
  /** Matches the requestId from ACPRequest */
  requestId: string;
  /** Protocol version */
  version: typeof ACP_VERSION;
  /** ISO timestamp when response was created */
  timestamp: string;

  /** Execution status */
  status: "success" | "failure" | "partial";

  /** Worker output */
  output: {
    /** Full raw content from the worker */
    content: string;
    /** Confidence score 0–1 */
    confidence: number;
    /** Short summary of what was done */
    summary: string;
  };

  /** Resource usage for cost tracking */
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  };

  /** Which agent produced this response */
  agent: {
    provider: AgentProvider;
    model: string;
  };

  /** Error message if status !== "success" */
  error?: string;
}

// ─── Factory functions ────────────────────────────────────────

/**
 * Create a standardized ACP request envelope.
 */
export function createACPRequest(params: {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  taskPriority: TaskPriority;
  parentTaskId: string | null;
  memoryContext: string;
  conversationContext: string;
  agentProvider: AgentProvider;
  model: string;
  systemPrompt: string;
  workerPrompt: string;
  maxTokens: number;
  agenticMode: boolean;
  agenticMaxTurns: number;
  responseFormat?: "text" | "json";
  metadata?: Record<string, unknown>;
}): ACPRequest {
  return {
    requestId: nanoid(),
    version: ACP_VERSION,
    timestamp: new Date().toISOString(),
    task: {
      id: params.taskId,
      title: params.taskTitle,
      description: params.taskDescription,
      priority: params.taskPriority,
      parentTaskId: params.parentTaskId,
    },
    context: {
      memoryContext: params.memoryContext,
      conversationContext: params.conversationContext,
    },
    execution: {
      agentProvider: params.agentProvider,
      model: params.model,
      systemPrompt: params.systemPrompt,
      workerPrompt: params.workerPrompt,
      maxTokens: params.maxTokens,
      agenticMode: params.agenticMode,
      agenticMaxTurns: params.agenticMaxTurns,
      responseFormat: params.responseFormat ?? "text",
    },
    metadata: params.metadata ?? {},
  };
}

/**
 * Create a success ACP response.
 */
export function createACPResponse(
  requestId: string,
  agentProvider: AgentProvider,
  model: string,
  content: string,
  confidence: number,
  summary: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number },
): ACPResponse {
  return {
    requestId,
    version: ACP_VERSION,
    timestamp: new Date().toISOString(),
    status: "success",
    output: { content, confidence, summary },
    usage,
    agent: { provider: agentProvider, model },
  };
}

/**
 * Create a failure ACP response.
 */
export function createACPErrorResponse(
  requestId: string,
  agentProvider: AgentProvider,
  model: string,
  error: string,
): ACPResponse {
  return {
    requestId,
    version: ACP_VERSION,
    timestamp: new Date().toISOString(),
    status: "failure",
    output: { content: "", confidence: 0, summary: `Selhání: ${error}` },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
    agent: { provider: agentProvider, model },
    error,
  };
}

/**
 * Validate that an ACP request has all required fields.
 * Returns list of validation errors, or empty array if valid.
 */
export function validateACPRequest(req: Partial<ACPRequest>): string[] {
  const errors: string[] = [];
  if (!req.requestId) errors.push("Chybí requestId");
  if (!req.version) errors.push("Chybí version");
  if (!req.task?.id) errors.push("Chybí task.id");
  if (!req.task?.title) errors.push("Chybí task.title");
  if (!req.execution?.agentProvider) errors.push("Chybí execution.agentProvider");
  if (!req.execution?.model) errors.push("Chybí execution.model");
  if (!req.execution?.systemPrompt) errors.push("Chybí execution.systemPrompt");
  return errors;
}
