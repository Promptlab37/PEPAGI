// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — HTTP + WebSocket Server
// Serves static files, REST API, and WebSocket for real-time events
// ═══════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Logger } from "../core/logger.js";
import type { TaskStore } from "../core/task-store.js";
import type { Mediator } from "../core/mediator.js";
import { StateBridge } from "./state-bridge.js";
import {
  handleGetState, handleGetHealth, handlePostTask, handleGetTask,
  handleGetConfig, handlePutConfig, handleTestAgent,
  handleGetMemory, handleGetAudit, handleGetCausal, handleGetSkills,
  handleToggleAgent, handleKillAgent,
  type RestDeps,
} from "./rest-api.js";

const logger = new Logger("WebDashboard");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

/** Resolve the static files directory. Works in both dev (tsx) and prod (tsc). */
function resolvePublicDir(): string {
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  // In dev: src/web/ → src/web/public
  // In prod: dist/web/ → dist/web/public OR src/web/public (if copy step ran)
  const candidate1 = resolve(thisDir, "public");
  const candidate2 = resolve(thisDir, "..", "..", "src", "web", "public");
  // Try production path first (dist/web/public), fall back to source
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").statSync(candidate1);
    return candidate1;
  } catch {
    return candidate2;
  }
}

export class WebDashboardServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private bridge: StateBridge;
  private publicDir: string;
  private readonly port: number;
  private readonly startTime: number;
  private pool: import("../agents/agent-pool.js").AgentPool | null;

  constructor(
    private readonly taskStore: TaskStore,
    private readonly mediator: Mediator,
    opts?: { port?: number; pool?: import("../agents/agent-pool.js").AgentPool },
  ) {
    this.pool = opts?.pool ?? null;
    this.port = opts?.port ?? 3100;
    this.bridge = new StateBridge();
    this.publicDir = resolvePublicDir();
    this.startTime = Date.now();
  }

  /** Start the HTTP + WebSocket server. */
  async start(): Promise<void> {
    this.bridge.start();

    const deps: RestDeps = {
      bridge: this.bridge,
      taskStore: this.taskStore,
      mediator: this.mediator,
      startTime: this.startTime,
      pool: this.pool ?? undefined,
    };

    this.httpServer = createServer((req, res) => {
      // CORS for localhost
      res.setHeader("Access-Control-Allow-Origin", "http://localhost:" + this.port);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      void this.handleRequest(req, res, deps);
    });

    // WebSocket server on same HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws: WebSocket) => {
      this.bridge.addClient(ws);
      ws.on("close", () => this.bridge.removeClient(ws));
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          if (msg["type"] === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          } else if (msg["type"] === "submit_task") {
            const desc = msg["description"];
            if (typeof desc === "string" && desc.trim()) {
              const task = this.taskStore.create({
                title: desc.slice(0, 120),
                description: desc,
                priority: "medium",
              });
              this.mediator.processTask(task.id).catch((err) => {
                logger.error("processTask failed", { taskId: task.id, error: String(err) });
              });
              ws.send(JSON.stringify({ type: "task_created", taskId: task.id }));
            }
          }
        } catch { /* ignore malformed messages */ }
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, "127.0.0.1", () => {
        logger.info("Web dashboard started", { port: this.port, publicDir: this.publicDir });
        resolve();
      });
      this.httpServer!.on("error", (err) => {
        logger.error("Web dashboard failed to start", { error: String(err) });
        reject(err);
      });
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    this.bridge.stop();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  // ── Request router ─────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const path = url.pathname;

    try {
      // API routes
      if (path === "/api/state" && req.method === "GET") {
        handleGetState(deps, req, res);
        return;
      }
      if (path === "/api/health" && req.method === "GET") {
        handleGetHealth(deps, req, res);
        return;
      }
      if (path === "/api/task" && req.method === "POST") {
        await handlePostTask(deps, req, res);
        return;
      }
      const taskMatch = path.match(/^\/api\/tasks\/(.+)$/);
      if (taskMatch && req.method === "GET") {
        handleGetTask(deps, req, res, taskMatch[1]!);
        return;
      }
      if (path === "/api/config" && req.method === "GET") {
        await handleGetConfig(deps, req, res);
        return;
      }
      if (path === "/api/config" && req.method === "PUT") {
        await handlePutConfig(deps, req, res);
        return;
      }
      if (path === "/api/config/test-agent" && req.method === "POST") {
        await handleTestAgent(deps, req, res);
        return;
      }
      // Data endpoints (for overlay views)
      const memMatch = path.match(/^\/api\/memory\/(.+)$/);
      if (memMatch && req.method === "GET") {
        await handleGetMemory(deps, req, res, memMatch[1]!);
        return;
      }
      if (path === "/api/audit" && req.method === "GET") {
        await handleGetAudit(deps, req, res);
        return;
      }
      if (path === "/api/causal" && req.method === "GET") {
        await handleGetCausal(deps, req, res);
        return;
      }
      if (path === "/api/skills" && req.method === "GET") {
        await handleGetSkills(deps, req, res);
        return;
      }
      if (path === "/api/agent/toggle" && req.method === "POST") {
        await handleToggleAgent(deps, req, res);
        return;
      }
      if (path === "/api/agent/kill" && req.method === "POST") {
        await handleKillAgent(deps, req, res);
        return;
      }

      // Static files
      await this.serveStatic(path, res);
    } catch (err) {
      logger.error("Request error", { path, error: String(err) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  // ── Static file server ─────────────────────────────────────

  private async serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
    // Map "/" to "/index.html", "/settings" to "/settings.html"
    let filePath = urlPath === "/" ? "/index.html"
      : urlPath === "/settings" ? "/settings.html"
      : urlPath;

    // Prevent path traversal
    const normalized = normalize(filePath);
    if (normalized.includes("..")) {
      res.writeHead(403); res.end("Forbidden"); return;
    }

    const fullPath = join(this.publicDir, normalized);

    // Check file exists
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) { this.send404(res); return; }
    } catch {
      this.send404(res); return;
    }

    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = await readFile(fullPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Cache-Control": "no-cache, must-revalidate",
      });
      res.end(content);
    } catch {
      this.send404(res);
    }
  }

  private send404(res: ServerResponse): void {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
