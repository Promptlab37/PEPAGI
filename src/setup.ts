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
import { homedir } from "node:os";
import chalk from "chalk";
import { PEPAGI_DATA_DIR } from "./config/loader.js";

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
  console.log("\n" + chalk.cyan("═".repeat(52)));
  console.log(chalk.cyan.bold("  " + title));
  console.log(chalk.cyan("═".repeat(52)));
}
function info(msg: string)    { console.log(chalk.gray("  " + msg)); }
function success(msg: string) { console.log(chalk.green("  ✓ " + msg)); }
function warn(msg: string)    { console.log(chalk.yellow("  ⚠ " + msg)); }
function current(label: string, value: string) {
  console.log(chalk.gray(`  ${label}: `) + chalk.cyan(value || chalk.italic("(není nastaveno)")));
}

// ─── Config type ─────────────────────────────────────────────

interface SetupConfig {
  managerProvider: "claude" | "gpt" | "gemini";
  managerModel: string;
  agents: {
    claude: { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
    gpt:    { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
    gemini: { enabled: boolean; apiKey: string; model: string; maxOutputTokens: number; temperature: number; maxAgenticTurns: number };
  };
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
};

/** Load existing config and deep-merge with defaults (existing values win) */
async function loadExistingConfig(): Promise<SetupConfig> {
  const configPath = join(PEPAGI_DATA_DIR, "config.json");
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<SetupConfig>;
    // Deep merge: existing values take priority
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      profile:   { ...DEFAULT_CONFIG.profile,   ...(raw.profile   ?? {}) } as SetupConfig["profile"],
      agents:    {
        claude: { ...DEFAULT_CONFIG.agents.claude, ...(raw.agents?.claude ?? {}) },
        gpt:    { ...DEFAULT_CONFIG.agents.gpt,    ...(raw.agents?.gpt    ?? {}) },
        gemini: { ...DEFAULT_CONFIG.agents.gemini, ...(raw.agents?.gemini ?? {}) },
      },
      platforms: {
        telegram: { ...DEFAULT_CONFIG.platforms.telegram, ...(raw.platforms?.telegram ?? {}) },
        whatsapp: { ...DEFAULT_CONFIG.platforms.whatsapp, ...(raw.platforms?.whatsapp ?? {}) },
      },
      security:  { ...DEFAULT_CONFIG.security,   ...(raw.security  ?? {}) },
      queue:     { ...DEFAULT_CONFIG.queue,       ...(raw.queue     ?? {}) },
    };
  } catch {
    warn("Stávající config se nepodařilo načíst — začínám s výchozími hodnotami.");
    return structuredClone(DEFAULT_CONFIG);
  }
}

// ─── Main setup ───────────────────────────────────────────────

async function setup(): Promise<void> {
  console.log(chalk.cyan(`
 ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
 ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
 ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
 ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
 ██║ ╚████║███████╗██╔╝ ╚██╗╚██████╔╝███████║
 ╚═╝  ╚═══╝╚══════╝╚═╝   ╚═╝ ╚═════╝ ╚══════╝
`));
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
        success("Codex CLI nalezen ✓");
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

  // ─── KROK 5: Telegram ──────────────────────────────────────

  header("KROK 5: Telegram Bot (volitelné)");

  const tgStatus = config.platforms.telegram.enabled && config.platforms.telegram.botToken
    ? chalk.green("nastaven (token: " + config.platforms.telegram.botToken.slice(0, 8) + "...)")
    : chalk.gray("není nastaven");
  info(`Stav: ${tgStatus}`);
  info("Jak vytvořit bota: Telegram → @BotFather → /newbot");
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

  // ─── KROK 6: WhatsApp ──────────────────────────────────────

  header("KROK 6: WhatsApp (volitelné)");

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

  // ─── Určit hlavního providera (managerProvider) ────────────

  // Set manager to first enabled provider
  if (config.agents.claude.enabled) {
    config.managerProvider = "claude";
    config.managerModel = config.agents.claude.model;
  } else if (config.agents.gpt.enabled) {
    config.managerProvider = "gpt";
    config.managerModel = config.agents.gpt.model;
  } else if (config.agents.gemini.enabled) {
    config.managerProvider = "gemini";
    config.managerModel = config.agents.gemini.model;
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
  console.log(`
  ${chalk.white.bold("Aktivní providers:")}
  ${config.agents.claude.enabled ? chalk.green("  ✓ Claude  ") + chalk.gray(config.profile.subscriptionMode ? "(OAuth przedplatné)" : "(API klíč)") + chalk.gray(" — primární") : chalk.gray("  ✗ Claude  (vypnut)")}
  ${config.agents.gpt.enabled    ? chalk.green("  ✓ ChatGPT ") + chalk.gray(config.profile.gptSubscriptionMode ? "(OAuth Codex CLI)"   : "(API klíč)") + chalk.gray(" — záloha")  : chalk.gray("  ✗ ChatGPT (vypnut)")}
  ${config.agents.gemini.enabled ? chalk.green("  ✓ Gemini  ") + chalk.gray("(API klíč)") + chalk.gray(" — záloha") : chalk.gray("  ✗ Gemini  (vypnut)")}

  ${chalk.white.bold("Přepínání při rate limitu:")}
  ${chalk.gray("  Pokud Claude narazí na limit → automaticky přepne na ChatGPT / Gemini.")}
  ${chalk.gray("  Po 60 sekundách se Claude zkusí znovu.")}

  ${chalk.white.bold("Co dál:")}
  ${chalk.cyan("  npm run daemon")}      — spustit Telegram/WhatsApp
  ${chalk.cyan("  npm run cli")}         — interaktivní terminál
  ${chalk.cyan("  npm run setup")}       — znovu spustit wizard (nic nepřepíše)

  ${chalk.gray("  Config:")} ${configPath}
  `);

  rl.close();
}

setup().catch(err => {
  console.error(chalk.red("Setup error:"), err);
  rl.close();
  process.exit(1);
});
