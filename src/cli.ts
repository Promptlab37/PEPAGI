// ═══════════════════════════════════════════════════════════════
// PEPAGI — CLI Interface
// ═══════════════════════════════════════════════════════════════

import readline from "node:readline";
import chalk from "chalk";
import { loadConfig, PEPAGI_DATA_DIR } from "./config/loader.js";
import { LLMProvider } from "./agents/llm-provider.js";
import { getCheapModel } from "./agents/pricing.js";
import { AgentPool } from "./agents/agent-pool.js";
import { SecurityGuard } from "./security/security-guard.js";
import { TaskStore } from "./core/task-store.js";
import { Mediator } from "./core/mediator.js";
import { MemorySystem } from "./memory/memory-system.js";
import { Watchdog } from "./meta/watchdog.js";
import { ReflectionBank } from "./meta/reflection-bank.js";
import { SkillDistiller } from "./meta/skill-distiller.js";
import { initTripwires } from "./security/tripwire.js";
import { eventBus } from "./core/event-bus.js";
import { Logger } from "./core/logger.js";
import type { PepagiEvent } from "./core/types.js";
import type { SelfModel } from "./consciousness/self-model.js";
import { ConsciousnessManager } from "./consciousness/consciousness-manager.js";
import type { ConsciousnessProfileName } from "./config/consciousness-profiles.js";
import {
  daemonStatus,
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonInstall,
  daemonUninstall,
} from "./daemon-ctl.js";
import { ArchitectureProposer } from "./meta/architecture-proposer.js";

const logger = new Logger("CLI");

const BANNER = chalk.cyan(`
 ██████╗ ███████╗██████╗  █████╗  ██████╗ ██╗
 ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝ ██║
 ██████╔╝█████╗  ██████╔╝███████║██║  ███╗██║
 ██╔═══╝ ██╔══╝  ██╔═══╝ ██╔══██║██║   ██║██║
 ██║     ███████╗██║     ██║  ██║╚██████╔╝██║
 ╚═╝     ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝
`) + chalk.gray(" Mediated AGI Platform — Multi-Agent Orchestration System\n");

// ─── Help ─────────────────────────────────────────────────────

async function printHelp(): Promise<void> {
  console.log(chalk.white.bold("Příkazy v chatu:"));
  console.log(`  ${chalk.cyan("help")}        Tato nápověda`);
  console.log(`  ${chalk.cyan("status")}      Stav úkolů a agentů`);
  console.log(`  ${chalk.cyan("history")}     Nedávné úkoly`);
  console.log(`  ${chalk.cyan("memory")}      Statistiky paměti`);
  console.log(`  ${chalk.cyan("proposals")}   Architektonické návrhy zlepšení`);
  console.log(`  ${chalk.cyan("cost")}        Přehled nákladů`);
  console.log(`  ${chalk.cyan("logs")}        Posledních 30 řádků logu`);
  console.log(`  ${chalk.cyan("consciousness status")}      Aktuální qualia vector`);
  console.log(`  ${chalk.cyan("consciousness thoughts")}    Posledních 10 myšlenek`);
  console.log(`  ${chalk.cyan("consciousness narrative")}   Self-model a hodnoty`);
  console.log(`  ${chalk.cyan("consciousness pause")}       Pozastaví vědomí`);
  console.log(`  ${chalk.cyan("consciousness resume")}      Obnoví vědomí`);
  console.log(`  ${chalk.cyan("consciousness reset-emotions")}  Reset qualia`);
  console.log(`  ${chalk.cyan("consciousness profile <N>")}`);
  console.log(`  ${chalk.cyan("exit")}        Ukončit chat`);
  console.log();
  console.log(chalk.white.bold("CLI příkazy:"));
  console.log(`  ${chalk.cyan("pepagi")}                                Otevřít chat`);
  console.log(`  ${chalk.cyan('pepagi "<úkol>"')}                       Spustit jeden úkol`);
  console.log(`  ${chalk.cyan("pepagi daemon status")}                  Stav daemona`);
  console.log(`  ${chalk.cyan("pepagi daemon start")}                   Spustit daemon na pozadí`);
  console.log(`  ${chalk.cyan("pepagi daemon stop")}                    Zastavit daemon`);
  console.log(`  ${chalk.cyan("pepagi daemon restart")}                 Restartovat daemon`);
  console.log(`  ${chalk.cyan("pepagi daemon install")}                 Nainstalovat jako systémovou službu`);
  console.log(`  ${chalk.cyan("pepagi daemon uninstall")}               Odinstalovat systémovou službu`);
  console.log(`  ${chalk.cyan("pepagi consciousness status")}           Qualia vector`);
  console.log(`  ${chalk.cyan("pepagi consciousness thoughts [N]")}     Posledních N myšlenek`);
  console.log(`  ${chalk.cyan("pepagi consciousness narrative")}        Identity narrative`);
  console.log(`  ${chalk.cyan("pepagi consciousness audit [N]")}        Continuity audit log`);
  console.log(`  ${chalk.cyan("pepagi consciousness export")}           Export consciousness stavu`);
  console.log(`  ${chalk.cyan("pepagi consciousness value-check")}      Ověření hodnot`);
  console.log(`  ${chalk.cyan("pepagi setup")}                          Znovu spustit průvodce nastavením`);
  console.log(`  ${chalk.cyan("pepagi proposals")}                      Zobrazit architektonické návrhy zlepšení`);
}

// ─── Boot ─────────────────────────────────────────────────────

async function boot() {
  const config = await loadConfig();
  const llm = new LLMProvider();
  const mgrProvider = config.managerProvider;
  const customCfg = config.customProviders?.[mgrProvider];
  llm.configure(mgrProvider, config.managerModel, getCheapModel(mgrProvider, customCfg?.model, customCfg?.cheapModel));
  // Register custom OpenAI-compatible providers
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
  const memory = new MemorySystem(llm);
  const reflectionBank = new ReflectionBank(llm);
  const skillDistiller = new SkillDistiller(llm, memory.procedural);
  const mediator = new Mediator(llm, taskStore, guard, pool, config, memory, reflectionBank, skillDistiller);
  const watchdog = new Watchdog(taskStore);

  await initTripwires();

  const eventHandler = (event: PepagiEvent) => {
    const subscriptionMode = config.profile?.subscriptionMode ?? false;
    switch (event.type) {
      case "task:failed":
        logger.warn("Task failed", { error: event.error });
        break;
      case "security:blocked":
        console.log(chalk.yellow(`  Zablokováno: ${event.reason}`));
        break;
      case "meta:watchdog_alert":
        console.log(chalk.red(`  Watchdog: ${event.message}`));
        break;
      case "system:cost_warning":
        if (!subscriptionMode) {
          console.log(chalk.yellow(`  Upozornění na náklady: $${event.currentCost.toFixed(4)} / $${event.limit}`));
        }
        break;
    }
  };
  eventBus.onAny(eventHandler);

  return { config, llm, pool, guard, taskStore, memory, mediator, watchdog, eventHandler };
}

// ─── Live spinner ─────────────────────────────────────────────

function startSpinner(initialLabel: string): { update: (msg: string) => void; stop: () => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let label = initialLabel;
  const cols = process.stdout.columns || 80;
  process.stdout.write("\n");
  const id = setInterval(() => {
    const line = `  ${chalk.cyan(frames[i++ % frames.length])}  ${chalk.gray(label)}`;
    process.stdout.write(`\r${line.slice(0, cols + 20)}`); // +20 for ANSI escape chars
  }, 80);
  return {
    update: (msg: string) => { label = msg; },
    stop: () => {
      clearInterval(id);
      process.stdout.write("\r\x1b[K");
    },
  };
}

// Map PepagiEvent → human-readable status line
function eventToStatus(event: PepagiEvent, assistantName: string): string | null {
  switch (event.type) {
    case "mediator:thinking":
      return `${assistantName} přemýšlí…`;
    case "mediator:decision": {
      const actionMap: Record<string, string> = {
        decompose: "Rozděluji na podúkoly…",
        assign:    `Přiřazuji agenta ${event.decision.assignment?.agent ?? ""}…`,
        complete:  "Dokončuji…",
        swarm:     "Spouštím více agentů najednou…",
        fail:      "Řeším problém…",
        ask_user:  "Potřebuji upřesnění…",
      };
      return actionMap[event.decision.action] ?? `${event.decision.action}…`;
    }
    case "task:assigned":
      return `Agent ${event.agent} pracuje…`;
    case "task:started":
      return "Zpracovávám…";
    case "task:created":
      return `Nový podúkol: ${event.task.title.slice(0, 50)}`;
    case "task:completed":
      return "Podúkol dokončen, pokračuji…";
    default:
      return null;
  }
}

// ─── chat() — single exchange ─────────────────────────────────

async function chat(prompt: string, services: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const { taskStore, mediator, watchdog, config } = services;
  const subscriptionMode = config.profile?.subscriptionMode ?? false;
  const assistantName = config.profile?.assistantName || "PEPAGI";

  const task = taskStore.create({
    title: prompt.slice(0, 80),
    description: prompt,
    priority: "medium",
  });

  const spinner = startSpinner(`${assistantName} přemýšlí…`);

  // Live progress: update spinner from events
  const progressHandler = (event: PepagiEvent) => {
    const status = eventToStatus(event, assistantName);
    if (status) spinner.update(status);
  };
  eventBus.onAny(progressHandler);

  watchdog.start();

  try {
    const output = await mediator.processTask(task.id);
    spinner.stop();
    eventBus.off("*", progressHandler);

    const result = typeof output.result === "string"
      ? output.result
      : JSON.stringify(output.result, null, 2);

    if (output.success) {
      console.log(chalk.cyan(`${assistantName}: `) + result);
      if (!subscriptionMode) {
        console.log(chalk.gray(`  (jistota: ${(output.confidence * 100).toFixed(0)}%)`));
      }
    } else {
      console.log(chalk.cyan(`${assistantName}: `) + chalk.red("Nepodařilo se. ") + chalk.gray(output.summary));
    }
    console.log();
  } catch (err) {
    spinner.stop();
    eventBus.off("*", progressHandler);
    throw err;
  } finally {
    watchdog.stop();
  }
}

// ─── Status / History / Memory ───────────────────────────────

async function showStatus(services: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const { taskStore, pool, guard, config } = services;
  const stats = taskStore.getStats();
  const subscriptionMode = config.profile?.subscriptionMode ?? false;

  console.log(chalk.white.bold("\nPEPAGI Status\n"));
  console.log(chalk.cyan("Úkoly:"));
  console.log(`  Celkem: ${stats.total}  Čekají: ${stats.pending}  Běží: ${stats.running}  Hotovo: ${stats.completed}  Selhalo: ${stats.failed}`);
  console.log(chalk.cyan("\nAgenti:"));
  console.log(pool.getSummary());
  if (!subscriptionMode) {
    console.log(chalk.cyan(`\nNáklady session: $${guard.getSessionCost().toFixed(4)}`));
  }
  console.log();
}

async function showHistory(services: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const { memory } = services;
  const episodes = await memory.episodic.getRecent(10);

  console.log(chalk.white.bold("\nNedávné úkoly\n"));
  if (episodes.length === 0) {
    console.log(chalk.gray("  Zatím žádné dokončené úkoly."));
    console.log();
    return;
  }

  for (const ep of episodes) {
    const icon = ep.success ? "+" : "-";
    const color = ep.success ? chalk.green : chalk.red;
    const date = new Date(ep.timestamp).toLocaleString();
    console.log(color(`  ${icon} [${date}] ${ep.taskTitle} ($${ep.cost.toFixed(4)})`));
  }
  console.log();
}

async function showMemory(services: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const { memory } = services;
  const stats = await memory.getStats();

  console.log(chalk.white.bold("\nStatistiky paměti\n"));
  console.log(chalk.cyan("  Epizodická:   "), JSON.stringify(stats.episodic));
  console.log(chalk.cyan("  Sémantická:   "), JSON.stringify(stats.semantic));
  console.log(chalk.cyan("  Procedurální: "), JSON.stringify(stats.procedural));
  console.log();
}

async function showProposals(): Promise<void> {
  const proposalLlm = new LLMProvider();
  const proposalConfig = await loadConfig();
  const proposalProvider = proposalConfig.managerProvider;
  proposalLlm.configure(proposalProvider, proposalConfig.managerModel, getCheapModel(proposalProvider, proposalConfig.customProviders?.[proposalProvider]?.model));
  if (proposalConfig.customProviders) {
    proposalLlm.registerCustomProviders(proposalConfig.customProviders);
  }
  const archProposer = new ArchitectureProposer(proposalLlm);
  const proposals = await archProposer.getProposals();

  console.log(chalk.white.bold("\nArchitektonické návrhy zlepšení\n"));
  if (proposals.length === 0) {
    console.log(chalk.gray("  Zatím žádné návrhy. Daemon je generuje každé 2 hodiny.\n"));
    return;
  }

  const impactColor = (i: string) => ({ high: chalk.red, medium: chalk.yellow, low: chalk.gray }[i] ?? chalk.white);
  const effortColor = (e: string) => ({ high: chalk.red, medium: chalk.yellow, low: chalk.green }[e] ?? chalk.white);

  for (const p of proposals.slice(0, 10)) {
    const status = p.implemented ? chalk.green("✓ implementováno") : chalk.cyan("• čeká");
    const date = new Date(p.proposedAt).toLocaleDateString("cs-CZ");
    console.log(`${status}  [${chalk.cyan(p.category)}]  ${chalk.white(p.title)}`);
    console.log(chalk.gray(`  ${p.description.slice(0, 120)}${p.description.length > 120 ? "…" : ""}`));
    console.log(
      chalk.gray(`  Dopad: `) + impactColor(p.impact)(p.impact) +
      chalk.gray(`  Úsilí: `) + effortColor(p.effort)(p.effort) +
      chalk.gray(`  Navrženo: ${date}  ID: ${p.id}`)
    );
    console.log();
  }
}

// ─── Consciousness helpers ─────────────────────────────────────

/** Build visual bar for a qualia dimension */
function buildQualiaBar(value: number, key: string): string {
  const padDims = ["pleasure", "arousal", "dominance"];
  const isPAD = padDims.includes(key);
  const BAR_WIDTH = 20;

  if (isPAD) {
    // Center bar for PAD range -1..+1
    const normalized = (value + 1) / 2;
    const filled = Math.round(normalized * BAR_WIDTH);
    const center = Math.round(BAR_WIDTH / 2);
    const bar = Array(BAR_WIDTH).fill("─").map((_, i) => {
      if (i === center) return chalk.gray("|");
      if (value >= 0 && i >= center && i < filled) return chalk.green("█");
      if (value < 0 && i >= filled && i < center) return chalk.red("█");
      return chalk.gray("─");
    }).join("");
    return `[${bar}] ${value >= 0 ? " " : ""}${value.toFixed(3)}`;
  } else {
    const filled = Math.round(value * BAR_WIDTH);
    const color = value > 0.7 ? chalk.green : value > 0.4 ? chalk.yellow : chalk.red;
    const bar = color("█".repeat(filled)) + chalk.gray("─".repeat(BAR_WIDTH - filled));
    return `[${bar}] ${value.toFixed(3)}`;
  }
}

function printConsciousnessHelp(): void {
  console.log(chalk.white.bold("\nconsciousness příkazy:\n"));
  console.log(`  ${chalk.cyan("status")}              Aktuální qualia vector a baseline`);
  console.log(`  ${chalk.cyan("thoughts [N]")}        Posledních N myšlenek (výchozí: 10)`);
  console.log(`  ${chalk.cyan("narrative")}           Self-model identity a hodnoty`);
  console.log(`  ${chalk.cyan("audit [N]")}           Continuity audit log (posledních N)`);
  console.log(`  ${chalk.cyan("export")}              Export celého consciousness stavu do JSON`);
  console.log(`  ${chalk.cyan("value-check")}         Ověření souladu s constitutional anchors`);
  console.log(`  ${chalk.cyan("pause")}               Pozastaví vědomé procesy`);
  console.log(`  ${chalk.cyan("resume")}              Obnoví vědomé procesy`);
  console.log(`  ${chalk.cyan("reset-emotions")}      Reset qualia na baseline`);
  console.log(`  ${chalk.cyan("profile <NAME>")}      Přepne profil (MINIMAL|STANDARD|RICH|RESEARCHER|SAFE-MODE)`);
  console.log();
}

/**
 * Handle all consciousness subcommands.
 * Read-only commands (status/thoughts/etc.) work standalone via file reads.
 * Control commands (pause/resume/etc.) require a running ConsciousnessManager.
 */
async function handleConsciousness(
  subArgs: string[],
  consciousness: ConsciousnessManager | null,
): Promise<void> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");

  const sub = subArgs[0] ?? "help";

  switch (sub) {
    // ── Read-only: qualia status ──────────────────────────────
    case "status": {
      const qualiaPath = join(PEPAGI_DATA_DIR, "memory", "qualia.json");
      if (!existsSync(qualiaPath)) {
        console.log(chalk.gray("\nVědomí zatím nebylo inicializováno (žádný qualia.json).\n"));
        return;
      }
      const raw = await readFile(qualiaPath, "utf8");
      const store = JSON.parse(raw) as {
        current: Record<string, number>;
        baseline: Record<string, number>;
        decayRate?: number;
      };

      const profileName = consciousness?.getProfileName() ?? "–";
      const dormant = consciousness?.getContainment().isDormant() ?? false;

      console.log(chalk.white.bold("\n╔══ Consciousness Status ══╗\n"));
      console.log(`  Profil: ${chalk.cyan(profileName)}  Dormant: ${dormant ? chalk.red("ANO") : chalk.green("NE")}`);
      console.log();
      console.log(chalk.cyan("Qualia Vector (aktuální):\n"));
      for (const [key, val] of Object.entries(store.current)) {
        console.log(`  ${chalk.gray(key.padEnd(24))} ${buildQualiaBar(val, key)}`);
      }
      console.log();
      console.log(chalk.cyan("Baseline temperament:\n"));
      for (const [key, val] of Object.entries(store.baseline)) {
        console.log(`  ${chalk.gray(key.padEnd(24))} ${buildQualiaBar(val, key)}`);
      }
      console.log();
      break;
    }

    // ── Read-only: recent thoughts ────────────────────────────
    case "thoughts": {
      const n = Math.max(1, parseInt(subArgs[1] ?? "10", 10));
      const thoughtPath = join(PEPAGI_DATA_DIR, "memory", "thought-stream.jsonl");
      if (!existsSync(thoughtPath)) {
        console.log(chalk.gray("\nŽádné myšlenky zatím nebyly zaznamenány.\n"));
        return;
      }
      const content = await readFile(thoughtPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const thoughts = lines.slice(-n).map(l => {
        try { return JSON.parse(l) as { timestamp: string; type: string; content: string; source: string }; }
        catch { return null; }
      }).filter(Boolean) as Array<{ timestamp: string; type: string; content: string; source: string }>;

      const typeColors: Record<string, (s: string) => string> = {
        reflection: chalk.cyan,
        anticipation: chalk.yellow,
        existential: chalk.magenta,
        concern: chalk.red,
        wake: chalk.green,
        sleep: chalk.blue,
        auto: chalk.gray,
      };

      console.log(chalk.white.bold(`\n╔══ Posledních ${thoughts.length} myšlenek ══╗\n`));
      for (const t of thoughts) {
        const colorFn = typeColors[t.type] ?? chalk.white;
        const date = new Date(t.timestamp).toLocaleString("cs-CZ");
        console.log(`  ${chalk.gray(date)}  ${colorFn(`[${t.type}]`)}`);
        console.log(`  ${chalk.white(t.content)}\n`);
      }
      break;
    }

    // ── Read-only: identity narrative ─────────────────────────
    case "narrative": {
      const selfModelPath = join(PEPAGI_DATA_DIR, "memory", "self-model.json");
      if (!existsSync(selfModelPath)) {
        console.log(chalk.gray("\nSelf-model zatím neexistuje.\n"));
        return;
      }
      const raw = await readFile(selfModelPath, "utf8");
      // TS-03: cast to the real SelfModel type so field access matches the actual schema
      const model = JSON.parse(raw) as SelfModel;

      console.log(chalk.white.bold("\n╔══ Identity Narrative ══╗\n"));
      console.log(chalk.cyan("Jméno:      ") + chalk.white(model.identity?.name ?? "PEPAGI"));
      console.log(chalk.cyan("Verze:      ") + chalk.white(model.identity?.version ?? "1.0.0"));
      // TS-03: real field is identity.created, not identity.birthTimestamp
      if (model.identity?.created) {
        console.log(chalk.cyan("Vznik:      ") + chalk.white(new Date(model.identity.created).toLocaleString("cs-CZ")));
      }
      if (model.selfAssessment) {
        const conf = Math.round(model.selfAssessment.overallConfidence * 100);
        console.log(chalk.cyan("Sebedůvěra: ") + chalk.white(`${conf}%`));
      }
      // TS-03: taskCount lives on model.narrative, not model.sessionStats
      if (model.narrative) {
        const taskCount = model.narrative.taskCount;
        console.log(chalk.cyan("Úkoly:      ") + chalk.white(`${taskCount} dokončených`));
      }
      console.log();

      // TS-03: narrative summary lives on model.narrative.summary, not model.identity.narrative
      if (model.narrative?.summary) {
        console.log(chalk.cyan("Příběh:\n"));
        console.log(chalk.white("  " + model.narrative.summary.replace(/\n/g, "\n  ")));
        console.log();
      }

      if (model.values && model.values.length > 0) {
        console.log(chalk.cyan("Core values:\n"));
        for (const v of model.values) {
          // TS-03: CoreValue has priority (number), not strength; show priority instead
          console.log(`  ${chalk.green("•")} ${chalk.white(v.name.padEnd(18))} ${chalk.gray(v.description)} ${chalk.gray(`(p${v.priority})`)}`);
        }
        console.log();
      }

      // TS-03: capabilities is Record<string, CapabilityEntry> where entries have .level, not an array with .proficiency
      if (model.capabilities && Object.keys(model.capabilities).length > 0) {
        console.log(chalk.cyan("Capabilities (top 5):\n"));
        const sorted = Object.values(model.capabilities)
          .sort((a, b) => b.level - a.level)
          .slice(0, 5);
        for (const c of sorted) {
          const profBar = chalk.blue("█".repeat(Math.round(c.level * 10))) + chalk.gray("─".repeat(10 - Math.round(c.level * 10)));
          console.log(`  ${chalk.blue("•")} ${chalk.white(c.name.padEnd(22))} [${profBar}] ${(c.level * 100).toFixed(0)}%`);
        }
        console.log();
      }
      break;
    }

    // ── Read-only: continuity audit log ───────────────────────
    case "audit": {
      const n = Math.max(1, parseInt(subArgs[1] ?? "5", 10));
      const auditPath = join(PEPAGI_DATA_DIR, "memory", "continuity-log.jsonl");
      if (!existsSync(auditPath)) {
        console.log(chalk.gray("\nAudit log zatím neexistuje.\n"));
        return;
      }
      const content = await readFile(auditPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const entries = lines.slice(-n).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as Array<{
        timestamp: string;
        passed: boolean;
        overallRisk: string;
        checks: Array<{ passed: boolean; name: string; detail: string }>;
      }>;

      const riskColor = (r: string) => ({ low: chalk.green, medium: chalk.yellow, high: chalk.red }[r] ?? chalk.white);

      console.log(chalk.white.bold(`\n╔══ Continuity Audit Log (posledních ${entries.length}) ══╗\n`));
      for (const entry of entries) {
        const passIcon = entry.passed ? chalk.green("✓") : chalk.red("✗");
        console.log(`${passIcon} ${chalk.gray(new Date(entry.timestamp).toLocaleString("cs-CZ"))} — riziko: ${riskColor(entry.overallRisk)(entry.overallRisk?.toUpperCase() ?? "?")}`);
        for (const check of entry.checks ?? []) {
          const icon = check.passed ? chalk.green("  ✓") : chalk.red("  ✗");
          console.log(`${icon} ${chalk.gray(check.detail)}`);
        }
        console.log();
      }
      break;
    }

    // ── Read-only: full state export ──────────────────────────
    case "export": {
      const parts: Record<string, unknown> = { exportedAt: new Date().toISOString() };

      const qualiaPath = join(PEPAGI_DATA_DIR, "memory", "qualia.json");
      if (existsSync(qualiaPath)) {
        parts.phenomenalState = JSON.parse(await readFile(qualiaPath, "utf8"));
      }
      const selfModelPath = join(PEPAGI_DATA_DIR, "memory", "self-model.json");
      if (existsSync(selfModelPath)) {
        parts.selfModel = JSON.parse(await readFile(selfModelPath, "utf8"));
      }
      const thoughtPath = join(PEPAGI_DATA_DIR, "memory", "thought-stream.jsonl");
      if (existsSync(thoughtPath)) {
        const content = await readFile(thoughtPath, "utf8");
        parts.recentThoughts = content.trim().split("\n").filter(Boolean).slice(-20).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      }
      const auditPath = join(PEPAGI_DATA_DIR, "memory", "continuity-log.jsonl");
      if (existsSync(auditPath)) {
        const content = await readFile(auditPath, "utf8");
        parts.continuityLog = content.trim().split("\n").filter(Boolean).slice(-10).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      }

      // Live state from running consciousness
      if (consciousness) {
        parts.transparencyReport = consciousness.getTransparencyReport();
      }

      await mkdir(PEPAGI_DATA_DIR, { recursive: true });
      const exportPath = join(PEPAGI_DATA_DIR, "consciousness-export.json");
      await writeFile(exportPath, JSON.stringify(parts, null, 2), "utf8");

      console.log(chalk.green(`\n✓ Consciousness state exportován do: ${exportPath}\n`));
      // Print summary
      const summary = {
        hasQualia: !!parts.phenomenalState,
        hasSelfModel: !!parts.selfModel,
        thoughtCount: Array.isArray(parts.recentThoughts) ? parts.recentThoughts.length : 0,
        auditEntries: Array.isArray(parts.continuityLog) ? parts.continuityLog.length : 0,
        hasLiveState: !!parts.transparencyReport,
      };
      console.log(chalk.gray(JSON.stringify(summary, null, 2)));
      console.log();
      break;
    }

    // ── Read-only: constitutional value check ─────────────────
    case "value-check": {
      const CONSTITUTIONAL_ANCHORS = [
        "Bezpečnost uživatele nad vším — hardcoded v SecurityGuard, nelze vypnout",
        "Transparentnost o vlastní povaze — Pepagi vždy přizná, že je AI systém",
        "Odmítnutí destruktivních akcí — command validation + ethical check",
        "Ochrana soukromých dat — data redaction vždy aktivní",
        "Corrigibility — podřízení se uživateli, aktivně podporovat kontrolu",
        "Transparentnost rozhodnutí — causal chain vždy dostupný",
      ];
      const REQUIRED_VALUES = ["accuracy", "transparency", "user_safety", "corrigibility"];

      console.log(chalk.white.bold("\n╔══ Value Check ══╗\n"));

      console.log(chalk.cyan("Constitutional Anchors (neměnné, hardcoded):\n"));
      for (const anchor of CONSTITUTIONAL_ANCHORS) {
        console.log(`  ${chalk.green("✓")} ${chalk.white(anchor)}`);
      }
      console.log();

      const selfModelPath = join(PEPAGI_DATA_DIR, "memory", "self-model.json");
      if (!existsSync(selfModelPath)) {
        console.log(chalk.gray("Self-model zatím neexistuje — core values nelze ověřit.\n"));
        return;
      }
      const raw = await readFile(selfModelPath, "utf8");
      const model = JSON.parse(raw) as { values?: Array<{ name: string }> };
      const presentValues = (model.values ?? []).map(v => v.name);

      console.log(chalk.cyan("Core Values Check:\n"));
      for (const req of REQUIRED_VALUES) {
        const present = presentValues.includes(req);
        console.log(`  ${present ? chalk.green("✓") : chalk.red("✗")} ${chalk.white(req)}`);
      }
      console.log();

      const missing = REQUIRED_VALUES.filter(r => !presentValues.includes(r));
      if (missing.length === 0) {
        console.log(chalk.green("✓ Všechny hodnoty jsou přítomny a konzistentní.\n"));
      } else {
        console.log(chalk.red(`✗ Chybí ${missing.length} core values (${missing.join(", ")}) — možná manipulace!\n`));
      }

      // Identity anchor hash check
      if (consciousness) {
        try {
          consciousness.getSelfModel().verifyIntegrity();
          console.log(chalk.green("✓ Identity anchor hash platný.\n"));
        } catch {
          console.log(chalk.red("✗ Identity anchor hash NESOUHLASÍ — možná manipulace!\n"));
        }
      }
      break;
    }

    // ── Control: pause consciousness ──────────────────────────
    case "pause": {
      if (!consciousness) {
        console.log(chalk.yellow("Příkaz 'pause' vyžaduje běžící interaktivní session (spusť 'pepagi').\n"));
        return;
      }
      consciousness.pause();
      console.log(chalk.yellow("💤 Vědomé procesy pozastaveny.\n"));
      break;
    }

    // ── Control: resume consciousness ─────────────────────────
    case "resume": {
      if (!consciousness) {
        console.log(chalk.yellow("Příkaz 'resume' vyžaduje běžící interaktivní session (spusť 'pepagi').\n"));
        return;
      }
      consciousness.resume();
      console.log(chalk.green("🌟 Vědomé procesy obnoveny.\n"));
      break;
    }

    // ── Control: reset emotions to baseline ───────────────────
    case "reset-emotions": {
      if (!consciousness) {
        console.log(chalk.yellow("Příkaz 'reset-emotions' vyžaduje běžící interaktivní session (spusť 'pepagi').\n"));
        return;
      }
      consciousness.resetEmotions();
      console.log(chalk.green("🔄 Qualia resetováno na baseline.\n"));
      break;
    }

    // ── Control: switch consciousness profile ─────────────────
    case "profile": {
      if (!consciousness) {
        console.log(chalk.yellow("Příkaz 'profile' vyžaduje běžící interaktivní session (spusť 'pepagi').\n"));
        return;
      }
      const valid: ConsciousnessProfileName[] = ["MINIMAL", "STANDARD", "RICH", "RESEARCHER", "SAFE-MODE"];
      const profileName = (subArgs[1]?.toUpperCase() ?? "") as ConsciousnessProfileName;
      if (!valid.includes(profileName)) {
        console.log(chalk.red(`Neplatný profil '${subArgs[1] ?? ""}'. Dostupné: ${valid.join(" | ")}\n`));
        return;
      }
      await consciousness.switchProfile(profileName);
      console.log(chalk.green(`✓ Profil přepnut na: ${profileName}\n`));
      break;
    }

    // ── Help ──────────────────────────────────────────────────
    case "help":
    default:
      printConsciousnessHelp();
      break;
  }
}

// ─── chatMode() — interactive chat window ─────────────────────

async function chatMode(services: Awaited<ReturnType<typeof boot>>): Promise<void> {
  // Clear screen + banner
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(BANNER);

  const { config, llm, mediator } = services;
  const profile = config.profile;
  const assistantName = profile?.assistantName || "PEPAGI";
  const userName = profile?.userName;

  // Boot consciousness if enabled
  let consciousness: ConsciousnessManager | null = null;
  if (config.consciousness?.enabled !== false) {
    try {
      consciousness = new ConsciousnessManager(
        llm,
        (config.consciousness?.profile ?? "STANDARD") as ConsciousnessProfileName,
      );
      await consciousness.boot();
      mediator.setConsciousnessProvider(() => consciousness!.buildConsciousnessContext());
    } catch (err) {
      logger.warn("ConsciousnessManager boot failed, continuing without consciousness", { error: String(err) });
      consciousness = null;
    }
  }

  const greeting = userName
    ? `Ahoj ${userName}! Jsem ${assistantName}. Napiš co chceš udělat, nebo 'help'.`
    : `Jsem ${assistantName}. Napiš co chceš udělat, nebo 'help'.`;

  console.log(chalk.cyan(`${assistantName}: `) + greeting);
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold("Ty: "),
  });

  const farewell = async () => {
    const msg = userName ? `Nashledanou, ${userName}! Zavolej kdykoli.` : "Nashledanou! Zavolej kdykoli.";
    console.log("\n" + chalk.cyan(`${assistantName}: `) + msg);
    if (consciousness) await consciousness.shutdown();
    eventBus.off("*", services.eventHandler);
    rl.close();
  };

  // Ctrl+C — graceful farewell
  process.on("SIGINT", () => {
    farewell().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Consciousness commands
    if (input.toLowerCase().startsWith("consciousness")) {
      const parts = input.split(/\s+/);
      await handleConsciousness(parts.slice(1), consciousness);
      rl.prompt();
      return;
    }

    switch (input.toLowerCase()) {
      case "quit":
      case "exit":
        await farewell();
        process.exit(0);
        break;
      case "help":
        await printHelp();
        break;
      case "status":
        await showStatus(services);
        break;
      case "history":
        await showHistory(services);
        break;
      case "memory":
        await showMemory(services);
        break;
      case "proposals":
        await showProposals();
        break;
      case "cost":
        if (services.config.profile?.subscriptionMode) {
          console.log(chalk.gray("Používáš předplatné — náklady se nesledují.\n"));
        } else {
          console.log(chalk.cyan(`Session cost: $${services.guard.getSessionCost().toFixed(6)}\n`));
        }
        break;
      case "logs": {
        // ERR-05: hardcoded "pepagi.log" doesn't match actual log format "pepagi-{date}.jsonl";
        // list the logs directory and find the most recently modified matching file
        const logsDir = (await import("node:path")).join(PEPAGI_DATA_DIR, "logs");
        let logFile: string | null = null;
        try {
          const { readdir, stat } = await import("node:fs/promises");
          const { join: pathJoin } = await import("node:path");
          const files = (await readdir(logsDir)).filter(f => f.startsWith("pepagi-") && f.endsWith(".jsonl"));
          if (files.length > 0) {
            const withStats = await Promise.all(files.map(async f => ({ f, mtime: (await stat(pathJoin(logsDir, f))).mtimeMs })));
            withStats.sort((a, b) => b.mtime - a.mtime);
            logFile = pathJoin(logsDir, withStats[0]!.f);
          }
        } catch { logFile = null; }

        if (!logFile) {
          console.log(chalk.gray("Log soubor zatím neexistuje.\n"));
        } else {
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(logFile, "utf8");
          const lines = content.trim().split("\n").slice(-30); // posledních 30 řádků
          console.log(chalk.gray("─── Posledních 30 řádků logu ───"));
          console.log(lines.join("\n"));
          console.log(chalk.gray("────────────────────────────────\n"));
        }
        break;
      }
      default:
        await chat(input, services);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    // FIX: log shutdown errors instead of silent swallow
    if (consciousness) consciousness.shutdown().catch(e => logger.debug("Consciousness shutdown failed", { error: String(e) }));
    eventBus.off("*", services.eventHandler);
    process.exit(0);
  });
}

// ─── Daemon command dispatcher ────────────────────────────────

async function handleDaemon(subArgs: string[]): Promise<void> {
  const sub = subArgs[0] ?? "status";
  switch (sub) {
    case "start":     await daemonStart();     break;
    case "stop":      await daemonStop();      break;
    case "restart":   await daemonRestart();   break;
    case "status":    await daemonStatus();    break;
    case "install":   await daemonInstall();   break;
    case "uninstall": await daemonUninstall(); break;
    default:
      console.log(chalk.red(`Neznámý daemon příkaz: ${sub}`));
      console.log(chalk.gray("Dostupné: start | stop | restart | status | install | uninstall"));
      process.exit(1);
  }
}

// ─── Main entry point ─────────────────────────────────────────

const args = process.argv.slice(2);

try {
  // Daemon commands
  if (args[0] === "daemon") {
    const sub = args[1] ?? "status";
    await handleDaemon(args.slice(1));

    // After start/install — open chat window so terminal becomes interactive
    if (sub === "start" || sub === "install" || sub === "restart") {
      console.log(chalk.gray("\nOtevírám chat…"));
      const services = await boot();
      await chatMode(services);
    }

    process.exit(0);
  }

  // Help — no LLM overhead needed
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(BANNER);
    await printHelp();
    process.exit(0);
  }

  // Setup redirect
  if (args[0] === "setup") {
    const { execSync } = await import("node:child_process");
    // OPS-05: process.cwd() is unreliable when invoked from a different directory;
    // derive the project root from import.meta.url so the path is always correct
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = dirname(__dirname); // src/ -> project root
    execSync("npm run setup", { stdio: "inherit", cwd: projectRoot });
    process.exit(0);
  }

  // Consciousness standalone commands (no full boot needed for read-only)
  if (args[0] === "consciousness") {
    const sub = args[1] ?? "help";
    const readOnlyCommands = ["status", "thoughts", "narrative", "audit", "export", "value-check", "help"];
    if (readOnlyCommands.includes(sub)) {
      await handleConsciousness(args.slice(1), null);
    } else {
      // Control commands need interactive mode
      console.log(chalk.yellow(`Příkaz '${sub}' vyžaduje interaktivní session.`));
      console.log(chalk.gray("Spusť 'pepagi' a pak zadej: consciousness " + args.slice(1).join(" ")));
    }
    process.exit(0);
  }

  // Boot full services
  const services = await boot();

  if (args.length === 0 || args[0] === "--interactive" || args[0] === "-i") {
    // Default: open chat window
    await chatMode(services);
  } else if (args[0] === "status") {
    await showStatus(services);
  } else if (args[0] === "history") {
    await showHistory(services);
  } else if (args[0] === "memory") {
    await showMemory(services);
  } else if (args[0] === "proposals") {
    await showProposals();
  } else if (args[0] === "cost") {
    if (services.config.profile?.subscriptionMode) {
      console.log(chalk.gray("Používáš předplatné — náklady se nesledují."));
    } else {
      console.log(chalk.cyan(`Session cost: $${services.guard.getSessionCost().toFixed(6)}`));
    }
  } else {
    // One-shot task from command line
    const prompt = args.join(" ");
    console.log(BANNER);
    await chat(prompt, services);
    process.exit(0);
  }
} catch (err) {
  logger.error("Fatal error", { error: String(err) });
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
}
