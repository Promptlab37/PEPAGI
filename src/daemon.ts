#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// PEPAGI — Daemon Mode
// Runs all platforms (Telegram, WhatsApp, Discord) + MCP server
// ═══════════════════════════════════════════════════════════════

// Unset CLAUDECODE early — prevents nested-session error when daemon spawns `claude --print`
// (happens when daemon is started from within a Claude Code terminal)
delete process.env.CLAUDECODE;

import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

import { loadConfig, PEPAGI_DATA_DIR, saveConfig } from "./config/loader.js";
import { LLMProvider } from "./agents/llm-provider.js";
import { getCheapModel } from "./agents/pricing.js";
import { AgentPool } from "./agents/agent-pool.js";
import { SecurityGuard } from "./security/security-guard.js";
import { TaskStore } from "./core/task-store.js";
import { Mediator } from "./core/mediator.js";
import { MemorySystem } from "./memory/memory-system.js";
import { Watchdog } from "./meta/watchdog.js";
import { GoalManager } from "./core/goal-manager.js";
import { skillRegistry } from "./skills/skill-registry.js";
import { ReflectionBank } from "./meta/reflection-bank.js";
import { SkillDistiller } from "./meta/skill-distiller.js";
import { ABTester } from "./meta/ab-tester.js";
import { UncertaintyEngine } from "./meta/uncertainty-engine.js";
import { CausalChain } from "./meta/causal-chain.js";
import { DifficultyRouter } from "./core/difficulty-router.js";
import { WorldModel } from "./meta/world-model.js";
import { HierarchicalPlanner } from "./core/planner.js";
import { initTripwires } from "./security/tripwire.js";
import { PlatformManager } from "./platforms/platform-manager.js";
import { Logger } from "./core/logger.js";
import { eventBus } from "./core/event-bus.js";
import type { PepagiEvent } from "./core/types.js";
import { ConsciousnessManager } from "./consciousness/consciousness-manager.js";
import type { ConsciousnessProfileName } from "./config/consciousness-profiles.js";
import { MCPServer } from "./mcp/index.js";
import { AdversarialTester } from "./meta/adversarial-tester.js";
import { SkillSynthesizer } from "./meta/skill-synthesizer.js";
import { PredictiveContextLoader } from "./meta/predictive-context.js";
import { ArchitectureProposer } from "./meta/architecture-proposer.js";
// Web Dashboard
import { WebDashboardServer } from "./web/server.js";
// SECURITY: SEC-13 — Cost tracking persistence
import { costTracker } from "./security/cost-tracker.js";
// SECURITY: SEC-25 — Credential lifecycle cleanup
import { credentialLifecycle } from "./security/credential-lifecycle.js";
// SECURITY: SEC-26 — Supply chain audit on startup
import { verifyLockfile } from "./security/supply-chain.js";

const logger = new Logger("Daemon");
const PID_FILE = join(PEPAGI_DATA_DIR, "daemon.pid");

async function writePid(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid), "utf8");
}

async function removePid(): Promise<void> {
  if (existsSync(PID_FILE)) await unlink(PID_FILE);
}

async function main(): Promise<void> {
  console.log(chalk.cyan("\n🤖 PEPAGI Daemon — startuje...\n"));

  const config = await loadConfig();

  // Boot core services
  const llm = new LLMProvider();
  // Configure LLM with the user's chosen provider so quickCall() respects it
  const mgrProvider = config.managerProvider;
  const customCfg = config.customProviders?.[mgrProvider];
  llm.configure(mgrProvider, config.managerModel, getCheapModel(mgrProvider, customCfg?.model, customCfg?.cheapModel));
  // Register custom OpenAI-compatible providers (Deepinfra, Kie.ai, etc.)
  if (config.customProviders) {
    llm.registerCustomProviders(config.customProviders);
  }
  // Whitelist n8n domain for DLP if configured
  if (config.n8n?.enabled && config.n8n.baseUrl) {
    const { dlpEngine } = await import("./security/dlp-engine.js");
    dlpEngine.addWhitelistedDomain(config.n8n.baseUrl);
  }
  const pool = new AgentPool(config);
  const guard = new SecurityGuard(config);
  const taskStore = new TaskStore();
  await taskStore.load();
  const memory = new MemorySystem(llm);
  const reflectionBank = new ReflectionBank(llm);
  const skillDistiller = new SkillDistiller(llm, memory.procedural);
  const abTester = new ABTester();
  const uncertaintyEngine = new UncertaintyEngine(taskStore);
  const causalChain = new CausalChain();
  const difficultyRouter = new DifficultyRouter(llm, pool);
  const worldModel = new WorldModel(llm);
  const planner = new HierarchicalPlanner(llm);
  const mediator = new Mediator(llm, taskStore, guard, pool, config, memory, reflectionBank, skillDistiller, skillRegistry, uncertaintyEngine, causalChain, abTester, difficultyRouter, worldModel, planner);
  const watchdog = new Watchdog(taskStore);
  const goalManager = new GoalManager(taskStore, mediator);

  // Advanced meta services
  const skillSynthesizer = new SkillSynthesizer(llm, memory.procedural);
  const adversarialTester = new AdversarialTester(llm, guard);
  const mcpServer = new MCPServer(mediator, taskStore, memory, skillRegistry, { port: 3099, host: config.web?.host });
  const predictiveContext = new PredictiveContextLoader(llm, memory);

  // Wire predictive context into mediator
  mediator.setPredictiveContextLoader(predictiveContext);

  // Probe local model servers (Ollama / LM Studio) — async, non-blocking
  pool.probeLocalModels().catch(e => logger.debug("Local model probe failed", { error: String(e) }));

  await initTripwires();

  // SECURITY: SEC-13 — Load persisted cost data
  await costTracker.load();
  // SECURITY: SEC-26 — Verify lockfile on startup
  const lockCheck = await verifyLockfile(process.cwd()).catch(() => null);
  if (lockCheck && !lockCheck.valid) {
    logger.warn("SEC-26: Lockfile verification failed", { error: lockCheck.error });
  }

  // Write PID file IMMEDIATELY — before any async work, so daemonStart() can detect us
  // and LaunchAgent-restart won't spawn a duplicate instance
  await writePid();

  // Boot ConsciousnessManager in background — WakeRitual LLM call takes 2-5s,
  // platforms can start immediately (mediator handles missing consciousness gracefully)
  const consciousnessProfileName = (config.consciousness?.profile ?? "STANDARD") as ConsciousnessProfileName;
  const consciousness = new ConsciousnessManager(llm, consciousnessProfileName);
  if (config.consciousness?.enabled !== false) {
    consciousness.boot().then(() => {
      // Wire consciousness context into mediator after boot completes
      mediator.setConsciousnessProvider(() => consciousness.buildConsciousnessContext());
      // Wire phenomenal state into memory and reflection bank for learning multiplier support
      const phenomenalState = consciousness.getPhenomenalState();
      memory.setPhenomenalState(phenomenalState);
      reflectionBank.setPhenomenalState(phenomenalState);
      logger.info("Consciousness booted and wired into mediator");
    }).catch(err => {
      logger.warn("Consciousness boot failed — running without consciousness", { error: String(err) });
    });
  }

  // Architecture Proposer — analyzes system performance and suggests improvements
  const archProposer = new ArchitectureProposer(llm);

  // Trigger SkillDistiller + SkillSynthesizer every 10 completed tasks
  let completedTaskCount = 0;
  const DISTILL_EVERY = 10;

  // Idle guard: track last task activity so background LLM consumers can skip when idle.
  // Saves ~$3.60/day in unnecessary token usage when daemon sits idle.
  let lastTaskActivityTime = Date.now();

  // FIX: store named handler so it can be removed in shutdown (was anonymous → listener leak)
  const daemonEventHandler = (event: PepagiEvent) => {
    switch (event.type) {
      case "task:completed": {
        lastTaskActivityTime = Date.now();
        const resultPreview = typeof event.output.result === "string"
          ? event.output.result.slice(0, 300)
          : event.output.summary;
        logger.info("Task completed", {
          confidence: event.output.confidence,
          result: resultPreview,
        });
        completedTaskCount++;
        if (completedTaskCount % DISTILL_EVERY === 0) {
          skillDistiller.distill().then(skills => {
            if (skills.length > 0) {
              // QUAL-05: normalize log messages to English (user-facing messages stay in Czech)
              logger.info(`SkillDistiller: distilled ${skills.length} new skills`);
            }
          }).catch(err => logger.debug("SkillDistiller.distill failed", { error: String(err) }));
          skillSynthesizer.synthesizeAll().then(synths => {
            if (synths.length > 0) {
              logger.info(`SkillSynthesizer: synthesized ${synths.length} executable skills`);
            }
          }).catch(err => logger.debug("SkillSynthesizer.synthesizeAll failed", { error: String(err) }));
        }
        break;
      }
      case "task:failed":
        lastTaskActivityTime = Date.now();
        logger.warn("Task failed", { error: event.error });
        break;
      case "security:blocked":
        logger.warn("Security blocked action", { reason: event.reason });
        break;
      case "meta:watchdog_alert":
        logger.warn("Watchdog alert", { message: event.message });
        break;
      case "system:cost_warning":
        logger.warn("Cost warning", { current: event.currentCost, limit: event.limit });
        break;
    }
  };
  eventBus.onAny(daemonEventHandler);

  // Idle threshold: skip background LLM work when no tasks completed in last 10 minutes
  const IDLE_THRESHOLD_MS = 10 * 60_000;
  const isIdle = () => Date.now() - lastTaskActivityTime > IDLE_THRESHOLD_MS;

  // Memory consolidation every 30 minutes (converts old episodes → semantic facts)
  // Idle guard: skip when no task activity — nothing new to consolidate
  // OPS-02: unref timers so they don't prevent process exit in test environments
  const consolidationTimer = setInterval(() => {
    if (isIdle()) { logger.debug("Memory consolidation skipped — idle"); return; }
    memory.consolidate().catch(err => logger.debug("Memory consolidation failed", { error: String(err) }));
  }, 30 * 60_000).unref();

  // Architecture Proposer: analyze system performance every 2 hours
  // Idle guard: skip when no task activity — no new metrics to analyze
  // OPS-02: unref timers so they don't prevent process exit in test environments
  const archProposerTimer = setInterval(() => {
    if (isIdle()) { logger.debug("ArchProposer skipped — idle"); return; }
    archProposer.runAnalysis(taskStore, memory).catch(e => logger.debug("ArchProposer analysis failed", { error: String(e) }));
  }, 2 * 60 * 60_000).unref();

  // Start MCP server (Claude.ai / external tool integration)
  try {
    await mcpServer.start();
    logger.info("MCP server started", { port: 3099 });
  } catch (err) {
    logger.warn("MCP server failed to start", { error: String(err) });
  }

  // Start Web Dashboard (browser UI on localhost:3100)
  let webDashboard: WebDashboardServer | null = null;
  if (config.web?.enabled !== false) {
    webDashboard = new WebDashboardServer(taskStore, mediator, { port: config.web?.port ?? 3100, host: config.web?.host, authToken: config.web?.authToken, pool, llm });
    try {
      await webDashboard.start();
      logger.info("Web dashboard started", { port: config.web?.port ?? 3100 });
    } catch (err) {
      logger.warn("Web dashboard failed to start", { error: String(err) });
    }
  }

  // Start adversarial tester (hourly security self-audit)
  // OPS-04: adversarialTester was starting immediately at boot; delay first run by 1 full interval
  // Idle guard: only run if there was task activity — saves ~$3.60/day when idle.
  // OPUS: store setTimeout handle so it can be cleared during shutdown
  const ADVERSARIAL_INTERVAL_MS = 60 * 60_000;
  let adversarialTimer: ReturnType<typeof setInterval> | null = null;
  const adversarialStartTimer = setTimeout(() => {
    if (!isIdle()) {
      adversarialTester.runTestSuite().catch(err => logger.debug("Adversarial suite failed", { error: String(err) }));
    } else {
      logger.debug("Adversarial tester skipped initial run — idle");
    }
    adversarialTimer = setInterval(() => {
      if (isIdle()) { logger.debug("Adversarial tester skipped — idle"); return; }
      adversarialTester.runTestSuite().catch(err => logger.debug("Adversarial suite failed", { error: String(err) }));
    }, ADVERSARIAL_INTERVAL_MS);
    adversarialTimer.unref();
  }, ADVERSARIAL_INTERVAL_MS);
  adversarialStartTimer.unref();

  // Start platforms (warn but don't crash if none configured)
  const { telegram, whatsapp, discord } = config.platforms;
  if (!telegram.enabled && !whatsapp.enabled && !discord.enabled) {
    logger.warn("No platforms configured — daemon running without Telegram/WhatsApp/Discord");
    console.log(chalk.yellow("⚠️  Žádná platforma není aktivní. Spusť: pepagi setup"));
  }

  const platforms = new PlatformManager(config, mediator, taskStore, llm, goalManager, memory, skillRegistry);
  try {
    await platforms.startAll();
  } catch (err) {
    logger.error("Platform start error", { error: String(err) });
    console.log(chalk.yellow(`⚠️  Platforma se nepodařila spustit: ${err}`));
  }

  // Load skills dynamically
  const { loaded: skillsLoaded, skipped: skillsSkipped } = await skillRegistry.loadAll();
  if (skillsLoaded > 0) {
    console.log(chalk.cyan(`  🔌 Skills: ${skillsLoaded} načteno${skillsSkipped > 0 ? `, ${skillsSkipped} odmítnuto scannerem` : ""}`));
  }

  // Start watchdog
  watchdog.start();

  // Start goal manager (proactive cron-based tasks)
  await goalManager.start();

  console.log(chalk.green("\n✅ PEPAGI Daemon běží!\n"));
  if (telegram.enabled) console.log(chalk.cyan("  📱 Telegram: aktivní"));
  if (whatsapp.enabled) console.log(chalk.cyan("  💬 WhatsApp: aktivní"));
  if (discord.enabled) console.log(chalk.cyan("  🎮 Discord: aktivní"));
  const bindHost = process.env.PEPAGI_HOST ?? config.web?.host ?? "127.0.0.1";
  console.log(chalk.cyan(`  🔌 MCP server: http://${bindHost}:3099`));
  if (webDashboard) console.log(chalk.cyan(`  🌐 Web dashboard: http://${bindHost}:${config.web?.port ?? 3100}`));
  console.log(chalk.gray(`\n  PID: ${process.pid} (${PID_FILE})`));
  console.log(chalk.gray("  Logy: ~/.pepagi/logs/"));
  console.log(chalk.gray("  Ctrl+C pro zastavení\n"));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(chalk.yellow(`\n⏹  Daemon zastavuji (${signal})...`));
    watchdog.stop();
    goalManager.stop();
    // OPUS: clear the delayed start timer, idle-guarded interval, and stop the tester itself
    clearTimeout(adversarialStartTimer);
    if (adversarialTimer) clearInterval(adversarialTimer);
    adversarialTester.stop();
    clearInterval(consolidationTimer);
    clearInterval(archProposerTimer);
    // FIX: remove named event handler to prevent listener leak on restart
    eventBus.offAny(daemonEventHandler);
    // AUDIT: stop credential lifecycle timer to prevent accumulation on restart
    credentialLifecycle.destroy();
    await platforms.stopAll();
    await mcpServer.stop();
    if (webDashboard) await webDashboard.stop();
    if (config.consciousness?.enabled !== false) {
      await consciousness.shutdown();
    }
    await removePid();
    logger.info("Daemon stopped gracefully");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // Keep process alive
  await new Promise(() => {});
}

main().catch(err => {
  logger.error("Daemon fatal error", { error: String(err) });
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
