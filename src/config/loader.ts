// ═══════════════════════════════════════════════════════════════
// PEPAGI — Configuration Loader
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, rename, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ConsciousnessProfileName } from "./consciousness-profiles.js";
// NOTE: Cannot use Logger here — circular dependency (logger.ts imports PEPAGI_DATA_DIR from this file).
// Using prefixed console output is acceptable for this bootstrap module.
const log = (msg: string) => console.log(`[Config] ${msg}`);
const warn = (msg: string, detail?: string) => console.warn(`[Config] ${msg}${detail ? `: ${detail}` : ""}`);

export const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");

/** Migrate data from ~/.nexus to ~/.pepagi on first run after rename */
async function migrateDataDir(): Promise<void> {
  const oldDir = join(homedir(), ".nexus");
  const newDir = PEPAGI_DATA_DIR;
  if (existsSync(oldDir) && !existsSync(newDir)) {
    log("Migrating data directory from ~/.nexus to ~/.pepagi");
    try {
      await cp(oldDir, newDir, { recursive: true });
      log("Migration complete — ~/.nexus preserved as backup");
    } catch (e) {
      warn("Migration failed, starting fresh", String(e));
      await mkdir(newDir, { recursive: true });
    }
  }
  // If both exist, silently use ~/.pepagi (migration already done)
}

// Run migration once at module load time (non-blocking)
void migrateDataDir();

const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().default(""),
  model: z.string(),
  maxOutputTokens: z.number().default(4096),
  temperature: z.number().min(0).max(2).default(0.3),
  /** Max agentic turns for this agent (0 = auto-detect based on task complexity) */
  maxAgenticTurns: z.number().min(0).default(0),
});

const SecurityConfigSchema = z.object({
  maxCostPerTask: z.number().default(1.0),
  maxCostPerSession: z.number().default(10.0),
  blockedCommands: z.array(z.string()).default([
    "rm -rf /", "mkfs", "dd if=/dev/zero", "shutdown", "reboot",
    ":(){ :|:& };:", "sudo rm -rf", "chmod 777 /",
  ]),
  requireApproval: z.array(z.string()).default([
    "file_delete", "file_write_system", "network_external",
    "shell_destructive", "git_push", "docker_manage",
  ]),
});

const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  allowedUserIds: z.array(z.number()).default([]),
  welcomeMessage: z.string().default("Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat."),
});

const WhatsAppConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedNumbers: z.array(z.string()).default([]),
  sessionPath: z.string().default(""),
  welcomeMessage: z.string().default("Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat."),
});

const DiscordConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  allowedUserIds: z.array(z.string()).default([]),
  allowedChannelIds: z.array(z.string()).default([]),
  commandPrefix: z.string().default("!"),
  welcomeMessage: z.string().default("Hello! I'm PEPAGI. What can I help you with?"),
});

const iMessageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedNumbers: z.array(z.string()).default([]),
});

const ProfileSchema = z.object({
  userName: z.string().default(""),
  assistantName: z.string().default("PEPAGI"),
  communicationStyle: z.enum(["human", "direct"]).default("human"),
  language: z.string().default("cs"),
  subscriptionMode: z.boolean().default(false),
  gptSubscriptionMode: z.boolean().default(false),
});

const ConsciousnessConfigSchema = z.object({
  profile: z.enum(["MINIMAL", "STANDARD", "RICH", "RESEARCHER", "SAFE-MODE"]).default("STANDARD"),
  enabled: z.boolean().default(true),
});

const WebDashboardConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(3100),
  /** Bind address — "127.0.0.1" (default, safe) or "0.0.0.0" (Docker/remote). Override via PEPAGI_HOST env var. */
  host: z.string().default("127.0.0.1"),
  /** Optional Bearer token for REST API + WebSocket auth. Empty = no auth (backward compatible). */
  authToken: z.string().default(""),
});

const SelfHealingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxAttemptsPerHour: z.number().default(3),
  cooldownMs: z.number().default(300_000), // 5 min between attempts
  costCapPerAttempt: z.number().default(0.50),
  allowCodeFixes: z.boolean().default(false), // Tier 2 is opt-in
});

const N8nConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Base URL of n8n instance, e.g. "https://my-n8n.example.com" */
  baseUrl: z.string().default(""),
  /** Webhook paths whitelisted for DLP (n8n workflow webhook suffixes) */
  webhookPaths: z.array(z.string()).default([]),
  /** API key for n8n (optional — only if n8n requires auth) */
  apiKey: z.string().default(""),
});

const GoogleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
});

export const CustomProviderConfigSchema = z.object({
  displayName: z.string().default(""),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
  /** Cheap model for auxiliary calls (memory, classification, simulation). Falls back to main model if empty. */
  cheapModel: z.string().default(""),
  enabled: z.boolean().default(true),
  maxOutputTokens: z.number().default(4096),
  temperature: z.number().min(0).max(2).default(0.3),
  inputCostPer1M: z.number().default(0),
  outputCostPer1M: z.number().default(0),
  contextWindow: z.number().default(128_000),
  supportsTools: z.boolean().default(true),
});

export type CustomProviderConfig = z.infer<typeof CustomProviderConfigSchema>;

const PepagiConfigSchema = z.object({
  managerProvider: z.string().default("claude"),
  managerModel: z.string().default("claude-sonnet-4-6"),
  profile: ProfileSchema.default(() => ({
    userName: "",
    assistantName: "PEPAGI",
    communicationStyle: "human" as const,
    language: "cs",
    subscriptionMode: false,
    gptSubscriptionMode: false,
  })),
  agents: z.object({
    claude: AgentConfigSchema.extend({ model: z.string().default("claude-sonnet-4-6") }),
    gpt: AgentConfigSchema.extend({ model: z.string().default("gpt-4o") }),
    gemini: AgentConfigSchema.extend({ model: z.string().default("gemini-2.0-flash") }),
    ollama: AgentConfigSchema.extend({ model: z.string().default("ollama/llama3.2") }).optional(),
  }).default({
    claude: { enabled: true, apiKey: "", model: "claude-sonnet-4-6", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    gpt: { enabled: false, apiKey: "", model: "gpt-4o", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    gemini: { enabled: false, apiKey: "", model: "gemini-2.0-flash", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
  }),
  platforms: z.object({
    telegram: TelegramConfigSchema.default(() => ({ enabled: false, botToken: "", allowedUserIds: [], welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." })),
    whatsapp: WhatsAppConfigSchema.default(() => ({ enabled: false, allowedNumbers: [], sessionPath: "", welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." })),
    discord: DiscordConfigSchema.default(() => ({
      enabled: false, botToken: "", allowedUserIds: [], allowedChannelIds: [],
      commandPrefix: "!", welcomeMessage: "Hello! I'm PEPAGI. What can I help you with?",
    })),
    imessage: iMessageConfigSchema.default(() => ({ enabled: false, allowedNumbers: [] })),
  }).default(() => ({
    telegram: { enabled: false, botToken: "", allowedUserIds: [], welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." },
    whatsapp: { enabled: false, allowedNumbers: [], sessionPath: "", welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." },
    discord: { enabled: false, botToken: "", allowedUserIds: [], allowedChannelIds: [], commandPrefix: "!", welcomeMessage: "Hello! I'm PEPAGI. What can I help you with?" },
    imessage: { enabled: false, allowedNumbers: [] },
  })),
  security: SecurityConfigSchema.default({
    maxCostPerTask: 1.0,
    maxCostPerSession: 10.0,
    blockedCommands: ["rm -rf /", "mkfs", "dd if=/dev/zero", "shutdown", "reboot", ":(){ :|:& };:", "sudo rm -rf", "chmod 777 /"],
    requireApproval: ["file_delete", "file_write_system", "network_external", "shell_destructive", "git_push", "docker_manage"],
  }),
  queue: z.object({
    maxConcurrentTasks: z.number().default(4),
    taskTimeoutMs: z.number().default(120_000),
  }).default({ maxConcurrentTasks: 4, taskTimeoutMs: 120_000 }),
  customProviders: z.record(z.string(), CustomProviderConfigSchema).default({}),
  consciousness: ConsciousnessConfigSchema.default({ profile: "MINIMAL", enabled: true }),
  web: WebDashboardConfigSchema.default({ enabled: true, port: 3100, host: "127.0.0.1", authToken: "" }),
  n8n: N8nConfigSchema.default({ enabled: false, baseUrl: "", webhookPaths: [], apiKey: "" }),
  selfHealing: SelfHealingConfigSchema.default({ enabled: true, maxAttemptsPerHour: 3, cooldownMs: 300_000, costCapPerAttempt: 0.50, allowCodeFixes: false }),
  google: GoogleConfigSchema.default({ enabled: false, clientId: "", clientSecret: "" }),
});

export type PepagiConfig = z.infer<typeof PepagiConfigSchema>;

let cachedConfig: PepagiConfig | null = null;

/** Load .env file into process.env (no dependency needed). */
async function loadDotEnv(): Promise<void> {
  // Look for .env in cwd first, then project root
  for (const dir of [process.cwd(), join(PEPAGI_DATA_DIR)]) {
    const envPath = join(dir, ".env");
    if (!existsSync(envPath)) continue;
    try {
      const content = await readFile(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Don't override if already set in environment
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      return; // loaded from first found .env
    } catch { /* ignore */ }
  }
}

/** Load configuration from ~/.pepagi/config.json + env vars */
export async function loadConfig(): Promise<PepagiConfig> {
  if (cachedConfig) return cachedConfig;

  // Load .env file before reading env vars
  await loadDotEnv();

  // Create parent first, then children in parallel
  await mkdir(PEPAGI_DATA_DIR, { recursive: true });
  await Promise.all([
    mkdir(join(PEPAGI_DATA_DIR, "memory"), { recursive: true }),
    mkdir(join(PEPAGI_DATA_DIR, "logs"), { recursive: true }),
    mkdir(join(PEPAGI_DATA_DIR, "causal"), { recursive: true }),
    mkdir(join(PEPAGI_DATA_DIR, "skills"), { recursive: true }),
    mkdir(join(PEPAGI_DATA_DIR, "identity"), { recursive: true }),
  ]);

  const configPath = join(PEPAGI_DATA_DIR, "config.json");
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    const content = await readFile(configPath, "utf8");
    raw = JSON.parse(content);
  }

  // Pre-populate agent defaults so Zod v4 nested .default() works correctly
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
  raw.agents = agents;

  if (!agents.claude) agents.claude = { enabled: true, apiKey: "", model: "claude-sonnet-4-6", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 };
  if (!agents.gpt) agents.gpt = { enabled: false, apiKey: "", model: "gpt-4o", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 };
  if (!agents.gemini) agents.gemini = { enabled: false, apiKey: "", model: "gemini-2.0-flash", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 };
  if (!agents.ollama) agents.ollama = { enabled: false, apiKey: "", model: "ollama/llama3.2", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 };

  // Overlay platform env vars
  const platforms = (raw.platforms ?? {}) as Record<string, Record<string, unknown>>;
  raw.platforms = platforms;
  if (!platforms.telegram) platforms.telegram = {};
  if (!platforms.whatsapp) platforms.whatsapp = {};
  if (!platforms.discord) platforms.discord = {};
  if (!platforms.imessage) platforms.imessage = {};

  if (process.env.TELEGRAM_BOT_TOKEN) {
    platforms.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    platforms.telegram.enabled = true;
  }
  if (process.env.TELEGRAM_ALLOWED_USERS) {
    platforms.telegram.allowedUserIds = process.env.TELEGRAM_ALLOWED_USERS.split(",").map(Number).filter(Boolean);
  }

  if (process.env.DISCORD_BOT_TOKEN) {
    platforms.discord = { ...platforms.discord, botToken: process.env.DISCORD_BOT_TOKEN, enabled: true };
  }

  // Overlay env vars (log each override so it's not silent)
  if (process.env.ANTHROPIC_API_KEY) {
    agents.claude.apiKey = process.env.ANTHROPIC_API_KEY;
    log("ANTHROPIC_API_KEY detected — Claude agent enabled");
  }
  if (process.env.OPENAI_API_KEY) {
    agents.gpt.apiKey = process.env.OPENAI_API_KEY;
    agents.gpt.enabled = true;
    log("OPENAI_API_KEY detected — GPT agent enabled");
  }
  if (process.env.GOOGLE_API_KEY) {
    agents.gemini.apiKey = process.env.GOOGLE_API_KEY;
    agents.gemini.enabled = true;
    log("GOOGLE_API_KEY detected — Gemini agent enabled");
  }

  // Overlay Google OAuth2 env vars
  const google = (raw.google ?? {}) as Record<string, unknown>;
  raw.google = google;
  if (process.env.GOOGLE_CLIENT_ID) google.clientId = process.env.GOOGLE_CLIENT_ID;
  if (process.env.GOOGLE_CLIENT_SECRET) google.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (google.clientId && google.clientSecret) google.enabled = true;

  const config = PepagiConfigSchema.parse(raw);

  // Auto-correct managerProvider if the configured provider is disabled or has no API key.
  // This ensures that if the user disabled Claude and only has GPT, the system actually uses GPT.
  const mgrProvider = config.managerProvider;
  const builtinProviders: Array<"claude" | "gpt" | "gemini"> = ["claude", "gpt", "gemini"];

  // Check if manager provider is a custom provider
  const customCfg = config.customProviders?.[mgrProvider];
  let mgrIsUsable: boolean;
  if (customCfg) {
    // Custom provider: usable if enabled and has baseUrl
    mgrIsUsable = customCfg.enabled && !!customCfg.baseUrl;
  } else if (builtinProviders.includes(mgrProvider as "claude" | "gpt" | "gemini")) {
    const mgrAgent = config.agents[mgrProvider as "claude" | "gpt" | "gemini"];
    const mgrHasKey = !!(mgrAgent.apiKey || (mgrProvider === "claude" ? true : mgrProvider === "gpt" ? process.env.OPENAI_API_KEY : process.env.GOOGLE_API_KEY));
    mgrIsUsable = mgrProvider === "claude" ? mgrAgent.enabled : mgrAgent.enabled && mgrHasKey;
  } else {
    mgrIsUsable = false;
  }

  if (!mgrIsUsable) {
    let found = false;
    // Try custom providers first (user explicitly configured these)
    for (const [name, cp] of Object.entries(config.customProviders ?? {})) {
      if (cp.enabled && cp.baseUrl) {
        log(`managerProvider was "${mgrProvider}" (disabled/no key) — auto-switching to custom provider "${name}"`);
        config.managerProvider = name;
        config.managerModel = cp.model;
        found = true;
        break;
      }
    }
    // Then try built-in providers
    if (!found) {
      for (const candidate of builtinProviders) {
        const agentCfg = config.agents[candidate];
        const hasKey = !!(agentCfg.apiKey || (candidate === "claude" ? true : candidate === "gpt" ? process.env.OPENAI_API_KEY : process.env.GOOGLE_API_KEY));
        const usable = candidate === "claude" ? agentCfg.enabled : agentCfg.enabled && hasKey;
        if (usable) {
          log(`managerProvider was "${mgrProvider}" (disabled/no key) — auto-switching to "${candidate}"`);
          config.managerProvider = candidate;
          config.managerModel = agentCfg.model;
          break;
        }
      }
    }
  }

  cachedConfig = config;
  return cachedConfig;
}

/** Invalidate the cached config — forces next loadConfig() to re-read from disk. */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/** Save configuration to disk */
export async function saveConfig(config: PepagiConfig): Promise<void> {
  const configPath = join(PEPAGI_DATA_DIR, "config.json");
  // BUG-01: atomic write — crash during plain writeFile() would corrupt config.json
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2), "utf8");
  await rename(tmpPath, configPath);
  // BUG-03: cachedConfig was not updated after save; subsequent loadConfig() calls returned stale data
  cachedConfig = config;
}
