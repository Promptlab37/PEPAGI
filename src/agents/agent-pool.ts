// ═══════════════════════════════════════════════════════════════
// PEPAGI — Agent Pool Manager
// ═══════════════════════════════════════════════════════════════

import { networkInterfaces } from "node:os";
import type { AgentProfile, AgentProvider } from "../core/types.js";
import type { PepagiConfig } from "../config/loader.js";
import { PRICING, registerCustomPricing } from "./pricing.js";
import { checkOllamaHealth, checkLMStudioHealth, checkKiroHealth, listOllamaModels, listLMStudioModels } from "./llm-provider.js";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("AgentPool");

export class AgentPool {
  private agents: Map<AgentProvider, AgentProfile> = new Map();
  private load: Map<AgentProvider, number> = new Map();
  /** Timestamp (ms) until which this provider is rate-limited */
  private rateLimitedUntil: Map<AgentProvider, number> = new Map();

  constructor(private config: PepagiConfig) {
    this.initAgents();
  }

  private initAgents(): void {
    const agentDefs: Array<{ provider: AgentProvider; displayName: string; defaultModel: string }> = [
      { provider: "claude",    displayName: "Claude (Anthropic)",    defaultModel: "claude-opus-4-6" },
      { provider: "gpt",       displayName: "GPT (OpenAI)",          defaultModel: "gpt-4o" },
      { provider: "gemini",    displayName: "Gemini (Google)",       defaultModel: "gemini-2.0-flash" },
      { provider: "ollama",    displayName: "Ollama (Local)",        defaultModel: "ollama/gemma3:12b" },
      { provider: "lmstudio",  displayName: "LM Studio (Local)",     defaultModel: "lmstudio/local-model" },
      { provider: "kiro",      displayName: "Kiro CLI (ACP)",        defaultModel: "auto" },
    ];

    const localProviders = new Set<string>(["ollama", "lmstudio", "kiro"]);

    for (const def of agentDefs) {
      // TS-01: unsafe cast bypassed type checking; use a typed helper to access
      // local-provider config entries (ollama/lmstudio) that are not in the
      // discriminated union for cloud providers.
      const localAgentConfig: { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number } | undefined =
        localProviders.has(def.provider)
          ? (Object.entries(this.config.agents) as Array<[string, { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number } | undefined]>)
              .find(([key]) => key === def.provider)?.[1]
          : undefined;
      const agentConfig = localProviders.has(def.provider)
        ? localAgentConfig ?? { enabled: false, apiKey: "", model: def.defaultModel, maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 }
        : this.config.agents[def.provider as "claude" | "gpt" | "gemini"];

      const model = agentConfig.model || def.defaultModel;
      const pricing = PRICING.find(p => p.model === model);

      // Claude: always available via CLI OAuth (no API key needed)
      // GPT/Gemini: available ONLY if has actual API key (env var or config)
      //   gptSubscriptionMode removed from availability check — Codex OAuth is unreliable
      // Ollama / LM Studio: available if enabled (health check done async via probeLocalModels)
      const hasApiKey = !!(agentConfig.apiKey || (def.provider === "gpt" ? process.env.OPENAI_API_KEY : def.provider === "gemini" ? process.env.GOOGLE_API_KEY : null));
      const isAvailable = def.provider === "claude"
        ? agentConfig.enabled
        : localProviders.has(def.provider)
          ? agentConfig.enabled
          : agentConfig.enabled && hasApiKey;

      const profile: AgentProfile = {
        provider: def.provider,
        model,
        displayName: def.displayName,
        costPerMInputTokens: pricing?.inputCostPer1M ?? 0,
        costPerMOutputTokens: pricing?.outputCostPer1M ?? 0,
        maxContextTokens: pricing?.contextWindow ?? 128_000,
        supportsTools: pricing?.supportsTools ?? true,
        available: isAvailable,
        maxAgenticTurns: (agentConfig as Record<string, unknown>).maxAgenticTurns as number | undefined,
        maxOutputTokens: agentConfig.maxOutputTokens,
      };

      this.agents.set(def.provider, profile);
      this.load.set(def.provider, 0);
    }

    // Load custom OpenAI-compatible providers from config
    const customProviders = this.config.customProviders ?? {};
    for (const [name, cpCfg] of Object.entries(customProviders)) {
      if (!cpCfg.enabled || !cpCfg.baseUrl) continue;

      // Register pricing for custom model
      registerCustomPricing([{
        model: cpCfg.model,
        provider: name,
        inputCostPer1M: cpCfg.inputCostPer1M ?? 0,
        outputCostPer1M: cpCfg.outputCostPer1M ?? 0,
        contextWindow: cpCfg.contextWindow ?? 128_000,
        supportsTools: cpCfg.supportsTools ?? true,
      }]);

      const customProfile: AgentProfile = {
        provider: name,
        model: cpCfg.model,
        displayName: cpCfg.displayName || name,
        costPerMInputTokens: cpCfg.inputCostPer1M ?? 0,
        costPerMOutputTokens: cpCfg.outputCostPer1M ?? 0,
        maxContextTokens: cpCfg.contextWindow ?? 128_000,
        supportsTools: cpCfg.supportsTools ?? true,
        available: true,
        apiKey: cpCfg.apiKey,
        maxOutputTokens: cpCfg.maxOutputTokens ?? 4096,
        baseUrl: cpCfg.baseUrl,
      };

      this.agents.set(name, customProfile);
      this.load.set(name, 0);
    }
  }

  /**
   * Mark a provider as rate-limited for a given duration.
   * @param provider - Which provider hit the limit
   * @param durationMs - How long to mark it unavailable (default 60s)
   */
  markRateLimited(provider: AgentProvider, durationMs = 60_000): void {
    this.rateLimitedUntil.set(provider, Date.now() + durationMs);
  }

  /** Check whether a provider is currently rate-limited */
  isRateLimited(provider: AgentProvider): boolean {
    const until = this.rateLimitedUntil.get(provider) ?? 0;
    if (until > Date.now()) return true;
    // Expired — clean up
    this.rateLimitedUntil.delete(provider);
    return false;
  }

  /**
   * Get all available agents (excludes rate-limited providers).
   */
  getAvailableAgents(): AgentProfile[] {
    return [...this.agents.values()].filter(a => a.available && !this.isRateLimited(a.provider));
  }

  /**
   * Get the optimal agent for a task — cheapest available that can handle it.
   * @param taskType - Hint about task type (e.g., "coding", "writing", "analysis")
   * @param budget - Maximum cost budget in USD
   */
  getOptimalAgent(taskType: string, budget: number): AgentProfile | null {
    const available = this.getAvailableAgents();
    if (available.length === 0) return null;

    // Sort by cost (input + output combined per 1M tokens)
    const sorted = available.sort((a, b) =>
      (a.costPerMInputTokens + a.costPerMOutputTokens) - (b.costPerMInputTokens + b.costPerMOutputTokens)
    );

    // Pick cheapest within budget (rough estimate: 4K tokens ≈ $0.02 for cheapest)
    for (const agent of sorted) {
      const estimatedCost = (agent.costPerMInputTokens * 2000 + agent.costPerMOutputTokens * 2000) / 1_000_000;
      if (estimatedCost <= budget) return agent;
    }

    return sorted[0] ?? null; // fallback to cheapest regardless of budget
  }

  /** Get profile for a specific provider */
  getAgent(provider: AgentProvider): AgentProfile | undefined {
    return this.agents.get(provider);
  }

  /** Mark agent as busy (+1 to load) */
  incrementLoad(provider: AgentProvider): void {
    this.load.set(provider, (this.load.get(provider) ?? 0) + 1);
  }

  /** Mark agent as free (-1 from load) */
  decrementLoad(provider: AgentProvider): void {
    const current = this.load.get(provider) ?? 0;
    this.load.set(provider, Math.max(0, current - 1));
  }

  /** Get current load for a provider */
  getLoad(provider: AgentProvider): number {
    return this.load.get(provider) ?? 0;
  }

  /**
   * Build a fallback chain starting from the preferred provider.
   * Returns providers in order: [preferred, ...others that are available]
   */
  /**
   * Probe local model servers (Ollama, LM Studio) and update their availability.
   * Call once at daemon startup; respects enabled flags from config.
   */
  /**
   * SECURITY: SEC-29 — Check if a local service (Ollama/LM Studio) is exposed
   * beyond localhost by trying to reach it on non-loopback interfaces.
   */
  private async checkLocalServiceExposure(port: number, serviceName: string): Promise<void> {
    const interfaces = networkInterfaces();
    const nonLoopbackIPs: string[] = [];

    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (!info.internal && info.family === "IPv4") {
          nonLoopbackIPs.push(info.address);
        }
      }
    }

    for (const ip of nonLoopbackIPs) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch(`http://${ip}:${port}/`, { signal: controller.signal }).catch(() => null);
        clearTimeout(timeout);
        if (resp && resp.ok) {
          logger.error(`SEC-29: ${serviceName} is exposed on non-loopback interface ${ip}:${port}!`);
          eventBus.emit({
            type: "system:alert",
            message: `🔴 SEC-29: ${serviceName} je přístupný na ${ip}:${port} — je vystaven síti! Omezte na localhost (127.0.0.1).`,
            level: "critical",
          });
          return; // One warning is enough
        }
      } catch {
        // Expected: connection refused on non-loopback = good
      }
    }
  }

  async probeLocalModels(): Promise<void> {
    const ollamaProfile = this.agents.get("ollama");
    if (ollamaProfile?.available) {
      const healthy = await checkOllamaHealth();
      if (!healthy) {
        ollamaProfile.available = false;
        ollamaProfile.displayName = "Ollama (Local — offline)";
      } else {
        const models = await listOllamaModels();
        if (models.length > 0) {
          ollamaProfile.displayName = `Ollama (${models.length} models)`;
        }
        // SECURITY: SEC-29 — Check if Ollama is exposed beyond localhost
        await this.checkLocalServiceExposure(11434, "Ollama").catch(() => {});
      }
    }

    const lmProfile = this.agents.get("lmstudio");
    if (lmProfile?.available) {
      const healthy = await checkLMStudioHealth();
      if (!healthy) {
        lmProfile.available = false;
        lmProfile.displayName = "LM Studio (Local — offline)";
      } else {
        const models = await listLMStudioModels();
        if (models.length > 0) {
          lmProfile.model = `lmstudio/${models[0] ?? "local-model"}`;
          lmProfile.displayName = `LM Studio (${models.length} models)`;
        }
        // SECURITY: SEC-29 — Check if LM Studio is exposed beyond localhost
        await this.checkLocalServiceExposure(1234, "LM Studio").catch(() => {});
      }
    }

    const kiroProfile = this.agents.get("kiro");
    if (kiroProfile?.available) {
      const healthy = await checkKiroHealth();
      if (!healthy) {
        kiroProfile.available = false;
        kiroProfile.displayName = "Kiro CLI (ACP — offline)";
      }
    }
  }

  getFallbackChain(preferred: AgentProvider): AgentProvider[] {
    // Priority: preferred → custom providers → built-in providers.
    // Custom providers are explicitly configured by the user and should
    // ALWAYS come before built-in providers in the fallback chain.
    // This prevents slow fallback loops (e.g., trying Claude first when
    // the user has a custom provider configured as their primary worker).
    const builtIn = new Set<AgentProvider>(["claude", "gpt", "gemini", "ollama", "lmstudio", "kiro"]);
    const customNames: AgentProvider[] = [];
    for (const [name] of this.agents) {
      if (!builtIn.has(name)) customNames.push(name);
    }

    // Build order: preferred first, then all custom, then built-in
    const order: AgentProvider[] = [preferred, ...customNames, ...builtIn];
    const seen = new Set<AgentProvider>();
    const chain: AgentProvider[] = [];
    for (const p of order) {
      if (seen.has(p)) continue;
      seen.add(p);
      const profile = this.agents.get(p);
      if (profile?.available) chain.push(p);
    }
    return chain;
  }

  /** Check if a provider is custom (not built-in) */
  isCustomProvider(provider: AgentProvider): boolean {
    const builtIn = new Set(["claude", "gpt", "gemini", "ollama", "lmstudio"]);
    return !builtIn.has(provider);
  }

  /** Get the first available custom provider, if any */
  getPreferredCustomProvider(): AgentProfile | null {
    for (const [name, profile] of this.agents) {
      if (this.isCustomProvider(name) && profile.available && !this.isRateLimited(name)) {
        return profile;
      }
    }
    return null;
  }

  /** Disable an agent at runtime (removes from available pool). */
  disableAgent(provider: AgentProvider): boolean {
    const profile = this.agents.get(provider);
    if (!profile || !profile.available) return false;
    profile.available = false;
    logger.info("Agent disabled", { provider });
    eventBus.emit({ type: "system:alert", message: `Agent ${provider} vypnut`, level: "warn" });
    return true;
  }

  /** Re-enable a previously disabled agent. */
  enableAgent(provider: AgentProvider): boolean {
    const profile = this.agents.get(provider);
    if (!profile || profile.available) return false;
    profile.available = true;
    logger.info("Agent enabled", { provider });
    eventBus.emit({ type: "system:alert", message: `Agent ${provider} zapnut`, level: "warn" });
    return true;
  }

  /** Toggle agent availability. Returns new state. */
  toggleAgent(provider: AgentProvider): { toggled: boolean; available: boolean } {
    const profile = this.agents.get(provider);
    if (!profile) return { toggled: false, available: false };
    if (profile.available) {
      this.disableAgent(provider);
    } else {
      this.enableAgent(provider);
    }
    return { toggled: true, available: profile.available };
  }

  /** Summary for display */
  getSummary(): string {
    const lines = [];
    for (const [p, profile] of this.agents) {
      const load = this.load.get(p) ?? 0;
      const rl = this.isRateLimited(p);
      const status = !profile.available ? "✗ unavailable"
        : rl ? `⏳ rate-limited`
        : `✓ load=${load}`;
      lines.push(`  ${profile.displayName} (${profile.model}): ${status}`);
    }
    return lines.join("\n");
  }
}
