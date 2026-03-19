<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-green?logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/tests-683%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/security-35%20categories-orange" alt="Security" />
  <img src="https://img.shields.io/badge/version-0.5.0-purple" alt="Version" />
</p>

# PEPAGI

**Neuro-Evolutionary eXecution & Unified Synthesis**

AGI-like multi-agent orchestracni platforma — chatuj pres terminal, Telegram, Discord nebo WhatsApp.

> [English documentation](README.md)

---

## Co to je

PEPAGI je pokrocily AI asistent, ktery:
- **Rozklada slozite ulohy** na subtasky a resi je iterativne
- **Pouziva vice AI modelu** — Claude, GPT, Gemini, Ollama (automaticky vybere nejlepsi)
- **Pamatuje si** predchozi konverzace a naucene postupy (5 urovni pameti)
- **Komunikuje pres Telegram, Discord nebo WhatsApp** jako bezny chatbot
- **Spousti kod, cte soubory, prohledava web** (agentic mode)
- **Hleda na webu** pres DuckDuckGo (bez API klice)
- **Ma vedomi** — 11D qualia vektor, vnitrni monolog, sebemodel

---

## Rychly start

### Mac / Linux

```bash
git clone https://github.com/AiTaskForce/pepagi.git
cd pepagi
./install.sh
```

### Windows

```
Dvojklik na install.bat
```

Instalator:
1. Zkontroluje Node.js 22+
2. Nainstaluje zavislosti
3. Spusti pruvodce nastavenim (AI provider + Telegram/WhatsApp)

### Manualni instalace

```bash
git clone https://github.com/AiTaskForce/pepagi.git
cd pepagi
npm install
npm run setup    # Pruvodce nastavenim
```

---

## AI Provideri

Potrebujes aspon jednoho nakonfigurovaneho. Spust `npm run setup` nebo edituj `.env`.

### Claude (Anthropic) — Doporuceno

**Moznost 1: Bez API klice — Claude Code CLI OAuth**
```bash
npm install -g @anthropic-ai/claude-code
claude login
```
PEPAGI automaticky pouzije OAuth — nepotrebujes API klic.

**Moznost 2: API klic**
```
ANTHROPIC_API_KEY=sk-ant-...
```
Z [console.anthropic.com](https://console.anthropic.com)

### GPT (OpenAI) — volitelne
```
OPENAI_API_KEY=sk-...
```
Z [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### Gemini (Google) — volitelne, ma zdarma tier
```
GOOGLE_API_KEY=AIza...
```
Z [aistudio.google.com](https://aistudio.google.com/apikey)

### Ollama — volitelne, lokalni modely, zdarma
```bash
brew install ollama
ollama pull llama3.2
```

---

## Nastaveni Telegram bota

1. Telegram → [@BotFather](https://t.me/BotFather) → `/newbot` → zkopiruj token
2. Pridej do `.env`: `TELEGRAM_BOT_TOKEN=tvuj_token`
3. (Volitelne) Omez pristup: zjisti sve ID od [@userinfobot](https://t.me/userinfobot), nastav `TELEGRAM_ALLOWED_USERS=tve_id`
4. Spust `npm run daemon`
5. Najdi sveho bota v Telegramu a pis!

---

## Nastaveni Discord bota

1. Vytvor aplikaci na [discord.com/developers](https://discord.com/developers/applications)
2. Vytvor bota, zkopiruj token do `.env`: `DISCORD_BOT_TOKEN=tvuj_token`
3. Pozvi bota na server s Message Content intentem
4. Spust `npm run daemon`

---

## WhatsApp

```bash
npm install whatsapp-web.js qrcode-terminal
# V ~/.pepagi/config.json nastav: platforms.whatsapp.enabled = true
npm run daemon   # zobrazi QR kod
```
Skenuj QR kod (WhatsApp → Propojena zarizeni → Pridat zarizeni).

> Neoficialni klient — pouzivej zodpovedne.

---

## Prikazy

```bash
npm start                            # interaktivni chat v terminalu
npm start -- "tva uloha"             # jedna uloha
npm run daemon                       # Telegram + Discord + WhatsApp daemon
npm run setup                        # pruvodce nastavenim
npm run tui                          # TUI dashboard
```

**Mac / Linux — daemon na pozadi:**
```bash
npm run daemon:bg                    # spustit na pozadi
npm run daemon:stop                  # zastavit
npm run daemon:logs                  # sledovat logy
```

**Windows — daemon na pozadi:**
```bash
npm run daemon:win                   # spustit na pozadi
```

**Prikazy v interaktivnim modu:**
```
status    — stav systemu a agentu
history   — poslednich 10 uloh
memory    — statistiky pameti
cost      — utrata za session
help      — napoveda
quit      — konec
```

---

## Promenne prostredi

| Promenna | Popis |
|----------|-------|
| `ANTHROPIC_API_KEY` | Claude API klic (nebo pouzij CLI OAuth) |
| `OPENAI_API_KEY` | GPT API klic (volitelne) |
| `GOOGLE_API_KEY` | Gemini API klic (volitelne) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token od @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Povolena Telegram user ID (carkou oddelena) |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `OLLAMA_BASE_URL` | Ollama endpoint (default: `http://localhost:11434`) |
| `PEPAGI_DATA_DIR` | Umisteni dat (default: `~/.pepagi`) |
| `PEPAGI_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

---

## Konfigurace

`~/.pepagi/config.json` (vytvori `npm run setup`):
```json
{
  "managerProvider": "claude",
  "agents": {
    "claude": { "enabled": true, "apiKey": "" },
    "gpt": { "enabled": false, "apiKey": "" },
    "gemini": { "enabled": false, "apiKey": "" },
    "ollama": { "enabled": false, "model": "ollama/llama3.2" }
  },
  "platforms": {
    "telegram": { "enabled": true, "botToken": "..." },
    "discord": { "enabled": false, "botToken": "" },
    "whatsapp": { "enabled": false }
  },
  "security": {
    "maxCostPerTask": 1.0,
    "maxCostPerSession": 10.0
  },
  "consciousness": {
    "enabled": true,
    "profile": "STANDARD"
  }
}
```

### Profily vedomi

| Profil | Vnitrni monolog | Geneticka evoluce | Qualia |
|--------|----------------|-------------------|--------|
| `MINIMAL` | Ne | Ne | zakladni |
| `STANDARD` | Ano | Ne | plne |
| `RICH` | Ano | Ano | plne |
| `RESEARCHER` | Ano | Ano | plne + raw log |
| `SAFE-MODE` | Ne | Ne | vypnute |

---

## Architektura

```
pepagi/
├── src/
│   ├── cli.ts                   # CLI rozhrani
│   ├── daemon.ts                # Daemon mod (platformy na pozadi)
│   ├── setup.ts                 # Pruvodce nastavenim
│   ├── platforms/               # Telegram, Discord, WhatsApp, iMessage
│   ├── core/                    # Mediator, Planner, TaskStore, EventBus
│   ├── agents/                  # LLM provideri (Claude/GPT/Gemini/Ollama)
│   ├── memory/                  # 5-urovnova kognitivni pamet
│   ├── meta/                    # Metakognice, Watchdog, WorldModel
│   ├── consciousness/           # Vedomi (qualia, sebemodel, monolog)
│   ├── config/                  # Konfigurace
│   ├── tools/                   # Nastroje (bash, web_search, browser, ...)
│   ├── security/                # 35-kategoriova bezpecnostni vrstva
│   ├── skills/                  # Dynamicky registr dovednosti
│   ├── mcp/                     # MCP server (port 3099)
│   └── ui/                      # TUI dashboard (blessed)
├── install.sh                   # Mac/Linux instalator
└── install.bat                  # Windows instalator
```

---

## Data

`~/.pepagi/` — veskerou data, pamet a logy:
```
~/.pepagi/
├── config.json                  # konfigurace
├── tasks.json                   # aktivni ulohy
├── goals.json                   # planovane cile
├── memory/
│   ├── episodes.jsonl           # probehle ulohy
│   ├── knowledge.jsonl          # naucena fakta
│   ├── procedures.jsonl         # naucene postupy
│   └── reflections.jsonl        # reflexe po ulohach
├── skills/                      # distillovane dovednosti
├── logs/                        # strukturovane logy
└── audit.jsonl                  # auditni stopa (SHA-256)
```

---

## Docker

```bash
docker compose up -d
```

---

## Technologie

| Vrstva | Technologie |
|--------|-------------|
| Runtime | Node.js 22, TypeScript (strict), ESM |
| AI | Claude, GPT, Gemini, Ollama, LM Studio |
| Telegram | Telegraf 4 |
| Discord | discord.js 14 |
| WhatsApp | whatsapp-web.js (neoficialni) |
| Pamet | JSONL + TF-IDF vector search |
| Validace | Zod |
| Bezpecnost | 35 kategorii, OWASP/MITRE/NIST |

---

## Pozadavky

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- Pro Claude bez API klice: [Claude Code CLI](https://claude.ai/download)
- Pro WhatsApp: `npm install whatsapp-web.js qrcode-terminal`
- Pro browser tool: `npx playwright install chromium`

---

## Licence

MIT License. Viz [LICENSE](LICENSE).

---

<p align="center">
  <strong>Josef Taric - Promptlab</strong>
</p>
