// ═══════════════════════════════════════════════════════════════
// PEPAGI Web Dashboard — REST API Handlers
// ═══════════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskStore } from "../core/task-store.js";
import type { Mediator } from "../core/mediator.js";
import type { StateBridge } from "./state-bridge.js";
import type { AgentPool } from "../agents/agent-pool.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { AgentProvider } from "../core/types.js";
import { loadConfig, saveConfig, invalidateConfigCache, type PepagiConfig } from "../config/loader.js";
import { getCheapModel } from "../agents/pricing.js";
import { encrypt, decrypt, isEncrypted } from "../ui/config-crypto.js";

export interface RestDeps {
  bridge: StateBridge;
  taskStore: TaskStore;
  mediator: Mediator;
  startTime: number;
  pool?: AgentPool;
  llm?: LLMProvider;
  onWhatsAppReconnect?: () => Promise<void>;
}

/** Send JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Read request body as string. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX = 64 * 1024; // 64KB max
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Existing handlers ─────────────────────────────────────────

/** GET /api/state — full dashboard state snapshot. */
export function handleGetState(deps: RestDeps, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, deps.bridge.getFullState());
}

/** GET /api/health — health check. */
export function handleGetHealth(deps: RestDeps, _req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, {
    status: "ok",
    uptime: Date.now() - deps.startTime,
    wsClients: deps.bridge.getClientCount(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
}

/** POST /api/task — submit a new task. */
export async function handlePostTask(deps: RestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const description = body["description"];
    if (typeof description !== "string" || description.trim().length === 0) {
      json(res, 400, { error: "Missing 'description' string field" });
      return;
    }
    const priority = typeof body["priority"] === "string" ? body["priority"] : "medium";
    const task = deps.taskStore.create({
      title: description.slice(0, 120),
      description: description,
      priority: priority as "low" | "medium" | "high" | "critical",
    });
    // Process asynchronously — don't wait
    deps.mediator.processTask(task.id).catch((err) => {
      console.error(`[REST] processTask failed: ${String(err)}`);
    });
    json(res, 201, { taskId: task.id, title: task.title });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
}

/** GET /api/tasks/:id — get task details. */
export function handleGetTask(deps: RestDeps, _req: IncomingMessage, res: ServerResponse, taskId: string): void {
  const task = deps.taskStore.get(taskId);
  if (!task) {
    json(res, 404, { error: "Task not found" });
    return;
  }
  json(res, 200, task);
}

// ── Config handlers ───────────────────────────────────────────

const HIDDEN = "[HIDDEN]";

/** Fields that contain sensitive secrets — must be scrubbed before sending to client. */
function scrubSecrets(config: PepagiConfig): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  // Scrub agent API keys
  const agents = c["agents"] as Record<string, Record<string, unknown>> | undefined;
  if (agents) {
    for (const key of Object.keys(agents)) {
      const agent = agents[key];
      if (agent && typeof agent["apiKey"] === "string" && agent["apiKey"].length > 0) {
        agent["apiKey"] = HIDDEN;
      }
    }
  }
  // Scrub platform tokens
  const platforms = c["platforms"] as Record<string, Record<string, unknown>> | undefined;
  if (platforms) {
    if (platforms["telegram"] && typeof platforms["telegram"]["botToken"] === "string" && (platforms["telegram"]["botToken"] as string).length > 0)
      platforms["telegram"]["botToken"] = HIDDEN;
    if (platforms["discord"] && typeof platforms["discord"]["botToken"] === "string" && (platforms["discord"]["botToken"] as string).length > 0)
      platforms["discord"]["botToken"] = HIDDEN;
  }
  // Scrub custom provider API keys
  const customProviders = c["customProviders"] as Record<string, Record<string, unknown>> | undefined;
  if (customProviders) {
    for (const cp of Object.values(customProviders)) {
      if (cp && typeof cp["apiKey"] === "string" && cp["apiKey"].length > 0) {
        cp["apiKey"] = HIDDEN;
      }
    }
  }
  // Scrub Google client secret
  const google = c["google"] as Record<string, unknown> | undefined;
  if (google && typeof google["clientSecret"] === "string" && google["clientSecret"].length > 0) {
    google["clientSecret"] = HIDDEN;
  }
  if (google && typeof google["clientId"] === "string" && google["clientId"].length > 0) {
    google["clientId"] = HIDDEN;
  }
  return c;
}

/** Merge new config values, preserving secrets that weren't changed. */
function mergeConfig(existing: PepagiConfig, incoming: Record<string, unknown>): PepagiConfig {
  const merged = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;

  // Top-level simple fields
  if (incoming["managerProvider"] !== undefined) {
    merged["managerProvider"] = incoming["managerProvider"];
    // When managerProvider changes, auto-set managerModel to that provider's configured model
    // UNLESS the caller also explicitly sent a managerModel for the new provider.
    if (incoming["managerModel"] !== undefined) {
      merged["managerModel"] = incoming["managerModel"];
    } else {
      const newProvider = incoming["managerProvider"] as string;
      const agentsCfg = (merged["agents"] ?? {}) as Record<string, Record<string, unknown>>;
      const providerCfg = agentsCfg[newProvider];
      if (providerCfg && typeof providerCfg["model"] === "string") {
        merged["managerModel"] = providerCfg["model"];
      }
    }
  } else if (incoming["managerModel"] !== undefined) {
    merged["managerModel"] = incoming["managerModel"];
  }

  // Profile
  if (incoming["profile"] && typeof incoming["profile"] === "object") {
    merged["profile"] = { ...(merged["profile"] as object), ...(incoming["profile"] as object) };
  }

  // Agents — merge each, handle apiKey specially
  if (incoming["agents"] && typeof incoming["agents"] === "object") {
    const existAgents = merged["agents"] as Record<string, Record<string, unknown>>;
    const incomingAgents = incoming["agents"] as Record<string, Record<string, unknown>>;
    for (const provider of Object.keys(incomingAgents)) {
      if (!existAgents[provider]) existAgents[provider] = {};
      const src = incomingAgents[provider]!;
      const dst = existAgents[provider]!;
      for (const [k, v] of Object.entries(src)) {
        if (k === "apiKey") {
          if (v === HIDDEN || v === "" || v === undefined) continue; // keep existing
          dst[k] = encrypt(v as string);
        } else {
          dst[k] = v;
        }
      }
    }
  }

  // Platforms — merge each, handle tokens specially
  if (incoming["platforms"] && typeof incoming["platforms"] === "object") {
    const existPlats = merged["platforms"] as Record<string, Record<string, unknown>>;
    const incomingPlats = incoming["platforms"] as Record<string, Record<string, unknown>>;
    for (const name of Object.keys(incomingPlats)) {
      if (!existPlats[name]) existPlats[name] = {};
      const src = incomingPlats[name]!;
      const dst = existPlats[name]!;
      for (const [k, v] of Object.entries(src)) {
        if (k === "botToken") {
          if (v === HIDDEN || v === "" || v === undefined) continue;
          dst[k] = encrypt(v as string);
        } else {
          dst[k] = v;
        }
      }
    }
  }

  // Security
  if (incoming["security"] && typeof incoming["security"] === "object") {
    merged["security"] = { ...(merged["security"] as object), ...(incoming["security"] as object) };
  }

  // Queue
  if (incoming["queue"] && typeof incoming["queue"] === "object") {
    merged["queue"] = { ...(merged["queue"] as object), ...(incoming["queue"] as object) };
  }

  // Custom Providers — merge each, handle apiKey specially
  if (incoming["customProviders"] && typeof incoming["customProviders"] === "object") {
    const existCustom = (merged["customProviders"] ?? {}) as Record<string, Record<string, unknown>>;
    const incomingCustom = incoming["customProviders"] as Record<string, Record<string, unknown>>;
    for (const name of Object.keys(incomingCustom)) {
      if (!existCustom[name]) existCustom[name] = {};
      const src = incomingCustom[name]!;
      const dst = existCustom[name]!;
      for (const [k, v] of Object.entries(src)) {
        if (k === "apiKey") {
          if (v === HIDDEN || v === "" || v === undefined) continue; // keep existing
          dst[k] = encrypt(v as string);
        } else {
          dst[k] = v;
        }
      }
    }
    // Remove providers that were deleted (not present in incoming but user sent the whole object)
    for (const name of Object.keys(existCustom)) {
      if (!(name in incomingCustom)) {
        delete existCustom[name];
      }
    }
    merged["customProviders"] = existCustom;
  }

  // Consciousness
  if (incoming["consciousness"] && typeof incoming["consciousness"] === "object") {
    merged["consciousness"] = { ...(merged["consciousness"] as object), ...(incoming["consciousness"] as object) };
  }

  // Web
  if (incoming["web"] && typeof incoming["web"] === "object") {
    merged["web"] = { ...(merged["web"] as object), ...(incoming["web"] as object) };
  }

  // Google
  if (incoming["google"] && typeof incoming["google"] === "object") {
    const existGoogle = (merged["google"] ?? {}) as Record<string, unknown>;
    const incomingGoogle = incoming["google"] as Record<string, unknown>;
    for (const [k, v] of Object.entries(incomingGoogle)) {
      if ((k === "clientId" || k === "clientSecret") && (v === HIDDEN || v === "")) continue; // keep existing
      existGoogle[k] = v;
    }
    merged["google"] = existGoogle;
  }

  return merged as unknown as PepagiConfig;
}

/** GET /api/config — returns full config with secrets scrubbed. */
export async function handleGetConfig(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const config = await loadConfig();
    // Decrypt for scrubbing check, then re-scrub
    const plain = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    // Decrypt encrypted values for display check (but we'll scrub them anyway)
    const agents = plain["agents"] as Record<string, Record<string, unknown>> | undefined;
    if (agents) {
      for (const agent of Object.values(agents)) {
        if (agent && typeof agent["apiKey"] === "string" && isEncrypted(agent["apiKey"])) {
          try { agent["apiKey"] = decrypt(agent["apiKey"]); } catch { /* keep encrypted */ }
        }
      }
    }
    json(res, 200, scrubSecrets(plain as unknown as PepagiConfig));
  } catch (err) {
    json(res, 500, { error: `Failed to load config: ${String(err)}` });
  }
}

/** PUT /api/config — validate, encrypt secrets, save, and hot-reload running services. */
export async function handlePutConfig(deps: RestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req);
    const incoming = JSON.parse(raw) as Record<string, unknown>;
    const existing = await loadConfig();
    const merged = mergeConfig(existing, incoming);
    await saveConfig(merged);

    // Hot-reload: reconfigure LLM provider with new manager settings
    if (deps.llm) {
      const provider = merged.managerProvider;
      const cc = merged.customProviders?.[provider];
      deps.llm.configure(provider, merged.managerModel, getCheapModel(provider, cc?.model, cc?.cheapModel));
      // Re-register custom providers on hot-reload
      if (merged.customProviders) {
        deps.llm.registerCustomProviders(merged.customProviders);
      }
    }

    // Hot-reload: update mediator's config reference (askMediator reads this.config)
    if (deps.mediator) {
      deps.mediator.updateConfig(merged);
    }

    // Hot-reload: invalidate cached config so next loadConfig() re-reads fresh settings
    invalidateConfigCache();

    json(res, 200, { success: true, message: "Config saved and applied to running daemon" });
  } catch (err) {
    json(res, 400, { error: `Failed to save config: ${String(err)}` });
  }
}

/** POST /api/config/test-agent — test agent connectivity. */
export async function handleTestAgent(_deps: RestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const provider = body["provider"] as string;
    const apiKey = body["apiKey"] as string | undefined;
    const model = body["model"] as string | undefined;

    const builtinProviders = ["claude", "gpt", "gemini", "ollama", "lmstudio"];
    const config = await loadConfig();
    const isCustomProvider = !builtinProviders.includes(provider) && config.customProviders?.[provider];

    if (!provider || (!builtinProviders.includes(provider) && !isCustomProvider)) {
      json(res, 400, { error: "Invalid provider" });
      return;
    }

    // Get existing key if not provided
    let key = apiKey;
    const baseUrl = body["baseUrl"] as string | undefined;
    if (!key || key === HIDDEN) {
      if (isCustomProvider) {
        const cpCfg = config.customProviders[provider];
        if (cpCfg?.apiKey) {
          key = isEncrypted(cpCfg.apiKey) ? decrypt(cpCfg.apiKey) : cpCfg.apiKey;
        }
      } else {
        const agents = config.agents as Record<string, { apiKey?: string }>;
        const agent = agents[provider];
        if (agent?.apiKey) {
          key = isEncrypted(agent.apiKey) ? decrypt(agent.apiKey) : agent.apiKey;
        }
      }
    }

    if (!key && provider !== "ollama" && provider !== "lmstudio" && !isCustomProvider) {
      json(res, 400, { error: "No API key available for this provider" });
      return;
    }

    // Dynamic import to avoid circular dependency
    const { LLMProvider } = await import("../agents/llm-provider.js");
    const llm = new LLMProvider();

    // Register custom provider on ephemeral LLMProvider for the test
    if (isCustomProvider) {
      const cpCfg = config.customProviders[provider];
      const effectiveBaseUrl = baseUrl || cpCfg.baseUrl;
      if (!effectiveBaseUrl) {
        json(res, 400, { error: "No base URL for custom provider" });
        return;
      }
      llm.registerCustomProviders({ [provider]: { baseUrl: effectiveBaseUrl, apiKey: key ?? "", displayName: cpCfg.displayName || provider, enabled: true } });
    }

    const start = performance.now();
    const response = await llm.call({
      provider,
      model: model || (isCustomProvider ? config.customProviders[provider].model : getDefaultModel(provider)),
      systemPrompt: "You are a test assistant.",
      messages: [{ role: "user", content: "Reply with just the word: OK" }],
      maxTokens: 10,
      temperature: 0,
      apiKey: key,
    });
    const latencyMs = Math.round(performance.now() - start);

    json(res, 200, {
      success: true,
      message: `${provider} responded successfully`,
      latencyMs,
      cost: response.cost,
      model: response.model,
    });
  } catch (err) {
    json(res, 200, {
      success: false,
      message: `Connection failed: ${String(err)}`,
      latencyMs: 0,
      cost: 0,
    });
  }
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "claude": return "claude-sonnet-4-6";
    case "gpt": return "gpt-4o";
    case "gemini": return "gemini-2.0-flash";
    case "ollama": return "ollama/llama3.2";
    case "lmstudio": return "lmstudio/default";
    default: return "unknown";
  }
}

// ── Data endpoints (for overlay views) ────────────────────────

import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PEPAGI_DATA_DIR } from "../config/loader.js";

/** Read a JSONL file and return parsed entries (last N). */
async function readJsonl(filePath: string, limit = 200): Promise<unknown[]> {
  if (!existsSync(filePath)) return [];
  try {
    const raw = await fsReadFile(filePath, "utf8");
    const lines = raw.split("\n").filter(l => l.trim());
    const entries = lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return entries;
  } catch { return []; }
}

/** GET /api/memory/:level — returns memory entries for a specific level. */
export async function handleGetMemory(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse, level: string): Promise<void> {
  const fileMap: Record<string, string> = {
    episodes: "episodes.jsonl",
    knowledge: "knowledge.jsonl",
    procedures: "procedures.jsonl",
    meta: "meta.jsonl",
    working: "working.jsonl",
    preferences: "preferences.jsonl",
    reflections: "reflections.jsonl",
    experiments: "experiments.jsonl",
    "agent-profiles": "agent-profiles.jsonl",
    "thought-stream": "thought-stream.jsonl",
  };
  const file = fileMap[level];
  if (!file) { json(res, 400, { error: `Unknown memory level: ${level}` }); return; }
  const entries = await readJsonl(join(PEPAGI_DATA_DIR, "memory", file), 500);
  json(res, 200, { level, count: entries.length, entries });
}

/** GET /api/audit — returns recent audit log entries. */
export async function handleGetAudit(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const entries = await readJsonl(join(PEPAGI_DATA_DIR, "audit.jsonl"), 200);
  json(res, 200, { count: entries.length, entries });
}

/** GET /api/causal — returns list of causal chain task files. */
export async function handleGetCausal(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dir = join(PEPAGI_DATA_DIR, "causal");
  if (!existsSync(dir)) { json(res, 200, { tasks: [] }); return; }
  try {
    const files = await readdir(dir);
    const tasks = [];
    for (const f of files.filter(f => f.endsWith(".json")).slice(-50)) {
      try {
        const raw = await fsReadFile(join(dir, f), "utf8");
        const data = JSON.parse(raw) as { taskId?: string; nodes?: unknown[] };
        tasks.push({ file: f, taskId: data.taskId ?? f.replace(".json", ""), nodeCount: data.nodes?.length ?? 0, data });
      } catch { /* skip corrupt */ }
    }
    json(res, 200, { count: tasks.length, tasks });
  } catch { json(res, 200, { tasks: [] }); }
}

/** GET /api/skills — returns skill files. */
export async function handleGetSkills(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dir = join(PEPAGI_DATA_DIR, "skills");
  if (!existsSync(dir)) { json(res, 200, { skills: [] }); return; }
  try {
    const files = await readdir(dir);
    const skills = [];
    for (const f of files.filter(f => f.endsWith(".json") && f !== "_checksums.json")) {
      try {
        const raw = await fsReadFile(join(dir, f), "utf8");
        skills.push(JSON.parse(raw));
      } catch { /* skip */ }
    }
    json(res, 200, { count: skills.length, skills });
  } catch { json(res, 200, { skills: [] }); }
}

/** POST /api/agent/kill — kill a running agent execution. */
export async function handleKillAgent(deps: RestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { provider?: string };
    const provider = body.provider as AgentProvider | undefined;
    if (!provider) { json(res, 400, { error: "Missing provider field" }); return; }
    const killed = deps.mediator.killAgent(provider);
    if (!killed) {
      json(res, 404, { error: `No running execution found for ${provider}` });
      return;
    }
    // Also disable the agent in the pool so no new tasks are assigned
    if (deps.pool) {
      deps.pool.disableAgent(provider);
      deps.bridge.setAgentAvailable(provider, false);
    }
    json(res, 200, { provider, killed: true, message: `Agent ${provider} killed and disabled` });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
}

/** POST /api/agent/toggle — enable/disable an agent at runtime. */
export async function handleToggleAgent(deps: RestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.pool) { json(res, 500, { error: "AgentPool not available" }); return; }
  try {
    const body = JSON.parse(await readBody(req)) as { provider?: string };
    const provider = body.provider as AgentProvider | undefined;
    if (!provider) { json(res, 400, { error: "Missing provider field" }); return; }
    const result = deps.pool.toggleAgent(provider);
    if (!result.toggled) { json(res, 404, { error: `Unknown agent: ${provider}` }); return; }
    // Sync state-bridge so web UI reflects the change immediately
    deps.bridge.setAgentAvailable(provider, result.available);
    json(res, 200, { provider, available: result.available });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
}

/** POST /api/google/auth — Start Google OAuth2 flow, return auth URL. */
export async function handleGoogleAuthStart(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { startGoogleAuth } = await import("../integrations/google-auth.js");
    const { authUrl, waitForCallback } = await startGoogleAuth();
    // Don't await the callback — it waits for browser redirect
    void waitForCallback();
    json(res, 200, { authUrl });
  } catch (err) {
    json(res, 500, { error: `Failed to start Google auth: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** GET /api/google/auth/status — Check if Google OAuth is authenticated. */
export async function handleGoogleAuthStatus(_deps: RestDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { isGoogleAuthenticated } = await import("../integrations/google-auth.js");
    const authenticated = await isGoogleAuthenticated();
    json(res, 200, { authenticated });
  } catch {
    json(res, 200, { authenticated: false });
  }
}
