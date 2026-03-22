// ═══════════════════════════════════════════════════════════════
// PEPAGI — Unified LLM Provider
// Uses Claude Agent SDK (CLI OAuth) for Claude, direct fetch for others
// ═══════════════════════════════════════════════════════════════

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile as fsReadFile, writeFile as fsWriteFile, readdir } from "node:fs/promises";
import { loadConfig } from "../config/loader.js";
import { duckduckgoSearch } from "../tools/web-search.js";
import { pdfTool } from "../tools/pdf.js";
import { existsSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { calculateCost } from "./pricing.js";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
// SECURITY: SEC-27 — TLS verification on startup
import { checkTLSEnvironment } from "../security/tls-verifier.js";

const logger = new Logger("LLMProvider");

// SECURITY: SEC-27 — Warn if TLS validation is disabled
const tlsCheck = checkTLSEnvironment();
if (!tlsCheck.secure) {
  logger.error(tlsCheck.warning ?? "SEC-27: TLS validation disabled");
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMCallOptions {
  provider: "claude" | "gpt" | "gemini" | "ollama" | "lmstudio" | "kiro";
  model: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  apiKey?: string;
  /** Enable agentic loop: Claude can use Bash/Read/Write/WebFetch and iterate until done */
  agenticMode?: boolean;
  /** Max turns for agentic loop (default 20) */
  agenticMaxTurns?: number;
  /** Task ID for emitting progress events during agentic execution */
  taskId?: string;
  /** AbortController to cancel the running execution (kills child process) */
  abortController?: AbortController;
  /** Timeout in ms for the entire execution — used by CLI spawn and REST API loop */
  timeoutMs?: number;
  /**
   * Tool executor callback — enables agentic tool loop for non-Claude providers.
   * When the LLM returns tool_calls, this function executes them and returns results.
   * The loop continues until the LLM responds with text only (no tool_calls).
   */
  toolExecutor?: (toolName: string, args: Record<string, unknown>, taskId: string) => Promise<{ success: boolean; output: string; error?: string }>;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  cost: number;
  model: string;
  latencyMs: number;
}

export class LLMProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}

/** Sleep helper for retry backoff */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Per-provider flood limiter — tracks recent failures per provider.
 * If > FLOOD_THRESHOLD failures in FLOOD_WINDOW_MS, adds a cooldown
 * to prevent flooding the API with doomed requests.
 * Per-provider tracking prevents one provider's failures from blocking others.
 */
const FLOOD_THRESHOLD = 15;
const FLOOD_WINDOW_MS = 60_000; // 1 minute window
const FLOOD_COOLDOWN_MS = 120_000; // 2 minute forced cooldown
const _floodTimesPerProvider = new Map<string, number[]>();

function checkFloodLimit(provider: string): void {
  const now = Date.now();
  const times = _floodTimesPerProvider.get(provider) ?? [];
  // Prune old entries
  while (times.length > 0 && times[0]! < now - FLOOD_WINDOW_MS) times.shift();
  _floodTimesPerProvider.set(provider, times);
  if (times.length >= FLOOD_THRESHOLD) {
    logger.warn(`[FLOOD] ${provider}: ${times.length} failures in 1 min — forcing ${FLOOD_COOLDOWN_MS / 1000}s cooldown`);
    eventBus.emit({
      type: "system:alert",
      message: `PEPAGI: LLM flood detected for ${provider} (${times.length} failures/min). Cooldown ${FLOOD_COOLDOWN_MS / 1000}s.`,
      level: "warn",
    });
    // Block this fiber — NOT ideal but protects the system
    // We throw a non-retryable error so withRetry gives up immediately
    throw new LLMProviderError(provider as "claude", 429,
      `Flood limit reached for ${provider} (${times.length} failures/min) — forced cooldown ${FLOOD_COOLDOWN_MS / 1000}s`,
      false,
    );
  }
}

function recordFloodFailure(provider: string): void {
  const times = _floodTimesPerProvider.get(provider) ?? [];
  const now = Date.now();
  times.push(now);
  // Prune entries outside the flood window before capping — prevents stale timestamps
  // from occupying space and potentially causing false positives after recovery
  while (times.length > 0 && times[0]! < now - FLOOD_WINDOW_MS) times.shift();
  // AUD-01: defensive cap — prevent unbounded growth in degenerate scenarios
  if (times.length > 200) times.splice(0, times.length - 50);
  _floodTimesPerProvider.set(provider, times);
}

/** Retry with exponential backoff: 3 s → 10 s → 30 s */
async function withRetry<T>(fn: () => Promise<T>, provider: string, maxAttempts = 3): Promise<T> {
  const delays = [3000, 10_000, 30_000];
  let lastErr: Error = new Error("Unknown error");

  // Check flood limit before first attempt
  checkFloodLimit(provider);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Non-retryable errors (e.g. circuit breaker OPEN, auth failure, flood) — fail fast
      if (err instanceof LLMProviderError && !err.retryable) throw err;

      recordFloodFailure(provider);

      if (i < maxAttempts - 1) {
        logger.warn(`[WARN] ${provider} call failed (attempt ${i + 1}/${maxAttempts}), retrying in ${delays[i]! / 1000}s...`, { error: lastErr.message });
        await sleep(delays[i] ?? 30_000);
        // Re-check flood after sleep (situation may have worsened)
        checkFloodLimit(provider);
      } else {
        // Final attempt — log as FATAL so it's visible in logs
        logger.error(`[FATAL] ${provider} call failed (attempt ${i + 1}/${maxAttempts}) — all retries exhausted`, { error: lastErr.message });
      }
    }
  }
  throw lastErr;
}

// ─── Circuit Breaker for Claude Code SDK ─────────────────────
/**
 * Prevents endless retry storms when Claude Code CLI is broken.
 * After THRESHOLD failures → state = "open" → fast-fail for RESET_TIMEOUT ms.
 * After RESET_TIMEOUT ms → state = "half-open" → allow one probe attempt.
 * On probe success → "closed". On probe failure → back to "open".
 */
class ClaudeCodeCircuitBreaker {
  private failures: Date[] = [];
  private state: "closed" | "open" | "half-open" = "closed";
  private lastFailureTime: number | null = null;

  private readonly THRESHOLD = 10;          // failures in window before opening
  private readonly RESET_TIMEOUT = 300_000; // 5 min before trying half-open
  private readonly WINDOW = 600_000;        // 10-min window for counting failures

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const msSinceLastFailure = this.lastFailureTime ? Date.now() - this.lastFailureTime : Infinity;
      if (msSinceLastFailure > this.RESET_TIMEOUT) {
        this.state = "half-open";
        logger.info("Circuit breaker: HALF-OPEN — testuju Claude Code...");
      } else {
        const waitSec = Math.round((this.RESET_TIMEOUT - msSinceLastFailure) / 1000);
        throw new LLMProviderError(
          "claude", 503,
          `Circuit breaker OPEN — Claude Code nedostupný. Reset za ${waitSec}s. ` +
          `Zkontroluj: claude auth status`,
          false, // non-retryable — skip withRetry delays
        );
      }
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    }
  }

  private recordFailure(): void {
    const now = new Date();
    this.failures.push(now);
    this.lastFailureTime = now.getTime();

    // Prune failures outside the window + defensive size cap (AUD-01)
    const cutoff = Date.now() - this.WINDOW;
    this.failures = this.failures.filter(f => f.getTime() > cutoff);
    if (this.failures.length > 50) this.failures = this.failures.slice(-50);

    if (this.failures.length >= this.THRESHOLD && this.state !== "open") {
      this.state = "open";
      const msg =
        `PEPAGI: Claude Code selhává — ${this.failures.length} chyb za posledních 10 minut. ` +
        `Circuit breaker OPEN. Zkontroluj session: \`claude auth status\``;
      logger.error(`[FATAL] Circuit breaker OPEN (${this.failures.length} failures)`, {});
      // Notify via eventBus → Telegram platform will forward this to user
      eventBus.emit({ type: "system:alert", message: msg, level: "critical" });
    }
  }

  private reset(): void {
    if (this.state !== "closed") {
      // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
      logger.info("Circuit breaker: CLOSED — Claude Code is back online");
      eventBus.emit({ type: "system:alert", message: "PEPAGI: Claude Code je zpět online. Circuit breaker CLOSED.", level: "warn" });
    }
    this.failures = [];
    this.state = "closed";
    this.lastFailureTime = null;
  }

  /** Number of failures in the last `windowMs` milliseconds */
  getRecentFailureCount(windowMs = 600_000): number {
    const cutoff = Date.now() - windowMs;
    return this.failures.filter(f => f.getTime() > cutoff).length;
  }

  getState(): "closed" | "open" | "half-open" { return this.state; }

  /** Force reset (e.g. after successful self-heal) */
  forceReset(): void { this.reset(); }
}

/** Exported singleton — Watchdog imports this to monitor Claude Code health */
export const claudeCircuitBreaker = new ClaudeCodeCircuitBreaker();

// ─── Kiro CLI Circuit Breaker ──────────────────────────────────

/**
 * Dedicated circuit breaker for Kiro CLI (ACP) — separate from Claude Code.
 * Same threshold/window/reset pattern as ClaudeCodeCircuitBreaker.
 */
class KiroCircuitBreaker {
  private failures: Date[] = [];
  private state: "closed" | "open" | "half-open" = "closed";
  private lastFailureTime: number | null = null;

  private readonly THRESHOLD = 10;          // failures in window before opening
  private readonly RESET_TIMEOUT = 300_000; // 5 min before trying half-open
  private readonly WINDOW = 600_000;        // 10-min window for counting failures

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const msSinceLastFailure = this.lastFailureTime ? Date.now() - this.lastFailureTime : Infinity;
      if (msSinceLastFailure > this.RESET_TIMEOUT) {
        this.state = "half-open";
        logger.info("Kiro circuit breaker: HALF-OPEN — probing Kiro CLI...");
        eventBus.emit({ type: "system:alert", message: "Kiro CLI recovery probe — circuit breaker HALF-OPEN", level: "warn" });
      } else {
        const waitSec = Math.round((this.RESET_TIMEOUT - msSinceLastFailure) / 1000);
        throw new LLMProviderError(
          "kiro", 503,
          `Circuit breaker OPEN — Kiro CLI unavailable. Reset in ${waitSec}s.`,
          false, // non-retryable
        );
      }
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    }
  }

  private recordFailure(): void {
    const now = new Date();
    this.failures.push(now);
    this.lastFailureTime = now.getTime();

    // Prune failures outside the window + defensive size cap
    const cutoff = Date.now() - this.WINDOW;
    this.failures = this.failures.filter(f => f.getTime() > cutoff);
    if (this.failures.length > 50) this.failures = this.failures.slice(-50);

    if (this.failures.length >= this.THRESHOLD && this.state !== "open") {
      this.state = "open";
      const msg = `Kiro CLI failing — ${this.failures.length} errors in last 10 minutes. Circuit breaker OPEN.`;
      logger.error(`[FATAL] Kiro circuit breaker OPEN (${this.failures.length} failures)`, {});
      eventBus.emit({ type: "system:alert", message: msg, level: "warn" });
    }
  }

  private reset(): void {
    if (this.state !== "closed") {
      logger.info("Kiro circuit breaker: CLOSED — Kiro CLI recovered");
      eventBus.emit({ type: "system:alert", message: "Kiro CLI recovered — circuit breaker CLOSED", level: "warn" });
    }
    this.failures = [];
    this.state = "closed";
    this.lastFailureTime = null;
  }

  /** Number of failures in the last `windowMs` milliseconds */
  getRecentFailureCount(windowMs = 600_000): number {
    const cutoff = Date.now() - windowMs;
    return this.failures.filter(f => f.getTime() > cutoff).length;
  }

  getState(): "closed" | "open" | "half-open" { return this.state; }

  /** Force reset (e.g. after successful recovery) */
  forceReset(): void { this.reset(); }
}

/** Exported singleton — separate from claudeCircuitBreaker */
export const kiroCircuitBreaker = new KiroCircuitBreaker();

// ─── ACP JSON-RPC 2.0 Helpers ─────────────────────────────────

/** Parsed ACP JSON-RPC 2.0 message (response or notification) */
export interface ACPMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Build a JSON-RPC 2.0 request string (newline-terminated).
 * Automatically includes `protocolVersion: 1` for `initialize` requests.
 */
export function acpRequest(id: number, method: string, params: Record<string, unknown> = {}): string {
  const msg: Record<string, unknown> = {
    jsonrpc: "2.0",
    id,
    method,
    params: method === "initialize" ? { protocolVersion: 1, ...params } : params,
  };
  return JSON.stringify(msg) + "\n";
}

// ─── Claude via direct API (when API key is provided) ──────────

/** Build auth headers for Anthropic API — OAuth tokens use Bearer, API keys use x-api-key */
function claudeAuthHeaders(key: string): Record<string, string> {
  const isOAuth = key.startsWith("sk-ant-oat");
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(isOAuth
      ? { Authorization: `Bearer ${key}` }
      : { "x-api-key": key }),
  };
}

async function callClaudeAPI(opts: LLMCallOptions, apiKey: string): Promise<LLMResponse> {
  logger.debug("callClaudeAPI: REST API (text-only, no tools)", { model: opts.model, taskId: opts.taskId });
  const start = performance.now();

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.systemPrompt,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.3,
  };

  if (opts.responseFormat === "json") {
    body.system = `${opts.systemPrompt}\n\nIMPORTANT: Respond with ONLY valid JSON, no other text.`;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: claudeAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new LLMProviderError("claude", res.status, `Claude API error: ${text}`, retryable);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const latencyMs = performance.now() - start;
  const content = data.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  const inputTokens = data.usage.input_tokens;
  const outputTokens = data.usage.output_tokens;
  const cost = calculateCost(opts.model, inputTokens, outputTokens);

  return { content, toolCalls: [], usage: { inputTokens, outputTokens }, cost, model: data.model, latencyMs };
}

// ─── Claude Agentic via REST API (tool_use loop) ─────────────

/** Tool schemas for the Anthropic Messages API */
const AGENTIC_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command and return stdout/stderr. Use for: running scripts, installing packages, searching files, compiling code.",
    input_schema: { type: "object" as const, properties: { command: { type: "string", description: "Shell command to execute" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file at the given path.",
    input_schema: { type: "object" as const, properties: { path: { type: "string", description: "Absolute or relative file path" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates or overwrites).",
    input_schema: { type: "object" as const, properties: { path: { type: "string", description: "File path" }, content: { type: "string", description: "File content" } }, required: ["path", "content"] },
  },
  {
    name: "list_directory",
    description: "List files and directories at the given path.",
    input_schema: { type: "object" as const, properties: { path: { type: "string", description: "Directory path" } }, required: ["path"] },
  },
  {
    name: "web_fetch",
    description: "Fetch content from a URL and return the text body.",
    input_schema: { type: "object" as const, properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] },
  },
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns titles, URLs and snippets. No API key needed. Use this when you need to FIND information online.",
    input_schema: { type: "object" as const, properties: { query: { type: "string", description: "Search query" }, max_results: { type: "number", description: "Maximum number of results (default 10, max 20)" } }, required: ["query"] },
  },
  {
    name: "generate_pdf",
    description: "Generate a PDF document from text/markdown content. Supports headings (#, ##, ###), bullet lists (- or *), numbered lists, tables (|col|), code blocks. Output saved to Desktop by default.",
    input_schema: { type: "object" as const, properties: { content: { type: "string", description: "Text/markdown content for the PDF" }, title: { type: "string", description: "PDF title (optional)" }, filename: { type: "string", description: "Output filename without .pdf extension (optional)" }, path: { type: "string", description: "Full output path (optional, defaults to Desktop)" } }, required: ["content"] },
  },
];

/** Execute a tool locally and return the result string */
async function executeToolLocally(toolName: string, input: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "bash": {
      const cmd = String(input["command"] ?? "");
      if (!cmd) return "Error: empty command";
      return new Promise<string>((resolve) => {
        exec(cmd, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) resolve(`Exit code ${err.code ?? 1}\nstdout: ${stdout.slice(0, 4000)}\nstderr: ${stderr.slice(0, 2000)}`);
          else resolve(stdout.slice(0, 8000) || "(no output)");
        });
      });
    }
    case "read_file": {
      const p = String(input["path"] ?? "");
      if (!p) return "Error: no path";
      try { return (await fsReadFile(p, "utf8")).slice(0, 50_000); }
      catch (e) { return `Error reading ${p}: ${e instanceof Error ? e.message : String(e)}`; }
    }
    case "write_file": {
      const p = String(input["path"] ?? "");
      const c = String(input["content"] ?? "");
      if (!p) return "Error: no path";
      try { await fsWriteFile(p, c, "utf8"); return `Written ${c.length} bytes to ${p}`; }
      catch (e) { return `Error writing ${p}: ${e instanceof Error ? e.message : String(e)}`; }
    }
    case "list_directory": {
      const p = String(input["path"] ?? ".");
      try {
        const entries = await readdir(p, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? "d " : "f "}${e.name}`).join("\n") || "(empty)";
      }
      catch (e) { return `Error listing ${p}: ${e instanceof Error ? e.message : String(e)}`; }
    }
    case "web_fetch": {
      const url = String(input["url"] ?? "");
      if (!url) return "Error: no url";
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        const text = await resp.text();
        return text.slice(0, 20_000);
      }
      catch (e) { return `Error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`; }
    }
    case "web_search": {
      const q = String(input["query"] ?? "");
      if (!q) return "Error: no query provided";
      try {
        const maxResults = typeof input["max_results"] === "number" ? input["max_results"] : 10;
        const results = await duckduckgoSearch(q, maxResults);
        if (results.length === 0) return `No results found for: "${q}"`;
        return results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      }
      catch (e) { return `Error searching "${q}": ${e instanceof Error ? e.message : String(e)}`; }
    }
    case "generate_pdf": {
      const content = String(input["content"] ?? "");
      if (!content) return "Error: no content provided";
      try {
        const args: Record<string, string> = { content };
        if (input["title"]) args.title = String(input["title"]);
        if (input["filename"]) args.filename = String(input["filename"]);
        if (input["path"]) args.path = String(input["path"]);
        const result = await pdfTool.execute(args);
        return result.success ? result.output : `Error: ${result.error ?? "PDF generation failed"}`;
      }
      catch (e) { return `Error generating PDF: ${e instanceof Error ? e.message : String(e)}`; }
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

/** Content block types from Anthropic API */
interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string }
type ContentBlock = TextBlock | ToolUseBlock;
type MessageContent = string | Array<ContentBlock | ToolResultBlock>;

/** Agentic loop via Anthropic REST API with tool_use — no SDK needed */
async function callClaudeAgenticAPI(opts: LLMCallOptions, apiKey: string): Promise<LLMResponse> {
  const start = performance.now();
  const taskId = opts.taskId;
  const maxTurns = opts.agenticMaxTurns ?? 10;

  if (taskId) {
    eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agentic REST API call (max ${maxTurns} turns, tools: bash/read_file/write_file/list_directory/web_fetch/web_search/generate_pdf)` });
  }

  // Build message array for multi-turn conversation
  const messages: Array<{ role: "user" | "assistant"; content: MessageContent }> = opts.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let resultText = "";
  const toolsUsed: string[] = [];
  let turn = 0;

  while (turn < maxTurns) {
    turn++;
    if (taskId) {
      eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent turn ${turn}/${maxTurns}...` });
    }

    // Check abort
    if (opts.abortController?.signal.aborted) {
      throw new LLMProviderError("claude", 499, "Agent aborted by user", false);
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.systemPrompt,
      messages,
      tools: AGENTIC_TOOLS,
      temperature: opts.temperature ?? 0.3,
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: claudeAuthHeaders(apiKey),
      body: JSON.stringify(body),
      signal: opts.abortController?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMProviderError("claude", res.status, `Claude API error: ${text}`, retryable);
    }

    const data = await res.json() as {
      content: ContentBlock[];
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    totalInputTokens += data.usage.input_tokens;
    totalOutputTokens += data.usage.output_tokens;

    // Collect text and tool_use blocks
    const textParts: string[] = [];
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
        if (taskId) {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent [turn ${turn}]: ${block.text.slice(0, 200)}` });
        }
      }
      if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    resultText = textParts.join("\n");

    // If no tool calls — we're done (stop_reason is "tool_use" when tools are requested)
    if (toolUseBlocks.length === 0) {
      if (taskId) {
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent finished (${turn} turns, ${toolsUsed.length} tool calls)` });
      }
      break;
    }

    // Execute each tool call
    // Append assistant message to conversation
    messages.push({ role: "assistant", content: data.content });

    const toolResults: ToolResultBlock[] = [];
    for (const tu of toolUseBlocks) {
      toolsUsed.push(tu.name);
      if (taskId) {
        const inputSummary: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(tu.input)) {
          inputSummary[k] = typeof v === "string" ? v.slice(0, 200) : v;
        }
        eventBus.emit({ type: "tool:call", taskId, tool: tu.name, input: inputSummary });
      }
      // Log tool calls at INFO level so they appear in daemon console
      const detail = tu.name === "bash" ? String(tu.input.command ?? "").slice(0, 150)
        : tu.name === "read_file" ? String(tu.input.path ?? "").slice(0, 150)
        : tu.name === "write_file" ? String(tu.input.path ?? "").slice(0, 100)
        : tu.name === "web_search" ? String(tu.input.query ?? "").slice(0, 100)
        : tu.name === "generate_pdf" ? `title=${String(tu.input.title ?? "")}`.slice(0, 100)
        : JSON.stringify(tu.input).slice(0, 100);
      logger.info(`Agent tool: ${tu.name}`, { taskId, turn, detail });
      if (taskId) {
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `🔧 ${tu.name}: ${detail}` });
      }

      const output = await executeToolLocally(tu.name, tu.input);

      if (taskId) {
        eventBus.emit({ type: "tool:result", taskId, tool: tu.name, success: !output.startsWith("Error"), output: output.slice(0, 200) });
      }

      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }

    // Append tool results as user message
    messages.push({ role: "user", content: toolResults });
  }

  const latencyMs = performance.now() - start;
  const cost = calculateCost(opts.model, totalInputTokens, totalOutputTokens);

  logger.info("Agentic API call completed", { taskId, turns: turn, tools: toolsUsed.length, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cost });

  return {
    content: resultText,
    toolCalls: toolsUsed.map(name => ({ id: name, name, input: {} })),
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    cost,
    model: opts.model,
    latencyMs,
  };
}

// ─── Claude routing ───────────────────────────────────────────

async function callClaude(opts: LLMCallOptions): Promise<LLMResponse> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  // With API key → REST API (fast, reliable, supports tool_use)
  if (apiKey) {
    if (opts.agenticMode) {
      logger.info("Claude agentic → REST API tool_use loop", { taskId: opts.taskId, model: opts.model });
      return callClaudeAgenticAPI(opts, apiKey);
    }
    return callClaudeAPI(opts, apiKey);
  }

  // No API key → use `claude` CLI in --print mode (uses CLI's own OAuth)
  // The CLI handles authentication internally via macOS Keychain / OAuth.
  // The Anthropic REST API does NOT accept OAuth tokens directly.
  logger.debug("Claude → CLI --print mode (no API key, using CLI OAuth)", { taskId: opts.taskId, agentic: !!opts.agenticMode });
  return callClaudeCLI(opts);
}

// ─── Claude CLI --print mode (OAuth, no API key needed) ───────

/**
 * Call Claude via the `claude` CLI binary in --print mode.
 * Uses the CLI's built-in OAuth authentication (macOS Keychain).
 * Works for both agentic (with tools) and non-agentic (text-only) calls.
 * The Anthropic REST API does NOT accept OAuth tokens, so this is the only
 * way to use Claude without a direct API key.
 */
async function callClaudeCLI(opts: LLMCallOptions): Promise<LLMResponse> {
  const start = performance.now();
  const taskId = opts.taskId;
  const isAgentic = opts.agenticMode === true;

  // Build the prompt from messages
  const prompt = opts.messages.map(m => m.content).join("\n\n")
    + (opts.responseFormat === "json" ? "\n\nIMPORTANT: Respond with ONLY valid JSON, no other text." : "");

  // Build CLI arguments
  // Agentic: stream-json + verbose + include-partial-messages → real-time JSONL events
  // Non-agentic: json → single JSON blob at the end (simple, no --verbose needed)
  const useStreamJson = isAgentic;
  const args = [
    "--print",
    "--output-format", useStreamJson ? "stream-json" : "json",
    "--model", opts.model,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];

  if (opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }

  if (isAgentic) {
    args.push("--max-turns", String(opts.agenticMaxTurns ?? 10));
    args.push("--allowedTools", "Bash,Read,Write,Glob,Grep,WebFetch");
    // stream-json requires --verbose with --print.
    // --include-partial-messages enables intermediate events (tool_use, text, tool_result).
    args.push("--verbose", "--include-partial-messages");
  } else {
    // Non-agentic: single turn, ALL tools disabled (prevents accidental tool use)
    args.push("--max-turns", "1");
    args.push("--tools", "");
  }

  // Note: --max-budget-usd omitted — let tasks run to completion within max-turns

  if (taskId) {
    const mode = isAgentic ? `agentic (max ${opts.agenticMaxTurns ?? 10} turns)` : "text-only";
    eventBus.emit({ type: "mediator:thinking", taskId, thought: `Claude CLI: ${mode} on ${opts.model}` });
    logger.info(`callClaudeCLI: ${mode}`, { taskId, model: opts.model, promptLen: prompt.length });
  }

  return new Promise<LLMResponse>((resolve, reject) => {
    // Remove CLAUDECODE env var — prevents "cannot launch inside another Claude Code session" error
    // when daemon is started from within a Claude Code terminal
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;

    // Note: spawn() does NOT support timeout option (only exec/execFile do).
    // We implement our own timeout below with setTimeout + SIGKILL.
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    // Line buffer for JSONL parsing (chunks may split across lines)
    let lineBuf = "";
    // Collect final result from stream-json events
    let streamResult: { result?: string; is_error?: boolean; duration_ms?: number; num_turns?: number; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
    let streamTextParts: string[] = [];

    // Timeout from caller (set by getAgentBudget() via DifficultyRouter) or fallback
    const timeoutMs = opts.timeoutMs ?? (isAgentic ? 360_000 : 60_000);
    const timeoutSec = Math.round(timeoutMs / 1000);

    const spawnTimeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        logger.warn(`callClaudeCLI: spawn timeout (${timeoutSec}s) — killing child process`, { taskId, timeoutSec });
        if (taskId) {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `CLI spawn timeout (${timeoutSec}s) — killing process` });
        }
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      // Parse stream-json JSONL events in real-time
      lineBuf += text;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? ""; // keep incomplete last line in buffer

      for (const raw of lines) {
        const trimLine = raw.trim();
        if (!trimLine || !trimLine.startsWith("{")) continue;
        try {
          const ev = JSON.parse(trimLine) as {
            type?: string; subtype?: string;
            // result event fields
            result?: string; is_error?: boolean; duration_ms?: number;
            num_turns?: number; total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
            // assistant message fields
            message?: { content?: Array<{
              type: string; text?: string; name?: string; id?: string;
              input?: Record<string, unknown>;
            }> };
            // tool_result fields
            tool_use_id?: string; content?: string | Array<{ text?: string }>;
          };

          // ── Final result event ──
          if (ev.type === "result") {
            streamResult = {
              result: ev.result, is_error: ev.is_error, duration_ms: ev.duration_ms,
              num_turns: ev.num_turns, total_cost_usd: ev.total_cost_usd, usage: ev.usage,
            };
            continue;
          }

          // ── Assistant message with content blocks ──
          if (ev.type === "assistant" && ev.message?.content && taskId) {
            for (const block of ev.message.content) {
              if (block.type === "tool_use" && block.name) {
                const input = block.input ?? {};
                const name = block.name;
                const detail = name === "Bash" || name === "bash"
                  ? String(input.command ?? "").slice(0, 200)
                  : name === "Read" || name === "read_file"
                    ? String(input.file_path ?? input.path ?? "").slice(0, 200)
                    : name === "Write" || name === "write_file"
                      ? String(input.file_path ?? input.path ?? "").slice(0, 150)
                      : name === "Glob" || name === "Grep"
                        ? String(input.pattern ?? "").slice(0, 150)
                        : name === "WebFetch" || name === "web_fetch"
                          ? String(input.url ?? "").slice(0, 150)
                          : JSON.stringify(input).slice(0, 120);
                logger.info(`Agent tool: ${name}`, { taskId, detail });
                eventBus.emit({ type: "mediator:thinking", taskId, thought: `🔧 ${name}: ${detail}` });
              }
              if (block.type === "text" && block.text) {
                // Agent's thinking/explanation text
                const snippet = block.text.slice(0, 300);
                streamTextParts.push(block.text);
                logger.info("Agent text", { taskId, len: block.text.length, preview: snippet.slice(0, 80) });
                eventBus.emit({ type: "mediator:thinking", taskId, thought: `💭 ${snippet}` });
              }
            }
            continue;
          }

          // ── Tool result event ──
          if (ev.type === "tool_result" && taskId) {
            const resultText = typeof ev.content === "string"
              ? ev.content
              : Array.isArray(ev.content)
                ? ev.content.map(c => c.text ?? "").join("")
                : "";
            const preview = resultText.slice(0, 150).replace(/\n/g, " ");
            eventBus.emit({ type: "mediator:thinking", taskId, thought: `📋 result: ${preview}` });
          }
        } catch { /* incomplete JSON line — will be buffered */ }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Emit stderr lines as thinking events — parse for readable tool activity
      if (taskId) {
        const lines = text.split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          // Skip noisy/internal lines
          if (line.includes("compressing") || line.includes("session") || line.length < 3) continue;
          logger.info(`Agent: ${line.slice(0, 200)}`, { taskId });
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `CLI: ${line.slice(0, 200)}` });
        }
      }
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();

    // Heartbeat — reduced frequency since stream-json now provides real-time events.
    // Only serves as a keep-alive signal if no events flow for a while.
    let lastHeartbeat = Date.now();
    const heartbeat = taskId ? setInterval(() => {
      const elapsed = Math.round((Date.now() - lastHeartbeat) / 1000);
      eventBus.emit({ type: "mediator:thinking", taskId: taskId!, thought: `CLI working... (${elapsed}s elapsed)` });
    }, 30_000) : null;

    // Handle abort — SIGTERM first, escalate to SIGKILL after 5s if process survives
    if (opts.abortController) {
      opts.abortController.signal.addEventListener("abort", () => {
        if (!killed) {
          killed = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }, 5_000);
        }
      }, { once: true });
    }

    child.on("close", (code) => {
      clearTimeout(spawnTimeout);
      if (heartbeat) clearInterval(heartbeat);
      const latencyMs = performance.now() - start;

      if (code !== 0 && !stdout.trim()) {
        const errMsg = stderr.trim() || `CLI exited with code ${code}`;
        logger.error("Claude CLI failed", { code, stderr: errMsg.slice(0, 500), taskId });
        reject(new LLMProviderError("claude", code ?? 1, `Claude CLI error: ${errMsg}`, false));
        return;
      }

      // Parse result depending on output format:
      // - stream-json (agentic): streamResult populated by JSONL parser in stdout handler
      // - json (non-agentic): single JSON object in stdout
      let resultText = "";
      let inputTokens = Math.ceil(prompt.length / 4);
      let outputTokens = 0;
      let cost = 0;
      let numTurns = 1;

      if (streamResult) {
        // stream-json: result event was captured by the JSONL parser
        resultText = streamResult.result ?? "";
        inputTokens = streamResult.usage?.input_tokens ?? inputTokens;
        outputTokens = streamResult.usage?.output_tokens ?? Math.ceil(resultText.length / 4);
        cost = streamResult.total_cost_usd ?? calculateCost(opts.model, inputTokens, outputTokens);
        numTurns = streamResult.num_turns ?? 1;

        if (streamResult.is_error) {
          logger.warn("Claude CLI returned API error", { taskId, resultLen: resultText.length, code });
          reject(new LLMProviderError("claude", code ?? 1, `Claude API error: ${resultText.slice(0, 200)}`, true));
          return;
        }
      } else if (!useStreamJson) {
        // json format: parse single JSON object from stdout
        try {
          const data = JSON.parse(stdout.trim()) as {
            result?: string; is_error?: boolean; num_turns?: number;
            total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number };
          };
          resultText = data.result ?? "";
          inputTokens = data.usage?.input_tokens ?? inputTokens;
          outputTokens = data.usage?.output_tokens ?? Math.ceil(resultText.length / 4);
          cost = data.total_cost_usd ?? calculateCost(opts.model, inputTokens, outputTokens);
          numTurns = data.num_turns ?? 1;

          if (data.is_error) {
            logger.warn("Claude CLI returned API error", { taskId, resultLen: resultText.length, code });
            reject(new LLMProviderError("claude", code ?? 1, `Claude API error: ${resultText.slice(0, 200)}`, true));
            return;
          }
        } catch {
          // JSON parse failed — use raw stdout as text
          resultText = stdout.trim();
          outputTokens = Math.ceil(resultText.length / 4);
          cost = calculateCost(opts.model, inputTokens, outputTokens);
        }
      } else {
        // stream-json but no result event — use collected text parts or raw stdout
        resultText = streamTextParts.length > 0
          ? streamTextParts.join("\n\n")
          : stdout.trim();
        outputTokens = Math.ceil(resultText.length / 4);
        cost = calculateCost(opts.model, inputTokens, outputTokens);
        logger.warn("Claude CLI: no stream result event, using fallback", { taskId, textParts: streamTextParts.length, stdoutLen: stdout.length });
      }

      // Agentic fallback: if result is empty but agent worked (tool calls produced text), use text parts
      if (!resultText && streamTextParts.length > 0) {
        resultText = streamTextParts.join("\n\n");
        logger.debug("CLI: recovered result from stream text parts", { taskId, parts: streamTextParts.length });
      }

      if (taskId) {
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `CLI finished (${numTurns} turns, ${Math.round(latencyMs)}ms)` });
      }

      logger.debug("Claude CLI completed", {
        taskId,
        turns: numTurns,
        cost,
        latencyMs: Math.round(latencyMs),
        resultLen: resultText.length,
      });

      resolve({
        content: resultText,
        toolCalls: [],
        usage: { inputTokens, outputTokens },
        cost,
        model: opts.model,
        latencyMs,
      });
    });

    child.on("error", (err) => {
      clearTimeout(spawnTimeout);
      if (heartbeat) clearInterval(heartbeat);
      logger.error("Claude CLI spawn error", { error: String(err), taskId });
      reject(new LLMProviderError("claude", 1, `Claude CLI spawn failed: ${err.message}`, false));
    });
  });
}

async function callClaudeSDK(opts: LLMCallOptions): Promise<LLMResponse> {
  const start = performance.now();

  // Build prompt for Agent SDK — concatenate message contents directly.
  // SDK handles the role framing internally; adding "Human:" causes double-framing.
  const conversationText = opts.messages.map(m => m.content).join("\n\n");

  const prompt = opts.responseFormat === "json"
    ? `${conversationText}\n\nIMPORTANT: Respond with ONLY valid JSON, no other text.`
    : conversationText;

  let resultText = "";
  const toolsUsed: string[] = [];
  const taskId = opts.taskId;

  // Agentic mode: Claude gets Bash/Read/Write/WebFetch and iterates until done.
  // Non-agentic mode: text-only, single turn (used for mediator decisions, quick calls).
  const isAgentic = opts.agenticMode === true;

  if (taskId) {
    const mode = isAgentic ? `agentic (max ${opts.agenticMaxTurns ?? 20} turns, tools: Bash/Read/Write/WebFetch)` : "text-only (1 turn)";
    eventBus.emit({ type: "mediator:thinking", taskId, thought: `SDK call: ${mode} on ${opts.model}` });
    logger.info(`callClaudeSDK: ${mode}`, { taskId, model: opts.model, promptLen: prompt.length });
  }

  // Heartbeat: emit periodic events so UI knows agent is still alive
  let lastEventTs = Date.now();
  const heartbeatInterval = taskId ? setInterval(() => {
    const silenceSec = Math.round((Date.now() - lastEventTs) / 1000);
    if (silenceSec >= 10) {
      eventBus.emit({ type: "mediator:thinking", taskId: taskId!, thought: `Agent working... (${silenceSec}s since last activity)` });
    }
  }, 10_000) : null;

  // Circuit breaker guards against endless failure storms when Claude Code CLI is broken.
  await claudeCircuitBreaker.call(async () => {
    try {
      let turnCount = 0;
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: opts.systemPrompt,
          model: opts.model,
          maxTurns: isAgentic ? (opts.agenticMaxTurns ?? 20) : 1,
          ...(isAgentic
            ? { allowedTools: ["Bash", "Read", "Write", "WebFetch"] }
            : { tools: [], allowedTools: [] }
          ),
          ...(opts.abortController ? { abortController: opts.abortController } : {}),
        },
      })) {
        // Capture from ResultMessage (SDK union: SDKResultMessage | SDKResultError)
        if (message.type === "result") {
          const r = (message as unknown as { result?: string }).result;
          if (typeof r === "string" && r) resultText = r;
          lastEventTs = Date.now();
          if (taskId) {
            eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent finished (${turnCount} turns, ${toolsUsed.length} tool calls)` });
          }
        }
        // Capture from AssistantMessage content blocks + emit progress events
        if (message.type === "assistant") {
          turnCount++;
          lastEventTs = Date.now();
          const content = (message as { type: string; message?: { content?: unknown[] } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "object" && block !== null) {
                const b = block as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
                if (b.type === "text" && b.text) {
                  resultText = b.text;
                  // Emit intermediate thinking (first 200 chars)
                  if (taskId && isAgentic) {
                    eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent [turn ${turnCount}]: ${b.text.slice(0, 200)}` });
                  }
                }
                if (b.type === "tool_use" && b.name) {
                  toolsUsed.push(b.name);
                  lastEventTs = Date.now();
                  // Emit tool:call event so UI shows what agent is doing
                  if (taskId) {
                    const inputSummary: Record<string, unknown> = {};
                    if (b.input) {
                      // Include a safe summary of tool input (truncated)
                      for (const [k, v] of Object.entries(b.input)) {
                        inputSummary[k] = typeof v === "string" ? v.slice(0, 200) : v;
                      }
                    }
                    eventBus.emit({ type: "tool:call", taskId, tool: b.name, input: inputSummary });
                    logger.debug(`Agent tool call: ${b.name}`, { taskId, turn: turnCount });
                  }
                }
              }
            }
          }
        }
      }
    } catch (rawErr) {
      // Extract stderr/details from SDK error to help diagnose "exited with code 1"
      const sdkErr = rawErr as Record<string, unknown>;
      const stderr = typeof sdkErr["stderr"] === "string" ? sdkErr["stderr"].trim() : "";
      const exitCode = typeof sdkErr["exitCode"] === "number" ? sdkErr["exitCode"] :
                       typeof sdkErr["code"] === "number" ? sdkErr["code"] : null;
      const baseMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);

      // Build a diagnostic message with all available context
      let diagMsg = baseMsg;
      if (exitCode !== null) diagMsg = `Claude Code exited with code ${exitCode}: ${baseMsg}`;
      if (stderr) diagMsg += ` | stderr: ${stderr.slice(0, 600)}`;

      // Detect auth / session errors for actionable hints
      const isAuthErr = /auth|login|session|token|credential|expired|unauthorized/i.test(baseMsg + stderr);
      if (isAuthErr) {
        diagMsg += " → Pravděpodobně expirovaná session. Spusť: claude auth login";
      }

      logger.error("[SDK] Claude Code process failed", {
        exitCode,
        stderr: stderr.slice(0, 500) || "(žádný stderr)",
        message: baseMsg.slice(0, 200),
        isAuthErr,
      });

      throw new LLMProviderError("claude", exitCode ?? 1, diagMsg, /* retryable */ !isAuthErr);
    } finally {
      // Always stop heartbeat, even on error
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  });

  if (isAgentic && toolsUsed.length > 0) {
    logger.debug("Agentic worker used tools", { tools: toolsUsed });
  }

  const latencyMs = performance.now() - start;

  // Rough token estimation (4 chars ≈ 1 token)
  const inputTokens = Math.ceil((opts.systemPrompt.length + prompt.length) / 4);
  const outputTokens = Math.ceil(resultText.length / 4);
  const cost = calculateCost(opts.model, inputTokens, outputTokens);

  return {
    content: resultText,
    toolCalls: toolsUsed.map(name => ({ id: name, name, input: {} })),
    usage: { inputTokens, outputTokens },
    cost,
    model: opts.model,
    latencyMs,
  };
}

// ─── Codex CLI OAuth token reader ─────────────────────────────

import { join as pathJoin } from "node:path";
import { homedir } from "node:os";

/** Cached Codex OAuth access token with expiry */
let _codexTokenCache: { token: string; expiresAt: number } | null = null;

/** Decode a JWT payload (no verification — we just need the exp claim) */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Try to refresh the Codex OAuth access token using the refresh_token.
 * Uses the OpenAI auth server's standard OAuth2 token endpoint.
 */
async function refreshCodexToken(refreshToken: string): Promise<string | null> {
  try {
    const refreshAbort = new AbortController();
    const refreshTimeout = setTimeout(() => refreshAbort.abort(), 10_000);
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann", // Codex CLI client ID
      }),
      signal: refreshAbort.signal,
    });
    clearTimeout(refreshTimeout);
    if (!res.ok) {
      logger.warn("Codex OAuth token refresh failed", { status: res.status });
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const newAccessToken = typeof data["access_token"] === "string" ? data["access_token"] : null;
    if (newAccessToken) {
      logger.info("Codex OAuth token refreshed successfully");
      // Update ~/.codex/auth.json with new tokens
      try {
        const authPath = pathJoin(homedir(), ".codex", "auth.json");
        const raw = await fsReadFile(authPath, "utf8");
        const authData = JSON.parse(raw) as Record<string, unknown>;
        const tokens = authData["tokens"] as Record<string, unknown> ?? {};
        tokens["access_token"] = newAccessToken;
        if (typeof data["id_token"] === "string") tokens["id_token"] = data["id_token"];
        if (typeof data["refresh_token"] === "string") tokens["refresh_token"] = data["refresh_token"];
        authData["tokens"] = tokens;
        authData["last_refresh"] = new Date().toISOString();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(authPath, JSON.stringify(authData, null, 2), "utf8");
      } catch (writeErr) {
        logger.debug("Failed to update ~/.codex/auth.json after refresh", { error: String(writeErr) });
      }
    }
    return newAccessToken;
  } catch (err) {
    logger.warn("Codex OAuth token refresh error", { error: String(err) });
    return null;
  }
}

/**
 * Read the OpenAI OAuth token from Codex CLI's auth store (~/.codex/auth.json).
 * Supports automatic token refresh when expired.
 */
async function readCodexOAuthToken(): Promise<string | null> {
  // Return cached token if still valid (with 60s buffer)
  if (_codexTokenCache && Date.now() < _codexTokenCache.expiresAt - 60_000) {
    return _codexTokenCache.token;
  }

  try {
    const authPath = pathJoin(homedir(), ".codex", "auth.json");
    const raw = await fsReadFile(authPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    if (data["auth_mode"] !== "chatgpt") return null;

    const tokens = data["tokens"] as Record<string, unknown> | undefined;
    if (!tokens) return null;

    let accessToken = typeof tokens["access_token"] === "string" ? tokens["access_token"] : null;
    const refreshToken = typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : null;

    if (!accessToken) return null;

    // Check JWT expiry
    const payload = decodeJwtPayload(accessToken);
    const exp = typeof payload?.["exp"] === "number" ? payload["exp"] : 0;
    const nowSec = Math.floor(Date.now() / 1000);

    if (exp > 0 && nowSec >= exp - 60) {
      // Token expired or about to expire — try refresh
      logger.info("Codex OAuth access_token expired, attempting refresh...");
      if (refreshToken) {
        const newToken = await refreshCodexToken(refreshToken);
        if (newToken) {
          accessToken = newToken;
        } else {
          logger.warn("Codex OAuth refresh failed. Run: codex login");
          _codexTokenCache = null;
          return null;
        }
      } else {
        logger.warn("Codex OAuth access_token expired and no refresh_token. Run: codex login");
        _codexTokenCache = null;
        return null;
      }
    }

    // Cache with expiry
    const newPayload = decodeJwtPayload(accessToken);
    const newExp = typeof newPayload?.["exp"] === "number" ? newPayload["exp"] : nowSec + 3600;
    _codexTokenCache = { token: accessToken, expiresAt: newExp * 1000 };
    logger.info("GPT OAuth: loaded token from Codex CLI (~/.codex/auth.json)");
    return accessToken;
  } catch {
    _codexTokenCache = null;
    return null;
  }
}

/** Reset cached Codex token (e.g. on auth failure) */
function resetCodexTokenCache(): void {
  _codexTokenCache = null;
}

// ─── GPT via direct fetch ──────────────────────────────────────

async function callGPT(opts: LLMCallOptions): Promise<LLMResponse> {
  let apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;

  // If no API key, try Codex CLI OAuth token (~/.codex/auth.json)
  if (!apiKey) {
    apiKey = await readCodexOAuthToken() ?? undefined;
  }

  // Also check OPENAI_OAUTH_TOKEN env var as explicit override
  if (!apiKey) {
    apiKey = process.env.OPENAI_OAUTH_TOKEN;
  }

  if (!apiKey) {
    throw new LLMProviderError(
      "gpt", 401,
      "OpenAI API key not found. Set OPENAI_API_KEY in .env, use Codex CLI (codex login), or set OPENAI_OAUTH_TOKEN.",
      false,
    );
  }

  const start = performance.now();

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      ...opts.messages,
    ],
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
  };

  if (opts.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  const gptAbort = new AbortController();
  const gptTimeout = setTimeout(() => gptAbort.abort(), 60_000);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: gptAbort.signal,
  });
  clearTimeout(gptTimeout);

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    // If 401 and we used a Codex OAuth token, it may be expired — reset cache
    if (res.status === 401 && !opts.apiKey && !process.env.OPENAI_API_KEY) {
      resetCodexTokenCache();
      logger.warn("GPT OAuth token rejected (401). Run: codex login");
    }
    throw new LLMProviderError("gpt", res.status, `GPT API error: ${text}`, retryable);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  const latencyMs = performance.now() - start;
  const choice = data.choices[0];

  // TS-05: Use nullish coalescing instead of non-null assertion — choice may be
  // undefined if the API returns an empty choices array.
  const content = choice?.message.content ?? "";

  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));

  const inputTokens = data.usage.prompt_tokens;
  const outputTokens = data.usage.completion_tokens;
  const cost = calculateCost(opts.model, inputTokens, outputTokens);

  return { content, toolCalls, usage: { inputTokens, outputTokens }, cost, model: data.model, latencyMs };
}

// ─── Gemini via direct fetch ───────────────────────────────────

async function callGemini(opts: LLMCallOptions): Promise<LLMResponse> {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new LLMProviderError("gemini", 401, "No Google API key configured", false);

  const start = performance.now();

  const contents = [
    { role: "user", parts: [{ text: opts.systemPrompt + "\n\n" + opts.messages.map(m => m.content).join("\n\n") }] },
  ];

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxTokens ?? 4096,
    },
  };

  if (opts.responseFormat === "json") {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
  }

  // SEC-03: Move Gemini API key from URL query param to request header.
  // Previously the key was appended as ?key=... which causes it to appear in
  // HTTP server access logs, proxy logs, and browser history. Using the
  // x-goog-api-key header keeps the credential out of the URL entirely.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey, // SEC-03: key in header, not URL query param
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new LLMProviderError("gemini", res.status, `Gemini API error: ${text}`, retryable);
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const latencyMs = performance.now() - start;

  // TS-05: Use nullish coalescing on the candidates array access instead of
  // a non-null assertion — candidates[0] may be absent on empty responses.
  const content = data.candidates[0]?.content.parts.map(p => p.text).join("") ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  const cost = calculateCost(opts.model, inputTokens, outputTokens);

  return { content, toolCalls: [], usage: { inputTokens, outputTokens }, cost, model: opts.model, latencyMs };
}

// ─── Vision helpers ───────────────────────────────────────────

async function callClaudeVision(
  systemPrompt: string,
  userMessage: string,
  imageBase64: string,
  mimeType: string,
  model: string,
  apiKey: string,
): Promise<LLMResponse> {
  const start = performance.now();
  const body = {
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
        { type: "text", text: userMessage },
      ],
    }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: claudeAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderError("claude", res.status, `Claude Vision error: ${text}`, res.status >= 500);
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };
  const latencyMs = performance.now() - start;
  const content = data.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
  const cost = calculateCost(data.model, data.usage.input_tokens, data.usage.output_tokens);
  return { content, toolCalls: [], usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }, cost, model: data.model, latencyMs };
}

async function callGPTVision(
  systemPrompt: string,
  userMessage: string,
  imageBase64: string,
  mimeType: string,
  apiKey: string,
): Promise<LLMResponse> {
  const start = performance.now();
  const body = {
    model: "gpt-4o",
    max_tokens: 4096,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: userMessage },
        ],
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderError("gpt", res.status, `GPT Vision error: ${text}`, res.status >= 500);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };
  const latencyMs = performance.now() - start;

  // TS-05: Use optional chaining instead of non-null assertion on choices[0].
  const content = data.choices[0]?.message.content ?? "";
  const cost = calculateCost(data.model, data.usage.prompt_tokens, data.usage.completion_tokens);
  return { content, toolCalls: [], usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }, cost, model: data.model, latencyMs };
}

async function callGeminiVision(
  systemPrompt: string,
  userMessage: string,
  imageBase64: string,
  mimeType: string,
  apiKey: string,
): Promise<LLMResponse> {
  const start = performance.now();
  const model = "gemini-1.5-flash";
  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: systemPrompt + "\n\n" + userMessage },
        { inlineData: { mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 4096 },
  };

  // SEC-03: Use x-goog-api-key header instead of URL query param (same fix as callGemini).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey, // SEC-03: key in header, not URL query param
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderError("gemini", res.status, `Gemini Vision error: ${text}`, res.status >= 500);
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
  const latencyMs = performance.now() - start;

  // TS-05: Use optional chaining instead of non-null assertion on candidates[0].
  const content = data.candidates[0]?.content.parts.map(p => p.text).join("") ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  const cost = calculateCost(model, inputTokens, outputTokens);
  return { content, toolCalls: [], usage: { inputTokens, outputTokens }, cost, model, latencyMs };
}

// ─── Claude Agent SDK Vision (fallback when no API key) ───────

async function callClaudeSDKVision(
  systemPrompt: string,
  userMessage: string,
  imageBase64: string,
  mimeType: string,
  model: string,
): Promise<LLMResponse> {
  const { writeFile, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const ext = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : mimeType.includes("webp") ? "webp" : "jpg";
  const tmpPath = join(tmpdir(), `pepagi-vision-${Date.now()}.${ext}`);

  try {
    await writeFile(tmpPath, Buffer.from(imageBase64, "base64"));
    const start = performance.now();

    const prompt = `${userMessage}\n\nThe image to analyze is saved at: ${tmpPath}\nPlease read and analyze this image file.`;
    let resultText = "";

    for await (const message of query({
      prompt,
      options: {
        systemPrompt,
        model,
        maxTurns: 3,
        allowedTools: ["Read"],
      },
    })) {
      if (message.type === "result") {
        const r = (message as unknown as { result?: string }).result;
        if (typeof r === "string" && r) resultText = r;
      }
      if (message.type === "assistant") {
        const content = (message as { type: string; message?: { content?: unknown[] } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && b.text) resultText = b.text;
            }
          }
        }
      }
    }

    const latencyMs = performance.now() - start;
    const inputTokens = Math.ceil((systemPrompt.length + prompt.length) / 4);
    const outputTokens = Math.ceil(resultText.length / 4);
    const cost = calculateCost(model, inputTokens, outputTokens);
    return { content: resultText, toolCalls: [], usage: { inputTokens, outputTokens }, cost, model, latencyMs };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// ─── Custom OpenAI-Compatible providers ──────────────────────────

/** Call any OpenAI-compatible API endpoint (Deepinfra, Kie.ai, Together, etc.) */
async function callOpenAICompatible(
  opts: LLMCallOptions,
  baseUrl: string,
  providerName: string,
  apiKey?: string,
): Promise<LLMResponse> {
  const start = performance.now();

  // Send the model name as-is — custom providers expect the full model identifier
  // (e.g. "moonshotai/Kimi-K2.5" on Deepinfra, "gpt-4o" on OpenAI-compatible APIs)
  const modelName = opts.model;

  const messages = [
    { role: "system" as const, content: opts.systemPrompt },
    ...opts.messages,
  ];

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
    stream: false,
  };

  if (opts.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const effectiveKey = apiKey ?? opts.apiKey;
  if (effectiveKey) {
    headers["Authorization"] = `Bearer ${effectiveKey}`;
  }

  // Normalize base URL: strip trailing slash, then build endpoint URL.
  // Smart path detection — handle all common base URL formats:
  //   https://api.example.com          → append /v1/chat/completions
  //   https://api.example.com/v1       → append /chat/completions
  //   https://api.example.com/v1/openai → append /chat/completions
  //   https://…/v1/chat/completions    → use as-is
  const normalizedUrl = baseUrl.replace(/\/+$/, "");
  let endpoint: string;
  if (/\/v1\/chat\/completions$/i.test(normalizedUrl)) {
    // Already a full endpoint URL — use as-is
    endpoint = normalizedUrl;
  } else if (/\/v1(\/[^/]*)*$/i.test(normalizedUrl)) {
    // Has /v1 or /v1/something (e.g. /v1, /v1/openai) — append /chat/completions
    endpoint = `${normalizedUrl}/chat/completions`;
  } else {
    // No /v1 in path — append /v1/chat/completions
    endpoint = `${normalizedUrl}/v1/chat/completions`;
  }

  const abortCtrl = new AbortController();
  // Per-request timeout: minimum 120s regardless of overall budget timeout.
  // opts.timeoutMs is the task-level budget (e.g. 60s for trivial), but a single API call
  // to external providers (DeepInfra, OpenRouter) can take 30-90s with tool definitions.
  const perRequestTimeout = Math.max(opts.timeoutMs ?? 120_000, 120_000);
  const timeout = setTimeout(() => abortCtrl.abort(), perRequestTimeout);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortCtrl.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    throw new LLMProviderError(
      providerName, 0,
      isTimeout
        ? `${providerName} request timed out after ${perRequestTimeout / 1000}s at ${endpoint}`
        : `${providerName} unreachable at ${endpoint}: ${String(err)}`,
      isTimeout, // timeouts are retryable, connection errors are not
    );
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new LLMProviderError(providerName, res.status, `${providerName} API error: ${text}`, retryable);
  }

  type OAIResponse = {
    choices?: Array<{
      message?: {
        content?: string;
        role?: string;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  const data = await res.json() as OAIResponse;

  const choice = data.choices?.[0];
  const firstContent = choice?.message?.content ?? "";
  let totalInputTokens = data.usage?.prompt_tokens ?? Math.ceil((opts.systemPrompt.length + JSON.stringify(opts.messages).length) / 4);
  let totalOutputTokens = data.usage?.completion_tokens ?? Math.ceil(firstContent.length / 4);

  const firstToolCalls = choice?.message?.tool_calls ?? [];

  // ── Agentic tool loop for OpenAI-compatible providers ──────────
  // If the LLM returned tool_calls AND we have a toolExecutor, execute them
  // and send results back, looping until the LLM responds with text only.
  if (firstToolCalls.length > 0 && opts.toolExecutor && opts.agenticMode) {
    const maxTurns = opts.agenticMaxTurns ?? 20;
    const taskId = opts.taskId ?? "unknown";

    // Build conversation for multi-turn tool loop
    const loopMessages: Array<Record<string, unknown>> = [
      { role: "system", content: opts.systemPrompt },
      ...opts.messages.map(m => ({ role: m.role, content: m.content })),
      // Assistant's response with tool_calls
      { role: "assistant", content: firstContent || null, tool_calls: firstToolCalls },
    ];

    let currentToolCalls = firstToolCalls;
    let finalContent = firstContent;
    const allToolNames: string[] = [];

    for (let turn = 0; turn < maxTurns && currentToolCalls.length > 0; turn++) {
      // Execute all tool calls
      for (const tc of currentToolCalls) {
        const toolName = tc.function.name;
        let toolArgs: Record<string, unknown>;
        try { toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { toolArgs = {}; }

        allToolNames.push(toolName);
        if (taskId !== "unknown") {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `Tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})` });
        }

        const result = await opts.toolExecutor(toolName, toolArgs, taskId);
        const resultText = result.success ? result.output : `Error: ${result.error ?? "unknown"}`;

        // Add tool result to conversation
        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultText.slice(0, 50_000), // cap tool output
        });

        if (taskId !== "unknown") {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `${toolName} ${result.success ? "✓" : "✗"}` });
        }
      }

      // Send conversation back to LLM for next turn
      const nextBody: Record<string, unknown> = {
        model: modelName,
        messages: loopMessages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 4096,
        stream: false,
      };
      if (body.tools) nextBody.tools = body.tools;

      const nextAbort = new AbortController();
      const nextTimeout = setTimeout(() => nextAbort.abort(), perRequestTimeout);
      let nextRes: Response;
      try {
        nextRes = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(nextBody),
          signal: nextAbort.signal,
        });
      } catch (err) {
        clearTimeout(nextTimeout);
        // On connection error, return what we have so far
        break;
      }
      clearTimeout(nextTimeout);

      if (!nextRes.ok) break; // Stop on API error

      const nextData = await nextRes.json() as OAIResponse;
      const nextChoice = nextData.choices?.[0];
      totalInputTokens += nextData.usage?.prompt_tokens ?? 0;
      totalOutputTokens += nextData.usage?.completion_tokens ?? 0;

      currentToolCalls = nextChoice?.message?.tool_calls ?? [];
      finalContent = nextChoice?.message?.content ?? finalContent;

      // Add assistant response to conversation for next turn
      if (currentToolCalls.length > 0) {
        loopMessages.push({
          role: "assistant",
          content: nextChoice?.message?.content || null,
          tool_calls: currentToolCalls,
        });
      }

      if (taskId !== "unknown") {
        eventBus.emit({ type: "mediator:thinking", taskId, thought: `Agent turn ${turn + 1}/${maxTurns} (${allToolNames.length} tool calls)` });
      }
    }

    const latencyMs = performance.now() - start;
    const cost = calculateCost(opts.model, totalInputTokens, totalOutputTokens);

    return {
      content: finalContent,
      toolCalls: allToolNames.map((name, i) => ({ id: `tc-${i}`, name, input: {} })),
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      cost,
      model: data.model ?? opts.model,
      latencyMs,
    };
  }

  // ── Non-agentic path (single call, text-only or no tool executor) ──
  const latencyMs = performance.now() - start;
  const cost = calculateCost(opts.model, totalInputTokens, totalOutputTokens);

  const toolCalls: ToolCall[] = firstToolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => { try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { return {}; } })(),
  }));

  return { content: firstContent, toolCalls, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }, cost, model: data.model ?? opts.model, latencyMs };
}

// ─── Ollama (local models) ─────────────────────────────────────

/** Default Ollama API base URL — override with OLLAMA_BASE_URL env var */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

async function callOllama(opts: LLMCallOptions): Promise<LLMResponse> {
  const start = performance.now();
  // Strip "ollama/" prefix from model name for the API call
  const modelName = opts.model.replace(/^ollama\//, "");

  const messages = [
    { role: "system", content: opts.systemPrompt },
    ...opts.messages,
  ];

  if (opts.responseFormat === "json") {
    messages.push({ role: "user", content: "IMPORTANT: Respond with ONLY valid JSON, no other text." });
  }

  const body = {
    model: modelName,
    messages,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.3,
      num_predict: opts.maxTokens ?? 4096,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LLMProviderError(
      "ollama", 0,
      `Ollama nedostupný na ${OLLAMA_BASE_URL}. Spusť: ollama serve (err: ${String(err)})`,
      false,
    );
  }

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status >= 500;
    throw new LLMProviderError("ollama", res.status, `Ollama API error: ${text}`, retryable);
  }

  const data = await res.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const latencyMs = performance.now() - start;
  const content = data.message?.content ?? "";
  const inputTokens = data.prompt_eval_count ?? Math.ceil((opts.systemPrompt.length + JSON.stringify(opts.messages).length) / 4);
  const outputTokens = data.eval_count ?? Math.ceil(content.length / 4);

  return {
    content,
    toolCalls: [],
    usage: { inputTokens, outputTokens },
    cost: 0, // Local model — no API cost
    model: opts.model,
    latencyMs,
  };
}

// ─── Ollama / LM Studio utilities ─────────────────────────────

/** LM Studio base URL — uses OpenAI-compatible API at port 1234 */
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";

/**
 * Check if Ollama is running and accessible.
 * Fast 2-second timeout — use before enabling Ollama agent.
 */
export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List all locally available Ollama models.
 * @returns Array of model names like ["llama3.2:latest", "nomic-embed-text"]
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Check if LM Studio server is running.
 */
export async function checkLMStudioHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List available models from LM Studio.
 */
export async function listLMStudioModels(): Promise<string[]> {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

/** Call LM Studio (OpenAI-compatible API at LM_STUDIO_URL) */
async function callLMStudio(opts: LLMCallOptions): Promise<LLMResponse> {
  const start = performance.now();

  const messages = [
    { role: "system" as const, content: opts.systemPrompt },
    ...opts.messages,
  ];

  const body: Record<string, unknown> = {
    model: opts.model.replace(/^lmstudio\//, ""),
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
    stream: false,
  };

  if (opts.responseFormat === "json") {
    (body as Record<string, unknown>).response_format = { type: "json_object" };
  }

  let res: Response;
  try {
    res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new LLMProviderError(
      "lmstudio", 0,
      `LM Studio nedostupné na ${LM_STUDIO_URL}. Spusť LM Studio a zapni Local Server (err: ${String(err)})`,
      false,
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderError("lmstudio", res.status, `LM Studio API error: ${text}`, res.status >= 500);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const latencyMs = performance.now() - start;
  const content = data.choices?.[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? Math.ceil((opts.systemPrompt.length + JSON.stringify(opts.messages).length) / 4);
  const outputTokens = data.usage?.completion_tokens ?? Math.ceil(content.length / 4);

  return {
    content,
    toolCalls: [],
    usage: { inputTokens, outputTokens },
    cost: 0, // Local model — no API cost
    model: opts.model,
    latencyMs,
  };
}

// ─── Kiro CLI via ACP (Agent Client Protocol) ────────────────

/** Kiro-specific config (subset of PepagiConfig.agents.kiro) */
interface KiroAgentConfig {
  enabled: boolean;
  model: string;
  agent: string;
  timeout: number;
  forwardMcpServers: Array<{
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Call Kiro CLI via ACP (Agent Client Protocol) over stdin/stdout.
 * Spawns `kiro-cli acp` subprocess, performs ACP handshake, sends prompt,
 * parses streaming session/update notifications, and returns standard LLMResponse.
 *
 * @param opts - Standard LLMCallOptions with provider="kiro"
 * @param kiroConfig - Kiro-specific config (model, agent, timeout, forwardMcpServers)
 * @returns LLMResponse with accumulated content, tool calls, usage, and latency
 */
async function callKiro(opts: LLMCallOptions, kiroConfig: KiroAgentConfig): Promise<LLMResponse> {
  return kiroCircuitBreaker.call(async () => {
    const start = performance.now();
    const taskId = opts.taskId;

    // Build spawn arguments
    const args = ["acp"];
    if (kiroConfig.agent) {
      args.push("--agent", kiroConfig.agent);
      logger.info(`callKiro: using custom agent "${kiroConfig.agent}"`, { taskId });
    }
    if (kiroConfig.model && kiroConfig.model !== "auto") {
      args.push("--model", kiroConfig.model);
    }

    if (taskId) {
      eventBus.emit({ type: "mediator:thinking", taskId, thought: `Kiro CLI: spawning kiro-cli acp (model=${kiroConfig.model})` });
    }

    // Build prompt content blocks: system prompt first, then each message
    const contentBlocks: Array<{ type: string; text: string }> = [];
    if (opts.systemPrompt) {
      contentBlocks.push({ type: "text", text: opts.systemPrompt });
    }
    for (const msg of opts.messages) {
      contentBlocks.push({ type: "text", text: msg.content });
    }

    // Compute prompt char count for fallback estimation
    const promptChars = contentBlocks.reduce((sum, b) => sum + b.text.length, 0);

    return new Promise<LLMResponse>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("kiro-cli", args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(new LLMProviderError("kiro", 1, `Kiro CLI spawn failed: ${String(err)}`, false));
        return;
      }

      // stdio guaranteed non-null with ["pipe", "pipe", "pipe"]
      const stdin = child.stdin!;
      const stdout = child.stdout!;
      const stderrStream = child.stderr!;

      let killed = false;
      let settled = false;
      let lineBuf = "";
      let stderr = "";

      // Accumulated response data
      const textChunks: string[] = [];
      const toolCalls: ToolCall[] = [];
      let acpUsage: { input_tokens?: number; output_tokens?: number } | null = null;
      let acpCost: number | null = null;

      // JSON-RPC request id counter
      let nextId = 1;

      // Track which phase we're in
      let sessionId = "";
      let promptRequestId = 0;
      let initializeRequestId = 0;
      let sessionNewRequestId = 0;

      const timeoutMs = opts.timeoutMs ?? (kiroConfig.timeout * 1000);
      const timeoutSec = Math.round(timeoutMs / 1000);

      // ── Cleanup helper ──
      const cleanup = () => {
        if (!killed) {
          killed = true;
          try { child.kill("SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }, 5_000);
        }
        stdout.removeAllListeners();
        stderrStream.removeAllListeners();
        child.removeAllListeners();
      };

      const finish = (result: LLMResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimeout);
        clearTimeout(overallTimeout);
        cleanup();
        resolve(result);
      };

      const fail = (err: LLMProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimeout);
        clearTimeout(overallTimeout);
        cleanup();
        reject(err);
      };

      // ── Initialize timeout (10s) ──
      const initTimeout = setTimeout(() => {
        fail(new LLMProviderError("kiro", 504, "ACP initialize timeout (10s)", true));
      }, 10_000);

      // ── Overall timeout ──
      const overallTimeout = setTimeout(() => {
        if (taskId) {
          eventBus.emit({ type: "mediator:thinking", taskId, thought: `Kiro CLI timeout (${timeoutSec}s) — killing process` });
        }
        fail(new LLMProviderError("kiro", 504, `Kiro CLI timeout after ${timeoutSec}s`, true));
      }, timeoutMs);

      // ── Abort signal ──
      if (opts.abortController) {
        opts.abortController.signal.addEventListener("abort", () => {
          // Send session/cancel, then SIGTERM, escalate to SIGKILL after 5s
          if (!killed && !settled) {
            try {
              if (sessionId) {
                stdin.write(acpRequest(nextId++, "session/cancel", { sessionId }));
              }
            } catch { /* stdin may be closed */ }
            killed = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }, 5_000);
          }
        }, { once: true });
      }

      // ── Write helper ──
      const sendReq = (method: string, params: Record<string, unknown> = {}): number => {
        const id = nextId++;
        stdin.write(acpRequest(id, method, params));
        return id;
      };

      // ── Parse stdout JSONL ──
      stdout.on("data", (chunk: Buffer) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;

          let msg: ACPMessage;
          try {
            msg = JSON.parse(trimmed) as ACPMessage;
          } catch {
            continue; // malformed JSON — skip
          }

          // ── Handle responses (has id) ──
          if (msg.id !== undefined) {
            // Check for errors
            if (msg.error) {
              const errMsg = msg.error.message ?? "ACP error";
              const retryable = (msg.error.code ?? 0) >= 500;
              fail(new LLMProviderError("kiro", msg.error.code ?? 1, errMsg, retryable));
              return;
            }

            // Initialize response
            if (msg.id === initializeRequestId && msg.result) {
              clearTimeout(initTimeout);
              // Send session/new
              sessionNewRequestId = sendReq("session/new", {
                cwd: process.cwd(),
                mcpServers: kiroConfig.forwardMcpServers.map(s => ({
                  name: s.name,
                  command: s.command,
                  args: s.args,
                  env: s.env,
                })),
              });
              continue;
            }

            // Session/new response
            if (msg.id === sessionNewRequestId && msg.result) {
              sessionId = (msg.result.sessionId as string) ?? "";
              const modes = msg.result.modes as {
                availableModes?: Array<{ id: string; description?: string }>;
                currentModeId?: string;
              } | undefined;

              // Optionally set mode based on agenticMode
              if (modes?.availableModes && modes.availableModes.length > 0) {
                let targetModeId: string | null = null;

                if (opts.agenticMode) {
                  // Prefer mode containing "default" or matching agent name
                  targetModeId = modes.availableModes.find(m =>
                    m.id.includes("default") || (kiroConfig.agent && m.id.includes(kiroConfig.agent))
                  )?.id ?? null;
                } else {
                  // Prefer mode containing "planner" or "readonly"
                  targetModeId = modes.availableModes.find(m =>
                    m.id.includes("planner") || m.id.includes("readonly")
                  )?.id ?? null;
                }

                if (targetModeId && targetModeId !== modes.currentModeId) {
                  sendReq("session/set_mode", { sessionId, modeId: targetModeId });
                  if (taskId) {
                    eventBus.emit({ type: "mediator:thinking", taskId, thought: `Kiro session mode: ${targetModeId}` });
                  }
                }
              }

              // Send prompt
              promptRequestId = sendReq("session/prompt", {
                sessionId,
                prompt: contentBlocks,
              });
              continue;
            }

            // Prompt response (turn complete — has stopReason)
            if (msg.id === promptRequestId && msg.result) {
              const result = msg.result as {
                stopReason?: string;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  total_tokens?: number;
                };
              };

              // Extract usage from prompt response if available
              if (result.usage) {
                acpUsage = {
                  input_tokens: result.usage.input_tokens,
                  output_tokens: result.usage.output_tokens,
                };
              }

              const latencyMs = performance.now() - start;
              const content = textChunks.join("");

              // Usage: prefer ACP data, fall back to char estimation
              const inputTokens = acpUsage?.input_tokens ?? Math.ceil(promptChars / 4);
              const outputTokens = acpUsage?.output_tokens ?? Math.ceil(content.length / 4);
              const cost = acpCost ?? 0;

              if (taskId) {
                eventBus.emit({ type: "mediator:thinking", taskId, thought: `Kiro CLI finished (${Math.round(latencyMs)}ms)` });
              }

              logger.debug("callKiro completed", {
                taskId,
                latencyMs: Math.round(latencyMs),
                contentLen: content.length,
                toolCallCount: toolCalls.length,
                inputTokens,
                outputTokens,
                cost,
              });

              finish({
                content,
                toolCalls,
                usage: { inputTokens, outputTokens },
                cost,
                model: opts.model,
                latencyMs,
              });
              return;
            }

            // set_mode response — no action needed, just continue
            continue;
          }

          // ── Handle notifications (no id) ──
          if (msg.method === "session/update" && msg.params) {
            const update = msg.params.update as Record<string, unknown> | undefined;
            if (!update) continue;

            const sessionUpdate = update.sessionUpdate as string;

            switch (sessionUpdate) {
              case "agent_message_chunk": {
                const contentObj = update.content as { text?: string } | undefined;
                const text = contentObj?.text ?? "";
                if (text) {
                  textChunks.push(text);
                  if (taskId) {
                    eventBus.emit({ type: "mediator:thinking", taskId, thought: `💭 ${text.slice(0, 200)}` });
                  }
                }
                break;
              }

              case "tool_call": {
                const name = (update.name as string) ?? "unknown";
                const input = (update.input as Record<string, unknown>) ?? {};
                const id = (update.id as string) ?? `tc-${toolCalls.length}`;
                toolCalls.push({ id, name, input });
                if (taskId) {
                  const detail = JSON.stringify(input).slice(0, 120);
                  eventBus.emit({ type: "tool:call", taskId, tool: name, input });
                  eventBus.emit({ type: "mediator:thinking", taskId, thought: `🔧 ${name}: ${detail}` });
                }
                break;
              }

              case "usage_update": {
                const contextWindow = update.contextWindow as { used?: number; size?: number } | undefined;
                const costObj = update.cost as { amount?: number } | undefined;
                if (costObj?.amount !== undefined) {
                  acpCost = costObj.amount;
                }
                if (contextWindow && taskId) {
                  const pct = contextWindow.size ? Math.round((contextWindow.used ?? 0) / contextWindow.size * 100) : 0;
                  eventBus.emit({ type: "mediator:thinking", taskId, thought: `Context: ${pct}% used (${contextWindow.used}/${contextWindow.size})` });
                }
                break;
              }

              default:
                // Silently ignore _kiro.dev/* extension notifications and unknown types
                break;
            }
            continue;
          }

          // Silently ignore other notifications (e.g., _kiro.dev/*)
        }
      });

      // ── Collect stderr ──
      stderrStream.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // ── Handle subprocess exit ──
      child.on("close", (code) => {
        if (settled) return;
        const latencyMs = performance.now() - start;

        if (code !== 0) {
          const errMsg = stderr.trim() || `kiro-cli exited with code ${code}`;
          fail(new LLMProviderError("kiro", code ?? 1, `Kiro CLI error: ${errMsg}`, true));
          return;
        }

        // Process exited 0 but we never got a prompt response — assemble from what we have
        const content = textChunks.join("");
        const inputTokens = acpUsage?.input_tokens ?? Math.ceil(promptChars / 4);
        const outputTokens = acpUsage?.output_tokens ?? Math.ceil(content.length / 4);

        finish({
          content,
          toolCalls,
          usage: { inputTokens, outputTokens },
          cost: acpCost ?? 0,
          model: opts.model,
          latencyMs,
        });
      });

      // ── Handle spawn errors (ENOENT, EACCES) ──
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          fail(new LLMProviderError(
            "kiro", 1,
            "Kiro CLI not installed — install kiro-cli and ensure it is on your PATH",
            false,
          ));
        } else {
          fail(new LLMProviderError("kiro", 1, `Kiro CLI spawn failed: ${err.message}`, false));
        }
      });

      // ── Start ACP handshake: send initialize ──
      initializeRequestId = sendReq("initialize", {});
    });
  });
}

/**
 * Check if Kiro CLI is installed and responsive.
 * Spawns `kiro-cli acp`, sends initialize, expects response within 5s.
 * @returns true if Kiro CLI is available
 */
export async function checkKiroHealth(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("kiro-cli", ["acp"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(false);
      return;
    }

    const childStdout = child.stdout!;
    const childStdin = child.stdin!;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      childStdout.removeAllListeners();
      child.removeAllListeners();
      resolve(result);
    };

    const timer = setTimeout(() => done(false), 5_000);

    let lineBuf = "";
    childStdout.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as ACPMessage;
          if (msg.id !== undefined && msg.result) {
            done(true);
            return;
          }
        } catch { /* ignore */ }
      }
    });

    child.on("error", () => done(false));
    child.on("close", () => done(false));

    // Send initialize request
    childStdin.write(acpRequest(1, "initialize", {}));
  });
}

// ─── Audio transcription helpers ──────────────────────────────

async function transcribeWithWhisperAPI(audioBuffer: Buffer, apiKey: string, language: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", "whisper-1");
  if (language) formData.append("language", language);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Whisper API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { text: string };
  return data.text;
}

async function transcribeWithLocalWhisper(audioBuffer: Buffer, language: string): Promise<string> {
  // SEC-06: Validate language against a strict allowlist before interpolating it
  // into the shell command. Without this check, an attacker-controlled value like
  // `cs; rm -rf ~/` would execute arbitrary shell commands.
  // Accepts ISO 639-1 (2-letter) and ISO 639-2 (3-letter) codes, plus "auto".
  // Any value that doesn't match is silently replaced with "auto" so the call
  // can still succeed without exposing the invalid input to the shell.
  const LANGUAGE_RE = /^[a-z]{2,3}$|^auto$/;
  const safeLanguage = LANGUAGE_RE.test(language) ? language : "auto";

  const { writeFile, readFile, unlink } = await import("node:fs/promises");
  const { execSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const ts = Date.now();
  const tmpAudio = join(tmpdir(), `pepagi-voice-${ts}.ogg`);
  const tmpOut = join(tmpdir(), `pepagi-voice-${ts}.txt`);

  try {
    await writeFile(tmpAudio, audioBuffer);
    // safeLanguage has been validated above — safe to interpolate into the shell command.
    execSync(
      `whisper "${tmpAudio}" --language ${safeLanguage} --model base --output_format txt --output_dir "${tmpdir()}" --output_filename "pepagi-voice-${ts}"`,
      { timeout: 120_000 },
    );
    const text = await readFile(tmpOut, "utf8");
    return text.trim();
  } catch {
    throw new Error(
      "Přepis hlasových zpráv vyžaduje OPENAI_API_KEY v .env souboru.\n" +
      "Alternativně nainstaluj lokální whisper: pip install openai-whisper",
    );
  } finally {
    await unlink(tmpAudio).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

// ─── Main LLMProvider class ────────────────────────────────────

export class LLMProvider {
  /** Default provider for quickCall — set via configure() */
  private _defaultProvider: string = "claude";
  /** Default model for quickCall — set via configure() */
  private _defaultModel = "claude-opus-4-6";
  /** Cheap model for auxiliary calls — set via configure() */
  private _cheapModel = "claude-haiku-4-5";
  /** Custom OpenAI-compatible providers registered at runtime */
  private _customProviders = new Map<string, { baseUrl: string; apiKey: string; displayName: string }>();

  /**
   * Configure default provider/model for quick calls.
   * Should be called after config is loaded — typically in daemon.ts or cli.ts.
   */
  configure(provider: string, model: string, cheapModel: string): void {
    this._defaultProvider = provider;
    this._defaultModel = model;
    this._cheapModel = cheapModel;
    logger.info(`LLMProvider configured: provider=${provider}, model=${model}, cheap=${cheapModel}`);
  }

  /**
   * Register custom OpenAI-compatible providers from config.
   * Call after configure() in daemon.ts / cli.ts.
   */
  registerCustomProviders(providers: Record<string, { baseUrl: string; apiKey: string; displayName: string; enabled: boolean }>): void {
    for (const [name, cfg] of Object.entries(providers)) {
      if (cfg.enabled && cfg.baseUrl) {
        this._customProviders.set(name, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, displayName: cfg.displayName || name });
        logger.info(`Custom provider registered: ${name} → ${cfg.baseUrl}`);
      }
    }
  }

  /** Get registered custom providers (for test-agent, etc.) */
  getCustomProviders(): Map<string, { baseUrl: string; apiKey: string; displayName: string }> {
    return this._customProviders;
  }

  /** Get the currently configured default provider */
  get defaultProvider(): string { return this._defaultProvider; }
  /** Get the currently configured cheap model */
  get cheapModel(): string { return this._cheapModel; }

  /**
   * Call an LLM provider with the given options.
   * Claude uses Agent SDK (CLI OAuth), others use direct fetch.
   */
  async call(opts: LLMCallOptions): Promise<LLMResponse> {
    logger.debug(`LLMProvider.call: ${opts.provider}/${opts.model}`, { taskId: opts.taskId, agentic: !!opts.agenticMode, tokens: opts.maxTokens });

    return withRetry(async () => {
      switch (opts.provider) {
        case "claude":
          return callClaude(opts);
        case "gpt":
          return callGPT(opts);
        case "gemini":
          return callGemini(opts);
        case "ollama":
          return callOllama(opts);
        case "lmstudio":
          return callLMStudio(opts);
        case "kiro": {
          const cfg = await loadConfig();
          const kiroConfig: KiroAgentConfig = {
            enabled: cfg.agents.kiro?.enabled ?? false,
            model: cfg.agents.kiro?.model ?? opts.model,
            agent: cfg.agents.kiro?.agent ?? "",
            timeout: cfg.agents.kiro?.timeout ?? 120,
            forwardMcpServers: cfg.agents.kiro?.forwardMcpServers ?? [],
          };
          return callKiro(opts, kiroConfig);
        }
        default: {
          // Check if it's a registered custom OpenAI-compatible provider
          const custom = this._customProviders.get(opts.provider);
          if (custom) {
            return callOpenAICompatible(opts, custom.baseUrl, custom.displayName || opts.provider, custom.apiKey || undefined);
          }
          throw new LLMProviderError("unknown", 400, `Unknown provider: ${String(opts.provider)}`, false);
        }
      }
    }, opts.provider);
  }

  /**
   * Provider-agnostic quick call — uses the configured default provider.
   * All auxiliary operations (planning, simulation, memory, reflection) should use this.
   * @param systemPrompt - System prompt
   * @param userMessage - User message
   * @param model - Model override (default: cheap model from configure())
   * @param json - Whether to request JSON response format
   */
  async quickCall(systemPrompt: string, userMessage: string, model?: string, json = false): Promise<LLMResponse> {
    return this.call({
      provider: this._defaultProvider,
      model: model ?? this._cheapModel,
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      responseFormat: json ? "json" : "text",
    });
  }

  /**
   * @deprecated Use quickCall() instead — quickClaude() ignores configured provider.
   * Kept for backward compatibility; now delegates to quickCall().
   */
  async quickClaude(systemPrompt: string, userMessage: string, _model?: string, json = false): Promise<LLMResponse> {
    return this.quickCall(systemPrompt, userMessage, undefined, json);
  }

  /**
   * Vision call — passes an image to the best available vision model.
   * Priority: Anthropic API → OpenAI GPT-4o → Gemini
   */
  async quickVision(
    systemPrompt: string,
    userMessage: string,
    imageBase64: string,
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = "image/jpeg",
    model?: string,
  ): Promise<LLMResponse> {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      return callClaudeVision(systemPrompt, userMessage, imageBase64, mimeType, model ?? "claude-opus-4-6", anthropicKey);
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      return callGPTVision(systemPrompt, userMessage, imageBase64, mimeType, openaiKey);
    }

    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) {
      return callGeminiVision(systemPrompt, userMessage, imageBase64, mimeType, googleKey);
    }

    // No API keys — fall back to Agent SDK (CLI OAuth) with temp file
    return callClaudeSDKVision(systemPrompt, userMessage, imageBase64, mimeType, model ?? "claude-sonnet-4-6");
  }

  /**
   * Transcribe audio using OpenAI Whisper API.
   * Falls back to local `whisper` CLI if no API key.
   */
  async transcribeAudio(audioBuffer: Buffer, language = "cs"): Promise<string> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      return transcribeWithWhisperAPI(audioBuffer, openaiKey, language);
    }
    return transcribeWithLocalWhisper(audioBuffer, language);
  }
}
