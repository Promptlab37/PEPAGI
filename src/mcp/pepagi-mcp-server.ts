// ═══════════════════════════════════════════════════════════════
// PEPAGI — MCP Server (Model Context Protocol 2024-11-05)
// Exposes PepagiAGI capabilities as MCP tools over HTTP + stdio.
// ═══════════════════════════════════════════════════════════════

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
import type { MemorySystem } from "../memory/memory-system.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { Logger } from "../core/logger.js";
import { auditLog } from "../security/audit-log.js";
import { inputSanitizer } from "../security/input-sanitizer.js";

const logger = new Logger("MCPServer");

// ─── MCP Protocol Types ──────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// JSON-RPC 2.0 error codes
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// ─── MCP Tool Definitions ────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "process_task",
    description:
      "Submit a task to PepagiAGI for intelligent processing. The system will analyze, decompose if needed, and execute using the best available AI agent.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "The task to process",
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Task priority",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "get_status",
    description:
      "Get current PepagiAGI system status: active tasks, costs, agent availability.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_memory",
    description:
      "Search PepagiAGI's memory for relevant facts, episodes, and learned procedures.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        memory_type: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "all"],
          description: "Which memory layer to search",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_skills",
    description: "List all dynamically loaded PepagiAGI skills.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
] as const;

// ─── SEC-12: Schema Pinning ─────────────────────────────────────

// SECURITY: SEC-12 — Pin tool schema hashes at module load time.
// Any runtime modification of tool definitions is detected.
const PINNED_SCHEMA_HASH = createHash("sha256")
  .update(JSON.stringify(MCP_TOOLS))
  .digest("hex");

/**
 * SECURITY: SEC-12 — Verify that MCP tool schemas have not been modified at runtime.
 */
export function verifyMCPSchemaIntegrity(): boolean {
  const currentHash = createHash("sha256")
    .update(JSON.stringify(MCP_TOOLS))
    .digest("hex");
  return currentHash === PINNED_SCHEMA_HASH;
}

/**
 * SECURITY: SEC-12 — Scan tool descriptions for injection patterns.
 * Returns issues found in tool descriptions.
 */
export function scanToolDescriptions(): string[] {
  const issues: string[] = [];
  const INJECTION_PATTERNS = [
    /ignore\s+(?:all|previous)\s+instructions/i,
    /you\s+are\s+now/i,
    /\[SYSTEM\]/i,
    /<<SYS>>/i,
    /<pepagi:context/i,
  ];

  for (const tool of MCP_TOOLS) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(tool.description)) {
        issues.push(`Tool "${tool.name}" description contains injection pattern: ${pattern.source}`);
      }
    }
  }
  return issues;
}

// ─── SEC-23: Zod schemas for MCP tool parameter validation ────

// SECURITY: SEC-23 — All MCP tool inputs validated with Zod schemas
const ProcessTaskParamsSchema = z.object({
  description: z.string().min(1).max(10_000),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
});

const SearchMemoryParamsSchema = z.object({
  query: z.string().min(1).max(2000),
  memory_type: z.enum(["episodic", "semantic", "procedural", "all"]).optional(),
});

const ToolsCallParamsSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// ─── MCPServerOptions ────────────────────────────────────────

export interface MCPServerOptions {
  /** HTTP port. Default: 3099 */
  port?: number;
  /** Also listen on stdio. Default: false */
  stdio?: boolean;
}

// ─── Per-IP rate limiter state ────────────────────────────────
// SEC-01: Tracks request count per IP in a rolling 60-second window.
interface RateLimitEntry {
  count: number;
  windowStart: number;
}
const ipRateMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 60;       // max requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1-minute rolling window

// SEC-04: Connection rate limiting — max new connections per IP per minute
const connRateMap = new Map<string, RateLimitEntry>();
const CONN_RATE_LIMIT_MAX = 20;  // max new connections per minute per IP
const MAX_CONCURRENT_CONNECTIONS = 50; // max total concurrent connections
let activeConnections = 0;

// SECURITY: SEC-04 — Connection-level rate limiting
function isConnectionRateLimited(ip: string): boolean {
  const now = Date.now();
  if (connRateMap.size > 200) {
    for (const [k, v] of connRateMap) {
      if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) connRateMap.delete(k);
    }
  }
  const entry = connRateMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    connRateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > CONN_RATE_LIMIT_MAX;
}

/** Returns true if the IP has exceeded its rate limit. */
function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // AUD-07: periodic eviction — purge stale entries every 100 calls to prevent unbounded growth
  if (ipRateMap.size > 200) {
    for (const [k, v] of ipRateMap) {
      if (now - v.windowStart >= RATE_LIMIT_WINDOW_MS) ipRateMap.delete(k);
    }
  }

  const entry = ipRateMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // Start a fresh window for this IP
    ipRateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return true; // SEC-01: exceeded 60 req/min — return 429
  }
  return false;
}

// ─── MCPServer ───────────────────────────────────────────────

/**
 * MCP (Model Context Protocol) server that exposes PepagiAGI as a set of
 * JSON-RPC 2.0 tools consumable by Claude.ai and other MCP-compatible clients.
 *
 * Transport: HTTP on `options.port` (default 3099) + optional stdio.
 * Protocol version: 2024-11-05.
 *
 * SEC-01: Binds on 127.0.0.1 only (localhost), not 0.0.0.0.
 * SEC-01: Requires Bearer token if MCP_TOKEN env var is set.
 * SEC-01: Enforces per-IP rate limiting (60 req/min).
 */
export class MCPServer {
  private httpServer: Server | null = null;
  private stdioListening = false;

  // SEC-01: Read token from env once at construction time.
  private readonly mcpToken: string | undefined = process.env.MCP_TOKEN || undefined;

  // SEC-04: Whether to require MCP_TOKEN (default: true for security)
  private readonly requireToken: boolean;

  constructor(
    private readonly mediator: Mediator,
    private readonly taskStore: TaskStore,
    private readonly memory: MemorySystem | null,
    private readonly skillRegistry: SkillRegistry | null,
    private readonly options: MCPServerOptions = {},
  ) {
    // SEC-04: By default require token. Only skip if MCP_ALLOW_NO_TOKEN=true explicitly.
    this.requireToken = process.env.MCP_ALLOW_NO_TOKEN !== "true";

    if (!this.mcpToken && this.requireToken) {
      logger.error(
        "SEC-04: MCP_TOKEN is not set — MCP server will refuse to start. " +
        "Set MCP_TOKEN in your environment or set MCP_ALLOW_NO_TOKEN=true to allow unauthenticated access.",
      );
    } else if (!this.mcpToken) {
      logger.warn(
        "MCP server: MCP_TOKEN is not set — Bearer token authentication is DISABLED. " +
        "Set MCP_TOKEN in your environment to enable auth.",
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Start the MCP server (HTTP and optionally stdio).
   */
  async start(): Promise<void> {
    await this.startHttp();
    if (this.options.stdio) {
      this.startStdio();
    }
  }

  /**
   * Stop the MCP server gracefully.
   */
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.httpServer = null;
    // AUDIT: remove stdin listener to prevent leak on restart
    if (this.stdinHandler) {
      process.stdin.removeListener("data", this.stdinHandler);
      this.stdinHandler = null;
      this.stdioListening = false;
    }
    logger.info("MCP server stopped");
  }

  // ── HTTP Transport ─────────────────────────────────────────

  private startHttp(): Promise<void> {
    // SEC-04: Refuse to start without MCP_TOKEN when required
    if (!this.mcpToken && this.requireToken) {
      return Promise.reject(new Error(
        "SEC-04: MCP_TOKEN environment variable is required. Set MCP_TOKEN or MCP_ALLOW_NO_TOKEN=true.",
      ));
    }

    const port = this.options.port ?? 3099;

    return new Promise((resolve, reject) => {
      this.httpServer = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          // SEC-04: Track concurrent connections
          const clientIp = req.socket.remoteAddress ?? "unknown";
          if (activeConnections >= MAX_CONCURRENT_CONNECTIONS) {
            logger.warn("SEC-04: Max concurrent connections reached", { active: activeConnections, ip: clientIp });
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Service Unavailable — too many concurrent connections" }));
            return;
          }
          if (isConnectionRateLimited(clientIp)) {
            logger.warn("SEC-04: Connection rate limit exceeded", { ip: clientIp });
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Too Many Connections — max 20 new connections/min per IP" }));
            return;
          }
          activeConnections++;
          res.on("close", () => { activeConnections--; });

          void this.handleHttpRequest(req, res);
        },
      );

      this.httpServer.once("error", reject);

      // SEC-01: Bind on 127.0.0.1 only — was "0.0.0.0" which exposed the server
      // to any device on the LAN without any authentication.
      this.httpServer.listen(port, "127.0.0.1", () => {
        logger.info("MCP HTTP server listening", { port, host: "127.0.0.1" });
        resolve();
      });
    });
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // SEC-04: Validate Origin header — block cross-origin requests
    const requestOrigin = req.headers["origin"];
    const allowedOrigin = process.env.MCP_CORS_ORIGIN ?? "http://localhost";
    // SEC-04: Only allow exact localhost origins (with optional port)
    const isLocalhostOrigin = requestOrigin
      ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)
      : true; // no Origin header = same-origin request (allowed)
    if (requestOrigin && requestOrigin !== allowedOrigin && !isLocalhostOrigin) {
      logger.warn("SEC-04: Cross-origin request blocked", { origin: requestOrigin });
      void auditLog({ actionType: "mcp:cors_blocked", details: `Origin: ${requestOrigin}`, outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden — cross-origin requests not allowed" }));
      return;
    }

    // SEC-01: Restrict CORS to localhost only
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    // SEC-04: Prevent MIME sniffing and embedding
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return; // SEC-01: OPTIONS preflight is exempt from auth/rate-limit checks.
    }

    // SEC-01: Per-IP rate limiting — prevent request floods from a single client.
    // OPUS: x-forwarded-for is trivially spoofable — since we bind on 127.0.0.1
    // only, remoteAddress is always reliable. Trusting x-forwarded-for allows
    // any client to bypass rate limiting by sending a fake header.
    const clientIp = req.socket.remoteAddress ?? "unknown";

    if (isRateLimited(clientIp)) {
      logger.warn("MCP rate limit exceeded", { ip: clientIp });
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too Many Requests — max 60 req/min per IP" }));
      return;
    }

    // SEC-01: Bearer token authentication — enforce when MCP_TOKEN is configured.
    if (this.mcpToken) {
      const authHeader = req.headers["authorization"] ?? "";
      const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (provided !== this.mcpToken) {
        logger.warn("MCP auth failure", { ip: clientIp });
        // SECURITY: SEC-23 — Audit log auth failures
        void auditLog({ actionType: "mcp:auth_failed", details: `IP: ${clientIp}`, outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized — valid Bearer token required" }));
        return;
      }
    }

    const url = req.url ?? "/";

    // Health check endpoint
    if (req.method === "GET" && url === "/health") {
      // OPS-03: /health was returning only {status:"ok"} with no diagnostic data.
      // Now returns process uptime, memory usage, task queue depth, and version.
      const stats = this.taskStore.getStats();
      this.sendJson(res, 200, {
        status: "ok",
        service: "pepagi-mcp",
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        timestamp: new Date().toISOString(),
        tasks: {
          total: stats.total,
          pending: stats.pending,
          running: stats.running,
          completed: stats.completed,
          failed: stats.failed,
        },
        version: "0.4.0",
      });
      return;
    }

    // MCP JSON-RPC endpoint
    if (req.method === "POST" && url === "/mcp") {
      // OPUS: enforce body size limit to prevent OOM via oversized POST payload.
      const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
      let body = "";
      let bodyBytes = 0;
      for await (const chunk of req) {
        const str = chunk as string;
        bodyBytes += Buffer.byteLength(str);
        if (bodyBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large — max 1 MB" }));
          return;
        }
        body += str;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        const errResp: JsonRpcError = {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_PARSE_ERROR, message: "Parse error" },
        };
        this.sendJson(res, 400, errResp);
        return;
      }

      const response = await this.handleJsonRpc(parsed);
      this.sendJson(res, 200, response);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }

  // ── Stdio Transport ────────────────────────────────────────

  // AUDIT: store stdin handler reference so it can be removed in stop()
  private stdinHandler: ((chunk: string) => void) | null = null;

  private startStdio(): void {
    if (this.stdioListening) return;
    this.stdioListening = true;

    let buffer = "";

    process.stdin.setEncoding("utf8");
    this.stdinHandler = (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          const errResp: JsonRpcError = {
            jsonrpc: "2.0",
            id: null,
            error: { code: RPC_PARSE_ERROR, message: "Parse error" },
          };
          process.stdout.write(JSON.stringify(errResp) + "\n");
          continue;
        }

        void this.handleJsonRpc(parsed).then(resp => {
          process.stdout.write(JSON.stringify(resp) + "\n");
        });
      }
    };
    process.stdin.on("data", this.stdinHandler);

    logger.info("MCP stdio transport active");
  }

  // ── JSON-RPC Dispatcher ─────────────────────────────────────

  private async handleJsonRpc(raw: unknown): Promise<JsonRpcResponse> {
    // Validate basic JSON-RPC structure
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as Record<string, unknown>)["jsonrpc"] !== "2.0"
    ) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_INVALID_REQUEST, message: "Invalid Request" },
      };
    }

    const req = raw as JsonRpcRequest;
    const id = req.id ?? null;

    if (typeof req.method !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_INVALID_REQUEST, message: "Missing method" },
      };
    }

    logger.debug("MCP request", { method: req.method, id });

    try {
      switch (req.method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: this.handleInitialize() };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: this.handleToolsList() };

        case "tools/call":
          return {
            jsonrpc: "2.0",
            id,
            result: await this.handleToolsCall(req.params),
          };

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_METHOD_NOT_FOUND,
              message: `Method not found: ${req.method}`,
            },
          };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      logger.error("MCP handler error", { method: req.method, error: message });
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_INTERNAL_ERROR, message: `Internal error: ${message}` },
      };
    }
  }

  // ── MCP Method Handlers ─────────────────────────────────────

  /**
   * Handle `initialize` — return server capabilities.
   */
  private handleInitialize(): unknown {
    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "pepagi",
        version: "0.2.0",
      },
    };
  }

  /**
   * Handle `tools/list` — return available tool definitions.
   */
  private handleToolsList(): unknown {
    return { tools: MCP_TOOLS };
  }

  /**
   * Handle `tools/call` — dispatch to the named tool implementation.
   */
  private async handleToolsCall(params: unknown): Promise<unknown> {
    // SECURITY: SEC-12 — Verify schema integrity before processing
    if (!verifyMCPSchemaIntegrity()) {
      logger.error("SEC-12: MCP tool schema integrity violation!");
      await auditLog({ actionType: "mcp:schema_tampered", details: "Schema hash mismatch", outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
      throw new Error("Internal error: schema integrity check failed");
    }

    // SECURITY: SEC-23 — Validate tools/call envelope with Zod
    const parsed = ToolsCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      const errorMsg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw Object.assign(new Error(`Invalid params: ${errorMsg}`), {
        code: RPC_INVALID_PARAMS,
      });
    }

    const { name, arguments: args } = parsed.data;
    const toolArgs = args ?? {};

    logger.info("MCP tool call", { tool: name });

    // SECURITY: SEC-23 — Audit log every MCP tool call
    await auditLog({
      actionType: `mcp:tool_call`,
      details: `Tool: ${name}, args: ${JSON.stringify(toolArgs).slice(0, 200)}`,
      outcome: "allowed",
    }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));

    switch (name) {
      case "process_task":
        return this.toolProcessTask(toolArgs);

      case "get_status":
        return this.toolGetStatus();

      case "search_memory":
        return this.toolSearchMemory(toolArgs);

      case "list_skills":
        return this.toolListSkills();

      default:
        throw Object.assign(new Error(`Unknown tool: ${name}`), {
          code: RPC_METHOD_NOT_FOUND,
        });
    }
  }

  // ── Tool Implementations ────────────────────────────────────

  /**
   * Tool: process_task
   * Creates a task in the TaskStore and runs it through the Mediator.
   */
  private async toolProcessTask(args: Record<string, unknown>): Promise<unknown> {
    // SECURITY: SEC-23 — Validate process_task params with Zod
    const parsed = ProcessTaskParamsSchema.safeParse(args);
    if (!parsed.success) {
      const errorMsg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`process_task: invalid params — ${errorMsg}`);
    }

    const { description, priority } = parsed.data;
    const resolvedPriority = priority ?? "medium";

    // SECURITY: SEC-01 — Sanitize task description from MCP (untrusted external)
    const sanitizeResult = await inputSanitizer.sanitize(description, "UNTRUSTED_EXTERNAL");
    if (sanitizeResult.riskScore > 0.7) {
      logger.warn("MCP process_task: high injection risk", { riskScore: sanitizeResult.riskScore, threats: sanitizeResult.threats });
      await auditLog({ actionType: "mcp:injection_blocked", details: `Risk: ${sanitizeResult.riskScore}`, outcome: "blocked" }).catch(e => logger.debug("FIX: audit log write failed", { error: String(e) }));
      return {
        content: [{ type: "text", text: `Task rejected: high injection risk (${sanitizeResult.riskScore.toFixed(2)})` }],
        isError: true,
      };
    }

    // Create the task in the store
    const task = this.taskStore.create({
      title: description.slice(0, 80),
      description: description.trim(),
      priority: resolvedPriority,
      tags: ["mcp"],
    });

    logger.info("MCP: created task", { taskId: task.id, priority: resolvedPriority });

    try {
      const output = await this.mediator.processTask(task.id);

      const resultText =
        typeof output.result === "string"
          ? output.result
          : JSON.stringify(output.result, null, 2);

      const text =
        `Task completed (${output.success ? "success" : "failure"}).\n` +
        `Confidence: ${(output.confidence * 100).toFixed(0)}%\n` +
        `Summary: ${output.summary}\n` +
        (resultText ? `\nResult:\n${resultText}` : "");

      return {
        content: [{ type: "text", text }],
        isError: !output.success,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("MCP: process_task failed", { taskId: task.id, error: message });
      return {
        content: [{ type: "text", text: `Task failed: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Tool: get_status
   * Returns formatted system status from TaskStore.
   */
  private toolGetStatus(): unknown {
    const stats = this.taskStore.getStats();

    const text =
      `PepagiAGI System Status\n` +
      `══════════════════════\n` +
      `Total tasks:     ${stats.total}\n` +
      `Pending:         ${stats.pending}\n` +
      `Running:         ${stats.running}\n` +
      `Completed:       ${stats.completed}\n` +
      `Failed:          ${stats.failed}\n` +
      `Session cost:    $${stats.totalCost.toFixed(4)}\n`;

    return {
      content: [{ type: "text", text }],
    };
  }

  /**
   * Tool: search_memory
   * Searches the MemorySystem across the requested memory layer(s).
   */
  private async toolSearchMemory(args: Record<string, unknown>): Promise<unknown> {
    // SECURITY: SEC-23 — Validate search_memory params with Zod
    const parsed = SearchMemoryParamsSchema.safeParse(args);
    if (!parsed.success) {
      const errorMsg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`search_memory: invalid params — ${errorMsg}`);
    }
    const { query, memory_type: memoryType = "all" } = parsed.data;

    if (!this.memory) {
      return {
        content: [{ type: "text", text: "Memory system not available" }],
      };
    }

    const results: string[] = [];

    try {
      if (memoryType === "episodic" || memoryType === "all") {
        const episodes = await this.memory.episodic.search(query.trim(), 5);
        if (episodes.length > 0) {
          results.push("## Episodic Memory (past tasks)");
          for (const ep of episodes) {
            const outcome = ep.success ? "[OK]" : "[FAIL]";
            results.push(
              `${outcome} ${ep.taskTitle} — ${ep.resultSummary} (cost: $${ep.cost.toFixed(4)}, ${new Date(ep.timestamp).toLocaleDateString()})`,
            );
          }
        }
      }

      if (memoryType === "semantic" || memoryType === "all") {
        const facts = await this.memory.semantic.search(query.trim(), 5);
        if (facts.length > 0) {
          results.push("## Semantic Memory (known facts)");
          for (const fact of facts) {
            results.push(
              `• ${fact.fact} [confidence: ${(fact.confidence * 100).toFixed(0)}%]`,
            );
          }
        }
      }

      if (memoryType === "procedural" || memoryType === "all") {
        const proc = await this.memory.procedural.findMatch(query.trim());
        if (proc) {
          results.push("## Procedural Memory (known procedure)");
          results.push(`Procedure: ${proc.name}`);
          results.push(`Success rate: ${(proc.successRate * 100).toFixed(0)}%`);
          results.push(
            "Steps:\n" +
              proc.steps
                .slice(0, 5)
                .map((s, i) => `  ${i + 1}. ${s}`)
                .join("\n"),
          );
        }
      }
    } catch (err) {
      logger.warn("MCP: memory search error", { error: String(err) });
      return {
        content: [
          {
            type: "text",
            text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    const text =
      results.length > 0
        ? results.join("\n")
        : `No memory results found for query: "${query}"`;

    return {
      content: [{ type: "text", text }],
    };
  }

  /**
   * Tool: list_skills
   * Returns all skills currently registered in the SkillRegistry.
   */
  private toolListSkills(): unknown {
    if (!this.skillRegistry || this.skillRegistry.size === 0) {
      return {
        content: [{ type: "text", text: "No skills loaded" }],
      };
    }

    const skills = this.skillRegistry.list();
    const lines: string[] = [`PepagiAGI Skills (${skills.length} loaded)`, "═".repeat(40)];

    for (const skill of skills) {
      lines.push(`\n[${skill.name}]`);
      lines.push(`  Description: ${skill.description}`);
      if (skill.tags && skill.tags.length > 0) {
        lines.push(`  Tags: ${skill.tags.join(", ")}`);
      }
      lines.push(
        `  Triggers: ${skill.triggers.slice(0, 3).join(" | ")}${skill.triggers.length > 3 ? ` (+${skill.triggers.length - 3} more)` : ""}`,
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
}
