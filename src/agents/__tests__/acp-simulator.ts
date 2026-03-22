#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// ACP Subprocess Simulator — Layer 1 Testing Infrastructure
// ═══════════════════════════════════════════════════════════════
//
// Standalone script that behaves like `kiro-cli acp`.
// Reads JSON-RPC 2.0 from stdin, writes ACP responses to stdout.
// Scenario-driven via ACP_SCENARIO env var.
//
// Spawnable via: node dist/agents/__tests__/acp-simulator.js
// ═══════════════════════════════════════════════════════════════

import { createInterface } from "node:readline";

// ─── Types ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

// ─── Env Config ──────────────────────────────────────────────

const SCENARIO = process.env.ACP_SCENARIO ?? "happy-path";
const EXPECTED_AGENT = process.env.ACP_AGENT ?? "";
const EXPECTED_MCP_SERVERS = process.env.ACP_MCP_SERVERS ?? "";

// ─── Helpers ─────────────────────────────────────────────────

function send(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id: number, result: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ─── Scenario Handlers ──────────────────────────────────────

/** Track captured stdin requests for env-var validation */
const capturedRequests: JsonRpcRequest[] = [];

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  capturedRequests.push(req);

  switch (SCENARIO) {
    case "happy-path":
      return handleHappyPath(req);
    case "happy-no-usage":
      return handleHappyNoUsage(req);
    case "error-on-session-new":
      return handleErrorOnSessionNew(req);
    case "error-on-prompt":
      return handleErrorOnPrompt(req);
    case "hang-on-initialize":
      return handleHangOnInitialize(req);
    case "crash-mid-stream":
      return handleCrashMidStream(req);
    case "malformed-json":
      return handleMalformedJson(req);
    case "slow-chunks":
      return handleSlowChunks(req);
    case "partial-lines":
      return handlePartialLines(req);
    case "sigterm-graceful":
      return handleSigtermGraceful(req);
    case "sigterm-ignore":
      return handleSigtermIgnore(req);
    default:
      sendError(req.id, -32601, `Unknown scenario: ${SCENARIO}`);
  }
}

// ─── happy-path ──────────────────────────────────────────────

async function handleHappyPath(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      validateMcpServers(req);
      sendResponse(req.id, {
        sessionId: "sim-session-001",
        modes: {
          availableModes: [
            { id: "kiro_default", description: "Default mode" },
            { id: "kiro_planner", description: "Planner mode" },
          ],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      // Emit 3 agent_message_chunk updates via session/update
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Hello, " },
        },
      });
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "I am " },
        },
      });
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Kiro." },
        },
      });

      // Emit 1 tool_call update
      sendNotification("session/update", {
        update: {
          sessionUpdate: "tool_call",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
          id: "tc-001",
        },
      });

      // Emit usage_update
      sendNotification("session/update", {
        update: {
          sessionUpdate: "usage_update",
          contextWindow: { used: 1500, size: 200000 },
          cost: { amount: 0.0042, currency: "USD" },
        },
      });

      // Send prompt response with stopReason and usage (no TurnEnd notification)
      sendResponse(req.id, {
        stopReason: "end_turn",
        usage: {
          total_tokens: 350,
          input_tokens: 200,
          output_tokens: 150,
          thought_tokens: 0,
          cached_read_tokens: 0,
          cached_write_tokens: 0,
        },
      });
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}


// ─── happy-no-usage ──────────────────────────────────────────

async function handleHappyNoUsage(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-002",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Response without usage data." },
        },
      });
      // No usage_update notification, no usage in response
      sendResponse(req.id, { stopReason: "end_turn" });
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── error-on-session-new ────────────────────────────────────

async function handleErrorOnSessionNew(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendError(req.id, -32000, "Session creation failed: workspace not found");
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── error-on-prompt ─────────────────────────────────────────

async function handleErrorOnPrompt(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-err",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      sendError(req.id, -32003, "Prompt execution failed: context window exceeded");
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── hang-on-initialize ──────────────────────────────────────

async function handleHangOnInitialize(req: JsonRpcRequest): Promise<void> {
  if (req.method === "initialize") {
    // Never respond — tests should hit the 10s timeout
    return;
  }
  sendError(req.id, -32601, `Method not found: ${req.method}`);
}


// ─── crash-mid-stream ────────────────────────────────────────

async function handleCrashMidStream(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-crash",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      // Emit 2 chunks then crash
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Starting " },
        },
      });
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "response..." },
        },
      });
      // Exit with non-zero code to simulate crash
      process.exit(1);
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── malformed-json ──────────────────────────────────────────

async function handleMalformedJson(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-malformed",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      // Emit valid chunk
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Valid chunk." },
        },
      });
      // Emit garbage line
      process.stdout.write("THIS IS NOT VALID JSON\n");
      // Emit another valid chunk
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: " More valid data." },
        },
      });
      // Prompt response with stopReason (no TurnEnd)
      sendResponse(req.id, { stopReason: "end_turn" });
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── slow-chunks ─────────────────────────────────────────────

async function handleSlowChunks(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-slow",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      for (let i = 0; i < 5; i++) {
        await sleep(500);
        sendNotification("session/update", {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: `chunk-${i} ` },
          },
        });
      }
      sendResponse(req.id, { stopReason: "end_turn" });
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}


// ─── partial-lines ───────────────────────────────────────────

async function handlePartialLines(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-partial",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt": {
      // Write a JSON-RPC message split across multiple write() calls
      const chunk1 = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "Reassembled content." },
          },
        },
      });
      // Split the message roughly in half
      const mid = Math.floor(chunk1.length / 2);
      process.stdout.write(chunk1.slice(0, mid));
      await sleep(50);
      process.stdout.write(chunk1.slice(mid) + "\n");

      sendResponse(req.id, { stopReason: "end_turn" });
      break;
    }

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── sigterm-graceful ────────────────────────────────────────

let sigtermGracefulPromptId: number | null = null;

async function handleSigtermGraceful(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-sigterm",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      sigtermGracefulPromptId = req.id;
      // Start slow streaming — wait for SIGTERM
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Working on it..." },
        },
      });
      // Keep alive — SIGTERM handler will clean up
      break;

    case "session/cancel":
      sendResponse(req.id, { cancelled: true });
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ─── sigterm-ignore ──────────────────────────────────────────

async function handleSigtermIgnore(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      sendResponse(req.id, {
        protocolVersion: "2025-01-01",
        serverInfo: { name: "kiro-cli-simulator", version: "1.0.0" },
        capabilities: {},
      });
      break;

    case "session/new":
      sendResponse(req.id, {
        sessionId: "sim-session-sigterm-ignore",
        modes: {
          availableModes: [{ id: "kiro_default", description: "Default mode" }],
          currentModeId: "kiro_default",
        },
      });
      break;

    case "session/set_mode":
      sendResponse(req.id, {});
      break;

    case "session/prompt":
      // Start streaming, then hang — ignores SIGTERM
      sendNotification("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "I will not stop..." },
        },
      });
      // Keep alive indefinitely
      break;

    default:
      sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}


// ─── Validation Helpers ──────────────────────────────────────

function validateMcpServers(req: JsonRpcRequest): void {
  if (EXPECTED_MCP_SERVERS && req.params) {
    const received = JSON.stringify(req.params.mcpServers ?? []);
    if (received !== EXPECTED_MCP_SERVERS) {
      process.stderr.write(
        `[simulator] MCP servers mismatch: expected ${EXPECTED_MCP_SERVERS}, got ${received}\n`
      );
    }
  }
}

// ─── Signal Handlers ─────────────────────────────────────────

if (SCENARIO === "sigterm-graceful") {
  process.on("SIGTERM", () => {
    // Send prompt response with stopReason and exit cleanly
    if (sigtermGracefulPromptId !== null) {
      sendResponse(sigtermGracefulPromptId, { stopReason: "end_turn" });
    }
    process.exit(0);
  });
} else if (SCENARIO === "sigterm-ignore") {
  // Explicitly ignore SIGTERM — force caller to escalate to SIGKILL
  process.on("SIGTERM", () => {
    // Do nothing — intentionally ignoring SIGTERM
  });
}

// ─── Validate Spawn Arguments ────────────────────────────────

// Check that the process was spawned with expected arguments
// The caller sets ACP_AGENT to validate --agent passthrough
if (EXPECTED_AGENT) {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf("--agent");
  if (agentIdx === -1 || args[agentIdx + 1] !== EXPECTED_AGENT) {
    process.stderr.write(
      `[simulator] Agent arg mismatch: expected "--agent ${EXPECTED_AGENT}", got args: ${JSON.stringify(args)}\n`
    );
  }
}

// ─── Main: Read stdin line-by-line ───────────────────────────

const rl = createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const req = JSON.parse(trimmed) as JsonRpcRequest;
    if (req.jsonrpc !== "2.0" || typeof req.id !== "number" || typeof req.method !== "string") {
      process.stderr.write(`[simulator] Invalid JSON-RPC request: ${trimmed}\n`);
      return;
    }
    void handleRequest(req);
  } catch {
    process.stderr.write(`[simulator] Failed to parse JSON: ${trimmed}\n`);
  }
});

rl.on("close", () => {
  // stdin closed — exit cleanly unless scenario keeps us alive
  if (SCENARIO !== "sigterm-ignore" && SCENARIO !== "sigterm-graceful" && SCENARIO !== "slow-chunks") {
    process.exit(0);
  }
});

// Keep process alive for scenarios that need it
if (SCENARIO === "hang-on-initialize" || SCENARIO === "sigterm-ignore" || SCENARIO === "sigterm-graceful" || SCENARIO === "slow-chunks") {
  // Prevent Node from exiting while we wait for signals or timeouts
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("exit", () => clearInterval(keepAlive));
}
