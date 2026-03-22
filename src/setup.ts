#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// PEPAGI — Interactive Setup Wizard
// Supports multiple providers independently — never overwrites
// existing settings unless you explicitly change them.
// ═══════════════════════════════════════════════════════════════

import readline from "node:readline";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import chalk from "chalk";
import { PEPAGI_DATA_DIR } from "./config/loader.js";

const IS_WIN = platform() === "win32";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}
function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  return ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `).then(ans => {
    if (!ans) return defaultYes;
    return ans.toLowerCase().startsWith("y");
  });
}
function header(title: string) {
  const line = IS_WIN ? "=".repeat(52) : "═".repeat(52);
  console.log("\n" + chalk.cyan(line));
  console.log(chalk.cyan.bold("  " + title));
  console.log(chalk.cyan(line));
}
function info(msg: string)    { console.log(chalk.gray("  " + msg)); }
function success(msg: string) { console.log(chalk.green(IS_WIN ? "  OK: " + msg : "  ✓ " + msg)); }
function warn(msg: string)    { console.log(chalk.yellow(IS_WIN ? "  ! " + msg : "  ⚠ " + msg)); }
function current(label: string, value: string) {
  console.log(chalk.gray(`  ${label}: `) + chalk.cyan(value || chalk.italic(IS_WIN ? "(neni nastaveno)" : "(není nastaveno)")));
}

// ─── Config type ─────────────────────────────────────────────

interface CustomProviderEntry {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  cheapModel: string;
  enabled: boolean;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

interface SetupConfig {
  managerProvider: string;
  managerModel: string;
  agents: {
    claude: { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
    gpt:    { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
    gemini: { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
  };
  customProviders: Record<string, CustomProviderEntry>;
  profile: {
    userName: string;
    assistantName: string;
    communicationStyle: "human" | "direct";
    language: string;
    subscriptionMode: boolean;
    gptSubscriptionMode: boolean;
  };
  platforms: {
    telegram: { enabled: boolean; botToken: string; allowedUserIds: number[]; welcomeMessage: string };
    whatsapp: { enabled: boolean; allowedNumbers: string[]; welcomeMessage: string };
  };
  security: {
    maxCostPerTask: number;
    maxCostPerSession: number;
    blockedCommands: string[];
    requireApproval: string[];
  };
  queue: { maxConcurrentTasks: number; taskTimeoutMs: number };
  n8n: { enabled: boolean; baseUrl: string; webhookPaths: string[]; apiKey: string };
  selfHealing?: { enabled: boolean; maxAttemptsPerHour: number; cooldownMs: number; costCapPerAttempt: number; allowCodeFixes: boolean };
}

const DEFAULT_CONFIG: SetupConfig = {
  managerProvider: "claude",
  managerModel: "claude-sonnet-4-6",
  profile: {
    userName: "",
    assistantName: "PEPAGI",
    communicationStyle: "human",
    language: "cs",
    subscriptionMode: false,
    gptSubscriptionMode: false,
  },
  agents: {
    claude: { enabled: true,  apiKey: "", model: "claude-sonnet-4-6",  maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    gpt:    { enabled: false, apiKey: "", model: "gpt-4o",              maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    gemini: { enabled: false, apiKey: "", model: "gemini-2.0-flash",    maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
  },
  customProviders: {},
  platforms: {
    telegram: { enabled: false, botToken: "", allowedUserIds: [], welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." },
    whatsapp: { enabled: false, allowedNumbers: [], welcomeMessage: "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat." },
  },
  security: {
    maxCostPerTask: 1.0,
    maxCostPerSession: 10.0,
    blockedCommands: ["rm -rf /", "mkfs", "dd if=/dev/zero", "shutdown", "reboot", ":(){ :|:& };:", "sudo rm -rf", "chmod 777 /"],
    requireApproval: ["file_delete", "file_write_system", "network_external", "shell_destructive", "git_push", "docker_manage"],
  },
  queue: { maxConcurrentTasks: 4, taskTimeoutMs: 120_000 },
  n8n: { enabled: false, baseUrl: "", webhookPaths: [], apiKey: "" },
  selfHealing: { enabled: true, maxAttemptsPerHour: 3, cooldownMs: 300_000, costCapPerAttempt: 0.50, allowCodeFixes: false },
};

/** Load existing config and deep-merge with defaults (existing values win) */
async function loadExistingConfig(): Promise<SetupConfig> {
  const configPath = join(PEPAGI_DATA_DIR, "config.json");
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<SetupConfig>;
    // Deep merge: existing values take priority
    const existingCustom = (raw.customProviders ?? {}) as Record<string, CustomProviderEntry>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      profile:   { ...DEFAULT_CONFIG.profile,   ...(raw.profile   ?? {}) } as SetupConfig["profile"],
      agents:    {
        claude: { ...DEFAULT_CONFIG.agents.claude, ...(raw.agents?.claude ?? {}) },
        gpt:    { ...DEFAULT_CONFIG.agents.gpt,    ...(raw.agents?.gpt    ?? {}) },
        gemini: { ...DEFAULT_CONFIG.agents.gemini, ...(raw.agents?.gemini ?? {}) },
      },
      customProviders: existingCustom,
      platforms: {
        telegram: { ...DEFAULT_CONFIG.platforms.telegram, ...(raw.platforms?.telegram ?? {}) },
        whatsapp: { ...DEFAULT_CONFIG.platforms.whatsapp, ...(raw.platforms?.whatsapp ?? {}) },
      },
      security:  { ...DEFAULT_CONFIG.security,   ...(raw.security  ?? {}) },
      queue:     { ...DEFAULT_CONFIG.queue,       ...(raw.queue     ?? {}) },
      n8n:       { ...DEFAULT_CONFIG.n8n,         ...(raw.n8n       ?? {}) },
      selfHealing: { ...DEFAULT_CONFIG.selfHealing!, ...(raw.selfHealing ?? {}) },
    };
  } catch {
    warn("Stávající config se nepodařilo načíst — začínám s výchozími hodnotami.");
    return structuredClone(DEFAULT_CONFIG);
  }
}

// ─── Main setup ───────────────────────────────────────────────

async function setup(): Promise<void> {
  if (IS_WIN) {
    console.log(chalk.cyan(`
  ====================================
       P E P A G I  -  N E X U S
  ====================================
`));
  } else {
    console.log(chalk.cyan(`
 ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
 ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
 ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
 ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
 ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║
 ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝
`));
  }
  console.log(chalk.white.bold("  PEPAGI — Setup Wizard\n"));
  console.log(chalk.gray("  Konfigurace se ukládá do ~/.pepagi/config.json"));
  console.log(chalk.gray("  Stávající nastavení zůstane — mění se jen to co potvrdíš.\n"));

  await mkdir(PEPAGI_DATA_DIR, { recursive: true });

  // Load existing config — never blow it away
  const config = await loadExistingConfig();
  const isUpdate = existsSync(join(PEPAGI_DATA_DIR, "config.json"));
  if (isUpdate) {
    info("Nalezena stávající konfigurace — aktualizuji pouze co změníš.");
    info("");
  }

  // ─── KROK 1: Identita ──────────────────────────────────────

  header("KROK 1: Profil asistenta");
  info("Stávající nastavení:");
  current("Tvoje jméno",      config.profile.userName || "(přeskočeno)");
  current("Jméno asistenta",  config.profile.assistantName);
  current("Styl komunikace",  config.profile.communicationStyle === "human" ? "Lidský & přirozený" : "Přímý & profesionální");
  info("");

  const changeProfile = await askYesNo("  Chceš změnit profil asistenta?", !isUpdate);
  if (changeProfile) {
    const userName = await ask(`  Jak se jmenuješ? [${config.profile.userName || "přeskočit"}]: `);
    if (userName) config.profile.userName = userName;

    const assistantName = await ask(`  Jméno asistenta [${config.profile.assistantName}]: `);
    if (assistantName) config.profile.assistantName = assistantName;

    console.log(`
  Styl komunikace:
  ${chalk.cyan("[1]")} Lidský & přirozený ${chalk.green("(DOPORUČENO)")} — vřelý, s emocemi
  ${chalk.cyan("[2]")} Přímý & profesionální — jasný, stručný
    `);
    const style = await ask("  Volba [1/2, Enter = ponechat]: ");
    if (style === "1") config.profile.communicationStyle = "human";
    if (style === "2") config.profile.communicationStyle = "direct";
  }

  // ─── KROK 2: Claude ────────────────────────────────────────

  header("KROK 2: Claude (Anthropic)");

  const claudeStatus = config.profile.subscriptionMode
    ? chalk.green("OAuth předplatné (claude.ai)")
    : config.agents.claude.apiKey
      ? chalk.green("API klíč nastaven")
      : chalk.red("není nastaven");
  info(`Stav: ${claudeStatus}`);
  if (config.agents.claude.apiKey) current("Model", config.agents.claude.model);
  info("");
  info("Claude je primární AI — funguje buď přes předplatné claude.ai (OAuth, bez klíče)");
  info("nebo přes API klíč z console.anthropic.com");
  info("");

  const changeClaude = await askYesNo("  Chceš nastavit / změnit Claude?", !config.profile.subscriptionMode && !config.agents.claude.apiKey);
  if (changeClaude) {
    console.log(`
  ${chalk.cyan("[1]")} Předplatné claude.ai ${chalk.green("(DOPORUČENO)")}
       Máš claude.ai účet? Žádný klíč, žádné počítání tokenů.
       ${chalk.gray("(Vyžaduje: Claude Code CLI — claude.ai/download)")}

  ${chalk.cyan("[2]")} API klíč (sk-ant-...)
       Platíš za tokeny. Klíč z console.anthropic.com
    `);
    const choice = await ask("  Volba [1/2]: ");

    if (choice === "1" || !choice) {
      config.profile.subscriptionMode = true;
      config.agents.claude.enabled = true;
      config.agents.claude.apiKey = "";
      config.managerProvider = "claude";
      config.managerModel = config.agents.claude.model;
      success("Claude: OAuth předplatné (claude.ai)");

    } else if (choice === "2") {
      const key = await ask("  API klíč (sk-ant-...): ");
      if (key.startsWith("sk-ant-")) {
        config.agents.claude.apiKey = key;
        config.agents.claude.enabled = true;
        config.profile.subscriptionMode = false;
        config.managerProvider = "claude";
        success("Claude: API klíč uložen");
      } else {
        warn("Klíč nevypadá správně — Claude přeskočen, stávající nastavení zachováno.");
      }
    }

    if (config.agents.claude.enabled) {
      console.log(`
  Model:
  ${chalk.cyan("[1]")} claude-sonnet-4-6 ${chalk.green("(DOPORUČENO)")}  $3/$15 / 1M tokenů
  ${chalk.cyan("[2]")} claude-opus-4-6   (nejsilnější)    $5/$25 / 1M tokenů
  ${chalk.cyan("[3]")} claude-haiku-4-5  (nejrychlejší)   $0.80/$4 / 1M tokenů
      `);
      const m = await ask(`  Model [1-3, Enter = ${config.agents.claude.model}]: `);
      const modelMap: Record<string, string> = { "1": "claude-sonnet-4-6", "2": "claude-opus-4-6", "3": "claude-haiku-4-5" };
      if (modelMap[m]) {
        config.agents.claude.model = modelMap[m];
        if (config.managerProvider === "claude") config.managerModel = modelMap[m];
      }
      success(`Claude model: ${config.agents.claude.model}`);
    }
  }

  // ─── KROK 3: ChatGPT ───────────────────────────────────────

  header("KROK 3: ChatGPT / Codex (OpenAI)  — záloha při rate limitu");

  const gptStatus = config.profile.gptSubscriptionMode
    ? chalk.green("OAuth předplatné (ChatGPT Plus/Pro)")
    : config.agents.gpt.apiKey
      ? chalk.green("API klíč nastaven")
      : chalk.yellow("není nastaven (volitelné)");
  info(`Stav: ${gptStatus}`);
  info("");
  info("ChatGPT se aktivuje automaticky když Claude narazí na rate limit.");
  info("Funguje buď přes předplatné ChatGPT Plus/Pro (OAuth, bez klíče)");
  info("nebo přes API klíč z platform.openai.com");
  info("");

  const changeGPT = await askYesNo("  Chceš nastavit / změnit ChatGPT zálohu?", false);
  if (changeGPT) {
    console.log(`
  ${chalk.cyan("[1]")} Předplatné ChatGPT Plus/Pro ${chalk.green("(DOPORUČENO)")}
       Máš ChatGPT Plus/Pro? Žádný klíč.
       ${chalk.gray("(Vyžaduje: OpenAI Codex CLI — npm install -g @openai/codex)")}
       ${chalk.gray(" Po instalaci spusť jednou: codex login")}

  ${chalk.cyan("[2]")} API klíč OpenAI (sk-...)
       Platíš za tokeny. Klíč z platform.openai.com

  ${chalk.cyan("[3]")} Vypnout GPT zálohu
    `);
    const choice = await ask("  Volba [1/2/3]: ");

    if (choice === "1") {
      config.profile.gptSubscriptionMode = true;
      config.agents.gpt.enabled = true;
      config.agents.gpt.apiKey = "";
      success("ChatGPT: OAuth předplatné přes Codex CLI");
      info("Nezapomeň spustit: codex login   (jednorázové přihlášení)");

      // Check if codex is installed
      try {
        const { execSync } = await import("node:child_process");
        execSync("codex --version", { stdio: "pipe" });
        success("Codex CLI nalezen");
      } catch {
        warn("Codex CLI není nainstalován. Po setupu spusť:");
        warn("  npm install -g @openai/codex");
        warn("  codex login");
      }

    } else if (choice === "2") {
      const key = await ask("  API klíč (sk-...): ");
      if (key.startsWith("sk-")) {
        config.agents.gpt.apiKey = key;
        config.agents.gpt.enabled = true;
        config.profile.gptSubscriptionMode = false;
        success("ChatGPT: API klíč uložen");
      } else {
        warn("Klíč nevypadá správně — GPT přeskočen.");
      }
    } else if (choice === "3") {
      config.agents.gpt.enabled = false;
      config.agents.gpt.apiKey = "";
      config.profile.gptSubscriptionMode = false;
      success("GPT záloha vypnuta.");
    }

    if (config.agents.gpt.enabled) {
      console.log(`
  Model:
  ${chalk.cyan("[1]")} gpt-4o            ${chalk.green("(DOPORUČENO)")}  $2.50/$10 / 1M tokenů
  ${chalk.cyan("[2]")} gpt-4o-mini       (levnější)       $0.15/$0.60 / 1M tokenů
  ${chalk.cyan("[3]")} o4-mini           (reasoning)      $1.10/$4.40 / 1M tokenů
  ${chalk.cyan("[4]")} codex-mini-latest (coding)         $1.50/$6.00 / 1M tokenů
      `);
      const m = await ask(`  Model [1-4, Enter = ${config.agents.gpt.model}]: `);
      const modelMap: Record<string, string> = {
        "1": "gpt-4o", "2": "gpt-4o-mini", "3": "o4-mini", "4": "codex-mini-latest",
      };
      if (modelMap[m]) config.agents.gpt.model = modelMap[m];
      success(`GPT model: ${config.agents.gpt.model}`);
    }
  }

  // ─── KROK 4: Gemini ────────────────────────────────────────

  header("KROK 4: Gemini (Google)  — druhá záloha (volitelné)");

  const geminiStatus = config.agents.gemini.apiKey
    ? chalk.green("API klíč nastaven")
    : chalk.gray("není nastaven");
  info(`Stav: ${geminiStatus}`);
  info("");
  info("Zdarma tier dostupný. Klíč z aistudio.google.com/apikey");
  info("");

  const changeGemini = await askYesNo("  Chceš nastavit / změnit Gemini?", false);
  if (changeGemini) {
    const key = await ask("  API klíč (AIza...): ");
    if (key.startsWith("AIza")) {
      config.agents.gemini.apiKey = key;
      config.agents.gemini.enabled = true;
      success("Gemini: API klíč uložen");
    } else if (key === "") {
      config.agents.gemini.enabled = false;
      config.agents.gemini.apiKey = "";
      success("Gemini vypnut.");
    } else {
      warn("Klíč nevypadá správně — Gemini přeskočen.");
    }
  }

  // ─── KROK 5: Custom OpenAI-Compatible Providers ────────────

  header("KROK 5: Custom OpenAI-Compatible Providers");
  info("Deepinfra, Together, Kie.ai, OpenRouter, lokální servery...");
  info("Jakýkoliv provider s OpenAI-kompatibilním /v1/chat/completions API.");
  info("");

  // Show existing custom providers
  const customSlugs = Object.keys(config.customProviders);
  if (customSlugs.length > 0) {
    info("Existující custom provideři:");
    for (const slug of customSlugs) {
      const cp = config.customProviders[slug];
      const st = cp.enabled && cp.apiKey ? chalk.green("aktivní") : chalk.yellow("neaktivní");
      console.log(chalk.gray(`    ${slug}`) + ` — ${cp.displayName || slug} (${cp.model}) [${st}]`);
    }
    info("");
  }

  const changeCustom = await askYesNo("  Chceš přidat/upravit custom providera?", false);
  if (changeCustom) {
    let addMore = true;
    while (addMore) {
      info("");
      const slug = await ask("  Slug (lowercase, a-z, 0-9, pomlčka, např. 'deepinfra'): ");
      if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        warn("Neplatný slug — musí být lowercase alfanumerický s pomlčkami.");
      } else if (slug === "claude" || slug === "gpt" || slug === "gemini") {
        warn("Nelze použít jméno built-in providera.");
      } else {
        const existing = config.customProviders[slug];
        const displayName = await ask(`  Zobrazované jméno [${existing?.displayName || slug}]: `) || existing?.displayName || slug;
        const baseUrl = await ask(`  Base URL (např. https://api.deepinfra.com/v1) [${existing?.baseUrl || ""}]: `) || existing?.baseUrl || "";
        const apiKey = await ask(`  API klíč [${existing?.apiKey ? "***zachovat***" : ""}]: `) || existing?.apiKey || "";
        const model = await ask(`  Model (např. meta-llama/Llama-3.3-70B-Instruct) [${existing?.model || ""}]: `) || existing?.model || "";
        const cheapModel = await ask(`  Cheap model pro paměť/klasifikaci (Enter = stejný jako hlavní) [${existing?.cheapModel || ""}]: `) || existing?.cheapModel || "";

        let inputCost = existing?.inputCostPer1M ?? 0;
        let outputCost = existing?.outputCostPer1M ?? 0;
        const setCosts = await askYesNo("  Nastavit ceny za 1M tokenů? (pro cost tracking)", false);
        if (setCosts) {
          const ic = await ask(`  Input cost per 1M tokenů [$${inputCost}]: `);
          if (ic) inputCost = parseFloat(ic) || 0;
          const oc = await ask(`  Output cost per 1M tokenů [$${outputCost}]: `);
          if (oc) outputCost = parseFloat(oc) || 0;
        }

        config.customProviders[slug] = {
          ...(existing ?? {}),
          displayName,
          baseUrl,
          apiKey,
          model,
          cheapModel,
          enabled: !!(baseUrl && apiKey),
          inputCostPer1M: inputCost,
          outputCostPer1M: outputCost,
        };
        if (config.customProviders[slug].enabled) {
          success(`${displayName} (${slug}) nastaven — model: ${model}`);
        } else {
          warn(`${displayName} (${slug}) uložen ale neaktivní (chybí URL nebo klíč).`);
        }
      }
      addMore = await askYesNo("  Přidat dalšího custom providera?", false);
    }
  }

  // ─── Manager provider selection ───────────────────────────

  // Build list of all available providers
  const availableProviders: Array<{ slug: string; label: string; model: string }> = [];
  if (config.agents.claude.enabled) availableProviders.push({ slug: "claude", label: "Claude", model: config.agents.claude.model });
  if (config.agents.gpt.enabled) availableProviders.push({ slug: "gpt", label: "ChatGPT", model: config.agents.gpt.model });
  if (config.agents.gemini.enabled) availableProviders.push({ slug: "gemini", label: "Gemini", model: config.agents.gemini.model });
  for (const [slug, cp] of Object.entries(config.customProviders)) {
    if (cp.enabled) availableProviders.push({ slug, label: cp.displayName || slug, model: cp.model });
  }

  if (availableProviders.length === 0) {
    header("VAROVÁNÍ — Žádný provider není nakonfigurovaný!");
    warn("PEPAGI nemůže fungovat bez alespoň jednoho AI providera.");
    warn("Vrať se a nakonfiguruj Claude, ChatGPT, Gemini, nebo custom providera.");
    warn("Systém se uloží, ale daemon nebude schopen zpracovat žádný úkol.");
    info("");
  } else if (availableProviders.length > 1) {
    header("Hlavní Manager Provider");
    info("Který provider bude řídit systém (manager brain)?");
    info("");
    for (let i = 0; i < availableProviders.length; i++) {
      const p = availableProviders[i];
      const isCurrent = p.slug === config.managerProvider;
      const tag = isCurrent ? chalk.green(" (aktuální)") : "";
      console.log(`  ${chalk.cyan(`[${i + 1}]`)} ${p.label} (${p.model})${tag}`);
    }
    info("");
    const choice = await ask(`  Volba [1-${availableProviders.length}, Enter = ponechat ${config.managerProvider}]: `);
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < availableProviders.length) {
      const picked = availableProviders[idx];
      config.managerProvider = picked.slug;
      config.managerModel = picked.model;
      success(`Manager: ${picked.label} (${picked.model})`);
    }
  } else if (availableProviders.length === 1) {
    config.managerProvider = availableProviders[0].slug;
    config.managerModel = availableProviders[0].model;
  }

  // ─── KROK 6: Telegram ──────────────────────────────────────

  header("KROK 6: Telegram Bot (volitelné)");

  const tgStatus = config.platforms.telegram.enabled && config.platforms.telegram.botToken
    ? chalk.green("nastaven (token: " + config.platforms.telegram.botToken.slice(0, 8) + "...)")
    : chalk.gray("není nastaven");
  info(`Stav: ${tgStatus}`);
  info(IS_WIN ? "Jak vytvorit bota: Telegram -> @BotFather -> /newbot" : "Jak vytvořit bota: Telegram → @BotFather → /newbot");
  info("");

  const changeTelegram = await askYesNo("  Chceš nastavit / změnit Telegram?", !config.platforms.telegram.enabled);
  if (changeTelegram) {
    const token = await ask("  Bot token [Enter = přeskočit]: ");
    if (token.includes(":")) {
      config.platforms.telegram.botToken = token;
      config.platforms.telegram.enabled = true;
      success("Telegram token uložen");

      const restrictTG = await askYesNo("  Omezit přístup na konkrétní Telegram IDs?", true);
      if (restrictTG) {
        info("Tvoje Telegram ID zjistíš od @userinfobot");
        const idsInput = await ask("  IDs (oddělené čárkou): ");
        const ids = idsInput.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (ids.length > 0) {
          config.platforms.telegram.allowedUserIds = ids;
          success(`Přístup omezen na: ${ids.join(", ")}`);
        }
      }
    } else if (token === "" && config.platforms.telegram.botToken) {
      info("Token nezměněn.");
    }
  }

  // ─── KROK 7: WhatsApp ──────────────────────────────────────

  header("KROK 7: WhatsApp (volitelné)");

  const waStatus = config.platforms.whatsapp.enabled
    ? chalk.green("aktivován")
    : chalk.gray("není nastaven");
  info(`Stav: ${waStatus}`);
  info("Funguje přes QR kód (jako WhatsApp Web) — NEOFICIÁLNÍ klient.");
  info("");

  const changeWA = await askYesNo("  Chceš nastavit / změnit WhatsApp?", false);
  if (changeWA) {
    const enableWA = await askYesNo("  Aktivovat WhatsApp?", config.platforms.whatsapp.enabled);
    config.platforms.whatsapp.enabled = enableWA;
    if (enableWA) {
      success("WhatsApp aktivován — při prvním spuštění se zobrazí QR kód");
      const restrictWA = await askYesNo("  Omezit přístup na konkrétní čísla?", true);
      if (restrictWA) {
        const numsInput = await ask("  Čísla ve formátu 420605123456 (čárkou): ");
        const nums = numsInput.split(",").map(s => s.trim()).filter(Boolean);
        if (nums.length > 0) {
          config.platforms.whatsapp.allowedNumbers = nums;
          success(`Omezeno na: ${nums.join(", ")}`);
        }
      }
      const installNow = await askYesNo("  Nainstalovat WhatsApp závislosti teď?", true);
      if (installNow) {
        const { execSync } = await import("node:child_process");
        try {
          execSync("npm install whatsapp-web.js qrcode-terminal", { stdio: "inherit" });
          success("WhatsApp závislosti nainstalovány");
        } catch {
          warn("Instalace selhala. Spusť ručně: npm install whatsapp-web.js qrcode-terminal");
        }
      }
    }
  }

  // ─── KROK 8: n8n Integrace ─────────────────────────────────

  header("KROK 8: n8n Webhook Integrace (volitelné)");
  info("Propojení s n8n = přístup k tisícům aplikací (Slack, Notion, Shopify...)");
  info("bez psaní kódu. Stačí zadat URL tvé n8n instance.");
  info("");

  const n8nStatus = config.n8n.enabled && config.n8n.baseUrl
    ? chalk.green(`aktivní (${config.n8n.baseUrl})`)
    : chalk.gray("není nastaven");
  info(`Stav: ${n8nStatus}`);
  info("");

  const changeN8n = await askYesNo("  Chceš nastavit / změnit n8n?", false);
  if (changeN8n) {
    const baseUrl = await ask(`  n8n Base URL (např. https://n8n.example.com) [${config.n8n.baseUrl || ""}]: `) || config.n8n.baseUrl || "";
    const apiKey = await ask(`  n8n API klíč (volitelné) [${config.n8n.apiKey ? "***zachovat***" : ""}]: `) || config.n8n.apiKey || "";
    const pathsInput = await ask(`  Povolené webhook paths (čárkou, např. /webhook/abc,/webhook/xyz) [${config.n8n.webhookPaths.join(",")}]: `);
    const paths = pathsInput ? pathsInput.split(",").map(s => s.trim()).filter(Boolean) : config.n8n.webhookPaths;

    config.n8n = { enabled: !!baseUrl, baseUrl, apiKey, webhookPaths: paths };
    if (baseUrl) {
      success(`n8n nastaven: ${baseUrl} (${paths.length} webhook paths)`);
    } else {
      success("n8n vypnut.");
    }
  }

  // ─── KROK 9: Self-Healing ─────────────────────────────────

  header("KROK 9: Self-Healing (volitelné)");
  info("Autonomní diagnostika a oprava při selhání systému.");
  info("Tier 1 (infrastruktura) je bezpečný a automatický.");
  info("Tier 2 (kódové opravy) vyžaduje explicitní povolení.");
  info("");

  const shEnabled = config.selfHealing?.enabled ?? true;
  const shCodeFixes = config.selfHealing?.allowCodeFixes ?? false;
  info(`Stav: self-healing ${shEnabled ? chalk.green("zapnuto") : chalk.yellow("vypnuto")}, kódové opravy ${shCodeFixes ? chalk.green("povoleny") : chalk.gray("zakázány")}`);
  info("");

  const changeSH = await askYesNo("  Chceš změnit nastavení self-healing?", false);
  if (changeSH) {
    const enableSH = await askYesNo("  Povolit self-healing? (Tier 1 — bezpečné infra opravy)", true);
    config.selfHealing = {
      enabled: enableSH,
      maxAttemptsPerHour: 3,
      cooldownMs: 300_000,
      costCapPerAttempt: 0.50,
      allowCodeFixes: false,
    };
    if (enableSH) {
      success("Self-healing Tier 1 zapnuto");
      const enableCodeFixes = await askYesNo("  Povolit kódové opravy? (Tier 2 — na samostatném git branch, DOPORUČENO NE)", false);
      config.selfHealing.allowCodeFixes = enableCodeFixes;
      if (enableCodeFixes) {
        warn("Tier 2 kódové opravy povoleny — opravy se nikdy nemerge automaticky.");
      } else {
        success("Tier 2 kódové opravy zakázány (bezpečnější volba).");
      }
    } else {
      success("Self-healing vypnuto.");
    }
  }

  // ─── KROK 10: Google OAuth2 ──────────────────────────────

  header("KROK 10: Google OAuth2 (volitelné)");
  info("Pro Gmail, Google Calendar a Google Drive je potřeba OAuth2.");
  info("Vytvoř OAuth2 client ID na https://console.cloud.google.com/apis/credentials");
  info("Redirect URI: http://localhost:3101/callback");
  info("");

  const existingGoogle = (config as unknown as Record<string, unknown>).google as { enabled?: boolean; clientId?: string; clientSecret?: string } | undefined;
  const hasGoogle = !!(existingGoogle?.clientId && existingGoogle?.clientSecret);
  if (hasGoogle) {
    info(`Stav: Google OAuth2 ${chalk.green("nakonfigurováno")}`);
  }

  const setupGoogle = await askYesNo("  Chceš nakonfigurovat Google OAuth2?", !hasGoogle);
  if (setupGoogle) {
    const existClientId = existingGoogle?.clientId ?? process.env.GOOGLE_CLIENT_ID ?? "";
    if (existClientId) info(`  (aktuální: ${existClientId.slice(0, 20)}...)`);
    const clientId = await ask("  Google Client ID: ");
    const clientSecret = await ask("  Google Client Secret: ");
    const finalClientId = clientId || existClientId;
    const finalClientSecret = clientSecret || (existingGoogle?.clientSecret ?? "");

    if (finalClientId && finalClientSecret) {
      (config as unknown as Record<string, unknown>).google = { enabled: true, clientId: finalClientId, clientSecret: finalClientSecret };
      success("Google OAuth2 nakonfigurováno.");
      info("Při prvním použití Gmail/Drive/Calendar se otevře prohlížeč pro autorizaci.");
    } else {
      warn("Client ID nebo Secret chybí — Google OAuth2 nebude aktivní.");
      (config as unknown as Record<string, unknown>).google = { enabled: false, clientId: "", clientSecret: "" };
    }
  }

  // ─── Uložit ────────────────────────────────────────────────

  header("UKLÁDÁM KONFIGURACI");

  const configPath = join(PEPAGI_DATA_DIR, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  success(`config.json uložen: ${configPath}`);

  // Update .env — pouze přidat/přepsat klíče, zachovat ostatní řádky
  const envPath = join(process.cwd(), ".env");
  let existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "# PEPAGI — Environment\n# Generováno setupem. Můžeš editovat ručně.\n\n";

  function setEnvVar(src: string, key: string, value: string | undefined): string {
    const line = value ? `${key}=${value}` : null;
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(src)) {
      return line ? src.replace(regex, line) : src.replace(regex, `# ${key}=`);
    }
    return line ? src + line + "\n" : src;
  }

  existing = setEnvVar(existing, "ANTHROPIC_API_KEY", config.agents.claude.apiKey || undefined);
  existing = setEnvVar(existing, "OPENAI_API_KEY",    config.agents.gpt.apiKey    || undefined);
  existing = setEnvVar(existing, "GOOGLE_API_KEY",    config.agents.gemini.apiKey || undefined);
  if (config.platforms.telegram.botToken) {
    existing = setEnvVar(existing, "TELEGRAM_BOT_TOKEN",    config.platforms.telegram.botToken);
    existing = setEnvVar(existing, "TELEGRAM_ALLOWED_USERS", config.platforms.telegram.allowedUserIds.join(",") || undefined);
  }

  await writeFile(envPath, existing, "utf8");
  success(".env soubor aktualizován (ostatní řádky zachovány)");

  // ─── Souhrn ────────────────────────────────────────────────

  header("HOTOVO!");
  const ok = IS_WIN ? "[OK]" : "✓";
  const no = IS_WIN ? "[--]" : "✗";
  const arrow = IS_WIN ? "->" : "→";
  const dash = IS_WIN ? "--" : "—";
  // Build custom providers summary lines
  const customLines: string[] = [];
  for (const [slug, cp] of Object.entries(config.customProviders)) {
    if (cp.enabled) {
      const isMgr = config.managerProvider === slug;
      customLines.push(chalk.green(`  ${ok} ${cp.displayName || slug} `) + chalk.gray(`(${cp.model})`) + chalk.gray(isMgr ? ` ${dash} manager` : ` ${dash} custom`));
    } else {
      customLines.push(chalk.gray(`  ${no} ${cp.displayName || slug} (neaktivni)`));
    }
  }

  console.log(`
  ${chalk.white.bold("Aktivni providers:")}
  ${config.agents.claude.enabled ? chalk.green(`  ${ok} Claude  `) + chalk.gray(config.profile.subscriptionMode ? "(OAuth predplatne)" : "(API klic)") + chalk.gray(config.managerProvider === "claude" ? ` ${dash} manager` : ` ${dash} zaloha`) : chalk.gray(`  ${no} Claude  (vypnut)`)}
  ${config.agents.gpt.enabled    ? chalk.green(`  ${ok} ChatGPT `) + chalk.gray(config.profile.gptSubscriptionMode ? "(OAuth Codex CLI)"   : "(API klic)") + chalk.gray(config.managerProvider === "gpt" ? ` ${dash} manager` : ` ${dash} zaloha`)  : chalk.gray(`  ${no} ChatGPT (vypnut)`)}
  ${config.agents.gemini.enabled ? chalk.green(`  ${ok} Gemini  `) + chalk.gray("(API klic)") + chalk.gray(config.managerProvider === "gemini" ? ` ${dash} manager` : ` ${dash} zaloha`) : chalk.gray(`  ${no} Gemini  (vypnut)`)}${customLines.length > 0 ? "\n" + customLines.join("\n") : ""}

  ${chalk.white.bold("Prepinani pri rate limitu:")}
  ${chalk.gray(`  Pokud Claude narazi na limit ${arrow} automaticky prepne na ChatGPT / Gemini.`)}
  ${chalk.gray("  Po 60 sekundach se Claude zkusi znovu.")}

  ${chalk.white.bold("Co dal:")}
  ${chalk.cyan("  npm run daemon")}      ${dash} spustit Telegram/WhatsApp
  ${chalk.cyan("  npm run cli")}         ${dash} interaktivni terminal
  ${chalk.cyan("  npm run setup")}       ${dash} znovu spustit wizard (nic neprepise)

  ${chalk.gray("  Config:")} ${configPath}
  `);

  rl.close();
}

setup().catch(err => {
  console.error(chalk.red("Setup error:"), err);
  rl.close();
  process.exit(1);
});
