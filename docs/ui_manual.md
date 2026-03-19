# PEPAGI User Manual

A step-by-step guide for installing and using PEPAGI — your AI assistant that coordinates multiple AI models to solve tasks.

---

## Table of Contents

1. [What is PEPAGI?](#what-is-pepagi)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Setting Up API Keys](#setting-up-api-keys)
5. [First Run](#first-run)
6. [Using the CLI (Interactive Chat)](#using-the-cli-interactive-chat)
7. [Using the TUI Dashboard](#using-the-tui-dashboard)
8. [Telegram Bot Setup](#telegram-bot-setup)
9. [Discord Bot Setup](#discord-bot-setup)
10. [Running as a Background Service (Daemon)](#running-as-a-background-service-daemon)
11. [Everyday Examples](#everyday-examples)
12. [Tips and Best Practices](#tips-and-best-practices)
13. [Troubleshooting](#troubleshooting)
14. [Glossary](#glossary)

---

## What is PEPAGI?

PEPAGI is an AI assistant that works like a team of AI experts. Instead of talking to one AI model, PEPAGI uses a "brain" (called the Mediator) that decides which AI model is best for each part of your task. It can:

- Break complex tasks into smaller steps
- Pick the cheapest AI model that can handle each step
- Remember what worked in the past and learn from mistakes
- Run on Telegram, WhatsApp, Discord, or your terminal

You talk to PEPAGI in natural language, just like chatting with a friend.

---

## Prerequisites

Before installing PEPAGI, you need:

| Software | Version | Download Link |
|----------|---------|---------------|
| **Node.js** | 22 or newer | [nodejs.org/en/download](https://nodejs.org/en/download) |
| **npm** | Comes with Node.js | Installed automatically with Node.js |
| **Git** | Any recent version | [git-scm.com/downloads](https://git-scm.com/downloads) |

### How to check if you have them

Open your terminal (Terminal on Mac, Command Prompt or PowerShell on Windows) and type:

```bash
node --version
# Should show v22.x.x or higher

npm --version
# Should show 10.x.x or higher

git --version
# Should show git version 2.x.x
```

If any of these commands fail, install the missing software from the links above.

---

## Installation

### Step 1: Download the project

```bash
git clone https://github.com/user/pepagi.git
cd pepagi
```

### Step 2: Install dependencies

```bash
npm install
```

This will download all required packages. It may take 1-2 minutes.

### Step 3: Run the setup wizard

```bash
npm run setup
```

The wizard will ask you a series of questions:
1. **Your name** — how the assistant should address you
2. **Assistant name** — what to call the AI (default: "PEPAGI")
3. **Communication style** — friendly or professional
4. **API keys** — for the AI models you want to use (see next section)
5. **Platform tokens** — for Telegram, Discord, etc.

All settings are saved to `~/.pepagi/config.json`. You can re-run `npm run setup` anytime to change them.

---

## Setting Up API Keys

You need at least one AI provider. Claude (Anthropic) is recommended as the primary brain.

### Anthropic (Claude) — Recommended

**Option A: Claude.ai subscription (no API key needed)**
1. Go to [claude.ai](https://claude.ai) and sign up for a Pro or Team subscription
2. Download Claude Code CLI from [claude.ai/download](https://claude.ai/download)
3. In the setup wizard, choose option `[1] Subscription (claude.ai)`
4. Done — PEPAGI will use your Claude subscription via OAuth

**Option B: API key**
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Click **"API Keys"** in the left sidebar
3. Click **"Create Key"**
4. Copy the key (starts with `sk-ant-api03-...`)
5. In the setup wizard, choose option `[2] API key` and paste it

### OpenAI (GPT) — Optional

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click **"Create new secret key"**
3. Copy the key (starts with `sk-...`)
4. In the setup wizard, paste it when asked for the OpenAI key

### Google (Gemini) — Optional

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click **"Create API Key"**
3. Copy the key
4. In the setup wizard, paste it when asked for the Google AI key

### Ollama (Local models) — Optional, Free

1. Download Ollama from [ollama.com/download](https://ollama.com/download)
2. Install and start it
3. Pull a model: `ollama pull llama3.2`
4. PEPAGI will automatically detect Ollama running on `localhost:11434`

---

## First Run

After setup, try your first task:

```bash
npm start
```

This opens the interactive chat. Type a task:

```
> Write a Python function that checks if a number is prime
```

PEPAGI will:
1. Analyze the task difficulty
2. Pick the best AI model for the job
3. Generate the code
4. Verify the result
5. Show you the answer

Type `exit` to leave the chat.

### Running a single task (non-interactive)

```bash
npx pepagi "Explain quantum computing in simple terms"
```

---

## Using the CLI (Interactive Chat)

Start the chat:

```bash
npm start
```

### Available commands

| Command | What it does |
|---------|-------------|
| `help` | Show all available commands |
| `status` | Show task statistics (completed, failed, running) |
| `history` | Show recently completed tasks |
| `memory` | Show memory system statistics |
| `cost` | Show cost breakdown by AI model |
| `logs` | Show last 30 lines of the system log |
| `proposals` | Show architecture improvement suggestions |
| `consciousness status` | Show the AI's current emotional state |
| `consciousness thoughts` | Show recent inner monologue |
| `consciousness narrative` | Show the AI's self-identity |
| `consciousness pause` | Pause the consciousness system |
| `consciousness resume` | Resume the consciousness system |
| `exit` | Quit the chat |

### Daemon management from CLI

| Command | What it does |
|---------|-------------|
| `pepagi daemon status` | Check if the background service is running |
| `pepagi daemon start` | Start the background service |
| `pepagi daemon stop` | Stop the background service |
| `pepagi daemon restart` | Restart the background service |
| `pepagi daemon install` | Install as a system service (auto-start on boot) |
| `pepagi daemon uninstall` | Remove the system service |

---

## Using the TUI Dashboard

PEPAGI includes a terminal-based graphical dashboard:

```bash
npm run tui
```

The dashboard shows:
- **Task list** — all active and recent tasks with their status
- **Agent activity** — which AI models are currently working
- **Memory stats** — how many facts, episodes, and procedures are stored
- **Cost tracker** — real-time spending by provider
- **Event log** — live stream of system events
- **Consciousness panel** — current qualia vector and thoughts

Navigate with arrow keys and Tab. Press `q` to quit.

---

## Telegram Bot Setup

### Step 1: Create a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send the command `/newbot`
3. Choose a name for your bot (e.g., "My PEPAGI")
4. Choose a username (must end in `bot`, e.g., `my_pepagi_bot`)
5. BotFather will give you a **bot token** — copy it (looks like `7123456789:AAH...`)

### Step 2: Get your Telegram user ID

1. Open Telegram and search for **@userinfobot**
2. Start a chat with it
3. It will reply with your **user ID** (a number like `123456789`)

### Step 3: Configure in PEPAGI

Run `npm run setup` and when asked about Telegram:
- Paste the **bot token**
- Enter your **user ID** (this restricts the bot to only respond to you)

### Step 4: Start the daemon

```bash
npm run daemon
```

Now open Telegram, find your bot, and send `/start`. You can send:
- Text messages — PEPAGI will process them as tasks
- Voice messages — automatically transcribed and processed
- Photos — analyzed with AI vision
- Documents (.txt, .docx) — content extracted and processed

### Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Reset conversation |
| `/status` | Show task statistics |
| `/clear` | Clear conversation history |
| `/goals` | List scheduled goals |
| `/memory` | Show memory statistics |
| `/skills` | List loaded skills |
| `/tts <text>` | Reply with voice message (macOS) |

---

## Discord Bot Setup

### Step 1: Create a Discord application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"**, give it a name
3. Go to the **"Bot"** section in the left sidebar
4. Click **"Reset Token"** and copy the token
5. Under **"Privileged Gateway Intents"**, enable:
   - **Message Content Intent**
   - **Server Members Intent** (optional)

### Step 2: Invite the bot to your server

1. Go to **"OAuth2" > "URL Generator"** in the left sidebar
2. Under **Scopes**, check `bot`
3. Under **Bot Permissions**, check:
   - `Send Messages`
   - `Read Message History`
   - `View Channels`
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

### Step 3: Configure in PEPAGI

Run `npm run setup` and when asked about Discord:
- Paste the **bot token**
- Enter your **Discord user ID** (right-click your name in Discord > "Copy User ID"; enable Developer Mode in Settings > Advanced if you don't see this option)
- Optionally set allowed channel IDs

### Step 4: Start the daemon

```bash
npm run daemon
```

The bot will appear online in your Discord server. Send messages with the command prefix (default `!`), e.g., `!help`, or just send a message to start a task.

---

## Running as a Background Service (Daemon)

The daemon keeps PEPAGI running continuously, serving all configured platforms.

### Start manually

```bash
npm run daemon
```

This runs in the foreground. Press `Ctrl+C` to stop.

### Start in background

```bash
npx pepagi daemon start
```

### Check status

```bash
npx pepagi daemon status
```

### View logs

```bash
npx pepagi daemon logs
# Or directly:
tail -f ~/.pepagi/logs/daemon.log
```

### Install as a system service

This makes PEPAGI start automatically when you log in:

```bash
npx pepagi daemon install
```

- **macOS**: Creates a LaunchAgent
- **Linux**: Creates a systemd user service
- **Windows**: Creates a Scheduled Task

To remove:

```bash
npx pepagi daemon uninstall
```

---

## Everyday Examples

### Ask a question
```
> What is the difference between REST and GraphQL?
```

### Write code
```
> Write a Node.js script that downloads all images from a webpage
```

### Analyze a document (Telegram)
Send a .docx or .txt file with the caption: "Summarize this document"

### Voice message (Telegram)
Record a voice message — PEPAGI will transcribe it and respond

### Multi-step task
```
> Research the top 5 JavaScript frameworks in 2026, compare their bundle sizes,
> and recommend the best one for a small SPA project
```
PEPAGI will decompose this into subtasks, research each one, and synthesize a final answer.

### Schedule recurring tasks
Edit `~/.pepagi/goals.json` to add scheduled tasks:
```json
[
  {
    "name": "Daily News",
    "description": "Fetch and summarize tech news",
    "prompt": "Find the top 3 tech news stories from today and summarize them",
    "schedule": "0 8 * * *",
    "enabled": true
  }
]
```
Enable via Telegram: `/goals enable Daily News`

---

## Tips and Best Practices

1. **Be specific** — "Write a Python function that validates email addresses using regex" works better than "write some code"
2. **Start with Claude** — it's the best manager brain. Add GPT/Gemini later for cost savings on simple tasks
3. **Check costs** — use `cost` command in CLI or monitor via the TUI dashboard
4. **Use Ollama for privacy** — sensitive tasks can be routed to local models with zero cloud exposure
5. **Review goals** — scheduled goals run automatically; disable ones you don't need with `/goals disable <name>`
6. **Memory grows over time** — PEPAGI learns your preferences and past results, becoming more accurate
7. **Daemon mode for Telegram** — install as a system service so your bot is always available

---

## Troubleshooting

### "ANTHROPIC_API_KEY not set" or "No API keys configured"

**Problem**: PEPAGI cannot find any AI provider credentials.

**Fix**: Run `npm run setup` and configure at least one provider (Claude recommended). Or set the environment variable directly:
```bash
export ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

### "Error: Cannot find module 'whatsapp-web.js'"

**Problem**: WhatsApp support requires optional dependencies.

**Fix**: Install them:
```bash
npm install whatsapp-web.js qrcode-terminal
```

### "Daemon: dead (PID 12345 does not respond)"

**Problem**: The daemon process crashed or was killed.

**Fix**:
```bash
npx pepagi daemon stop    # Clean up stale PID file
npx pepagi daemon start   # Start fresh
tail -f ~/.pepagi/logs/daemon.log   # Check what went wrong
```

### "SEC-13: Daily cost limit exceeded"

**Problem**: You've hit the daily spending limit (default $5/day per user).

**Fix**: Wait until tomorrow (limits reset daily), or increase the limit in `~/.pepagi/config.json`:
```json
{
  "security": {
    "costLimits": {
      "perTaskDollar": 2.0,
      "perSessionDollar": 10.0
    }
  }
}
```

### "Rate limited (429 Too Many Requests)"

**Problem**: You're sending too many requests to an AI provider.

**Fix**: Wait 30-60 seconds and try again. PEPAGI has built-in retry with backoff, but sustained high-volume usage can still trigger provider rate limits.

### Telegram bot not responding

**Problem**: The bot appears online but doesn't reply.

**Fix**:
1. Make sure your user ID is in the allowed list — check `~/.pepagi/config.json` under `platforms.telegram.allowedUserIds`
2. Make sure the daemon is running: `npx pepagi daemon status`
3. Check logs: `tail -f ~/.pepagi/logs/daemon.log`
4. Verify the bot token is correct by visiting `https://api.telegram.org/bot<YOUR_TOKEN>/getMe` in a browser

### "Build failed" after update

**Problem**: TypeScript compilation errors after pulling new code.

**Fix**:
```bash
rm -rf node_modules dist
npm install
npm run build
```

---

## Glossary

| Term | Meaning |
|------|---------|
| **Agent** | An AI model (like Claude, GPT, or Gemini) that PEPAGI can use to solve tasks |
| **Mediator** | The central "brain" of PEPAGI that decides which agent to use and how to decompose tasks |
| **Task** | A unit of work — your request gets turned into one or more tasks |
| **Subtask** | A smaller part of a complex task, handled by a specific agent |
| **Daemon** | A background process that keeps PEPAGI running continuously |
| **Memory** | PEPAGI's long-term storage — it remembers past tasks, facts, and procedures |
| **Skill** | A reusable procedure that PEPAGI has learned from repeated successful tasks |
| **Swarm Mode** | When PEPAGI sends the same problem to multiple agents and combines their answers |
| **World Model** | PEPAGI's ability to simulate and predict outcomes before executing |
| **Qualia** | The AI's internal emotional state (curiosity, satisfaction, frustration, etc.) |
| **MCP** | Model Context Protocol — allows Claude.ai to use PEPAGI as a tool |
| **TUI** | Terminal User Interface — a graphical dashboard in your terminal |
| **Ollama** | Software for running AI models locally on your computer |
| **OAuth** | A login method that lets PEPAGI use your Claude subscription without an API key |
| **PKCE** | A security protocol used when connecting to AI providers |
| **Tripwire** | A security feature that detects if an AI tries to access fake sensitive files |
