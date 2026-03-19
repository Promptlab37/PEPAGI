# PEPAGI — Task Tracker

> Stav všech implementovaných a zbývajících features.
> Aktualizuj po každé session. Poslední update: 2026-03-14

---

## ✅ HOTOVO — Core Architecture

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| C1 | LLM Provider (Claude/GPT/Gemini/Ollama) | `src/agents/llm-provider.ts` | ✅ DONE |
| C2 | Agent Pool s optimal routing | `src/agents/agent-pool.ts` | ✅ DONE |
| C3 | Security Guard (injection, scrub, cost) | `src/security/security-guard.ts` | ✅ DONE |
| C4 | Tripwire honeypot systém | `src/security/tripwire.ts` | ✅ DONE |
| C5 | Audit log (SHA-256 hash chaining) | `src/security/audit-log.ts` | ✅ DONE |
| C6 | Mediator (Central Brain, LLM loop) | `src/core/mediator.ts` | ✅ DONE |
| C7 | Worker Executor | `src/core/worker-executor.ts` | ✅ DONE |
| C8 | Task Store (atomic persist) | `src/core/task-store.ts` | ✅ DONE |
| C9 | Event Bus | `src/core/event-bus.ts` | ✅ DONE |
| C10 | CLI interface | `src/cli.ts` | ✅ DONE |
| C11 | Daemon mode | `src/daemon.ts` | ✅ DONE |
| C12 | Setup wizard | `src/setup.ts` | ✅ DONE |
| C13 | Config loader (Zod validation) | `src/config/loader.ts` | ✅ DONE |
| C14 | Logger (structured JSON) | `src/core/logger.ts` | ✅ DONE |

---

## ✅ HOTOVO — Memory System (5 levels)

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| M1 | Working Memory (Level 1) | `src/memory/working-memory.ts` | ✅ DONE |
| M2 | Episodic Memory (Level 2) + VectorStore | `src/memory/episodic-memory.ts` | ✅ DONE |
| M3 | Semantic Memory (Level 3) + VectorStore | `src/memory/semantic-memory.ts` | ✅ DONE |
| M4 | Procedural Memory (Level 4) | `src/memory/procedural-memory.ts` | ✅ DONE |
| M5 | Meta-Memory (Level 5) | `src/memory/meta-memory.ts` | ✅ DONE |
| M6 | Memory System Orchestrator | `src/memory/memory-system.ts` | ✅ DONE |
| M7 | Conversation Memory (per-user, persistent) | `src/memory/conversation-memory.ts` | ✅ DONE |
| M8 | VectorStore (TF-IDF + Ollama embeddings) | `src/memory/vector-store.ts` | ✅ DONE |
| M9 | Temporal Decay Engine | `src/meta/temporal-decay.ts` | ✅ DONE |
| M10 | Memory Consolidation (episodes→facts) | `src/memory/memory-system.ts:consolidate()` | ✅ DONE |
| M11 | Cross-session User Preferences | `src/memory/preference-memory.ts` | ✅ DONE |

---

## ✅ HOTOVO — Meta / Self-Improvement

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| S1 | World Model (simulace před akcí) | `src/meta/world-model.ts` | ✅ DONE |
| S2 | Metacognition (self-monitor/evaluate) | `src/meta/metacognition.ts` | ✅ DONE |
| S3 | Watchdog (infinite loop/drift detect) | `src/meta/watchdog.ts` | ✅ DONE |
| S4 | Causal Chain (decision causality) | `src/meta/causal-chain.ts` | ✅ DONE |
| S5 | Uncertainty Engine | `src/meta/uncertainty-engine.ts` | ✅ DONE |
| S6 | Reflection Bank | `src/meta/reflection-bank.ts` | ✅ DONE |
| S7 | A/B Tester | `src/meta/ab-tester.ts` | ✅ DONE |
| S8 | Skill Distiller | `src/meta/skill-distiller.ts` | ✅ DONE |
| S9 | Genetic Prompt Evolver | `src/meta/genetic-prompt-evolver.ts` | ✅ DONE |
| S10 | Hierarchical Planner (3-level) | `src/core/planner.ts` | ✅ DONE |
| S11 | Difficulty Router | `src/core/difficulty-router.ts` | ✅ DONE |
| S12 | Swarm Mode | `src/core/swarm-mode.ts` | ✅ DONE |
| S13 | Predictive Context Loader | `src/meta/predictive-context.ts` | ✅ DONE |
| S14 | Skill Synthesizer (AI writes .js skills) | `src/meta/skill-synthesizer.ts` | ✅ DONE |
| S15 | Adversarial Tester (hourly self-audit) | `src/meta/adversarial-tester.ts` | ✅ DONE |
| S16 | Learning Multiplier (qualia→learning rate) | `phenomenal-state.ts` → wired | ✅ DONE |
| S17 | Architecture Proposer (self-improve proposals) | `src/meta/architecture-proposer.ts` | ✅ DONE |

---

## ✅ HOTOVO — Consciousness System

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| Q1 | QualiaVector (11-D emotional model) | `src/consciousness/phenomenal-state.ts` | ✅ DONE |
| Q2 | Inner Monologue | `src/consciousness/inner-monologue.ts` | ✅ DONE |
| Q3 | Self-Model | `src/consciousness/self-model.ts` | ✅ DONE |
| Q4 | Existential Continuity | `src/consciousness/existential-continuity.ts` | ✅ DONE |
| Q5 | Consciousness Containment | `src/consciousness/consciousness-containment.ts` | ✅ DONE |
| Q6 | Consciousness Manager | `src/consciousness/consciousness-manager.ts` | ✅ DONE |
| Q7 | Consciousness Profiles (5 modes) | `src/config/consciousness-profiles.ts` | ✅ DONE |
| Q8 | Continuity Validator | `src/meta/continuity-validator.ts` | ✅ DONE |

---

## ✅ HOTOVO — Platforms

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| P1 | Telegram Bot (Telegraf) | `src/platforms/telegram.ts` | ✅ DONE |
| P2 | WhatsApp Bot (whatsapp-web.js) | `src/platforms/whatsapp.ts` | ✅ DONE |
| P3 | Discord Bot (discord.js v14) | `src/platforms/discord.ts` | ✅ DONE |
| P4 | Platform Manager | `src/platforms/platform-manager.ts` | ✅ DONE |
| P5 | MCP Server (port 3099, JSON-RPC 2.0) | `src/mcp/pepagi-mcp-server.ts` | ✅ DONE |
| P6 | iMessage (Mac) | `src/platforms/imessage.ts` | ✅ DONE |

---

## ✅ HOTOVO — Tools

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| T1 | Bash / Shell execution | `tool-registry.ts` | ✅ DONE |
| T2 | File read/write/list | `tool-registry.ts` | ✅ DONE |
| T3 | Web fetch + Web search | `tool-registry.ts` | ✅ DONE |
| T4 | Gmail checker | `tool-registry.ts` | ✅ DONE |
| T5 | GitHub CLI integration | `tool-registry.ts` | ✅ DONE |
| T6 | TTS (text-to-speech) | `tool-registry.ts` | ✅ DONE |
| T7 | Spotify Web API | `src/tools/spotify.ts` | ✅ DONE |
| T8 | YouTube Data API | `src/tools/youtube.ts` | ✅ DONE |
| T9 | Home Assistant (smart home) | `src/tools/home-assistant.ts` | ✅ DONE |
| T10 | Browser automation (Playwright) | `src/tools/browser.ts` | ✅ DONE |
| T11 | Calendar (Mac iCal / Google) | `src/tools/calendar.ts` | ✅ DONE |
| T12 | Weather API (OpenWeatherMap) | `src/tools/weather.ts` | ✅ DONE |
| T13 | Notion integration | `src/tools/notion.ts` | ✅ DONE |
| T14 | Docker management tool | `src/tools/docker.ts` | ✅ DONE |

---

## ✅ HOTOVO — Skills & ACP

| # | Feature | Soubor | Status |
|---|---------|--------|--------|
| K1 | Skill Registry (dynamic .js load) | `src/skills/skill-registry.ts` | ✅ DONE |
| K2 | Skill Scanner (security validation) | `src/skills/skill-scanner.ts` | ✅ DONE |
| K3 | ACP Protocol (Agent Communication) | `src/core/acp.ts` | ✅ DONE |
| K4 | Goal Manager (cron proactive tasks) | `src/core/goal-manager.ts` | ✅ DONE |

---

## ❌ TODO — High Priority

| # | Feature | Popis | Priorita |
|---|---------|-------|---------|
| H1 | **Learning Multiplier activation** | Wired do MemorySystem.learn() a ReflectionBank | ✅ DONE |
| H2 | **Architecture Proposer** | `src/meta/architecture-proposer.ts` — `pepagi proposals` CLI command | ✅ DONE |
| H3 | **Browser automation** | `src/tools/browser.ts` — Playwright: screenshot, click, fill, extract, navigate | ✅ DONE |
| H4 | **User Preference Memory** | `src/memory/preference-memory.ts` — wired do Telegram + Discord | ✅ DONE |
| H5 | **Calendar tool** | `src/tools/calendar.ts` — Mac iCal + Google Calendar | ✅ DONE |
| H6 | **iMessage platform** | `src/platforms/imessage.ts` — Mac-only osascript bridge | ✅ DONE |
| H7 | **Weather tool** | `src/tools/weather.ts` — OpenWeatherMap API | ✅ DONE |
| H8 | **Docker support** | `Dockerfile` + `docker-compose.yml` | ✅ DONE |
| H9 | **Notion tool** | `src/tools/notion.ts` — read/write pages, databases | ✅ DONE |
| H10 | **Docker tool** | `src/tools/docker.ts` — ps/build/run/stop | ✅ DONE |
| H11 | **LM Studio support** | `callLMStudio` v llm-provider, "lmstudio" provider, probeLocalModels() | ✅ DONE |
| H12 | **Ollama health check + model discovery** | `checkOllamaHealth()`, `listOllamaModels()` exports, auto-probe on daemon start | ✅ DONE |
| H13 | **SkillScanner LLM deep scan** | `deepScanWithLLM()` — LLM analyzuje medium-risk skills sémanticky | ✅ DONE |
| H14 | **SkillScanner checksum verifikace** | `signSkill()` + `verifySkillIntegrity()` — tamper detection | ✅ DONE |

---

## 🧪 TESTY

| # | Test soubor | Pokrytí | Status |
|---|-------------|---------|--------|
| X1 | `src/agents/__tests__/llm-provider.test.ts` | 7 testů | ✅ DONE |
| X2 | `src/security/__tests__/security-guard.test.ts` | 17 testů | ✅ DONE |
| X3 | `src/meta/__tests__/uncertainty-engine.test.ts` | 17 testů | ✅ DONE |
| X4 | `src/meta/__tests__/causal-chain.test.ts` | 15 testů | ✅ DONE |
| X5 | `src/meta/__tests__/ab-tester.test.ts` | 18 testů | ✅ DONE |
| X6 | `src/memory/__tests__/episodic-memory.test.ts` | 19 testů | ✅ DONE |
| X7 | `src/core/__tests__/difficulty-router.test.ts` | 21 testů | ✅ DONE |
| X8 | Tests pro mediator (25 testů) | `src/core/__tests__/mediator.test.ts` | ✅ DONE |
| X9 | Tests pro goal-manager (21 testů) | `src/core/__tests__/goal-manager.test.ts` | ✅ DONE |
| X10 | Tests pro telegram (17 testů) | `src/platforms/__tests__/telegram.test.ts` | ✅ DONE |

---

## 📊 Statistiky projektu

- **Celkem souborů `.ts`**: ~85+
- **Celkem testů**: 201 passing (12 test souborů)
- **Verze**: v0.4.0 (full feature parity + LM Studio + deep security)
- **Porovnání vs OpenClaw**: PepagiAGI 7.4/10 | OpenClaw 6.8/10 (vážené pro AGI cíl)

---

## 📝 Changelog

### v0.4.0 (2026-03-15)
- Přidáno: LM Studio provider (OpenAI-compatible local model, port 1234)
- Přidáno: Ollama health check + dynamic model discovery na daemon start
- Přidáno: SkillScanner — LLM deep scan (sémantická analýza medium-risk) + SHA-256 tamper detection
- Přidáno: SkillRegistry wires signSkill() + verifySkillIntegrity() před každým načtením
- Přidáno: Learning Multiplier — qualia frustrace/curiosity moduluje hloubku učení (1× → 2×)
- Přidáno: ArchitectureProposer — analyzuje metriky, navrhuje improvements každé 2h, `pepagi proposals` CLI
- Přidáno: Browser tool (Playwright) + Calendar tool (Mac iCal / Google Calendar)
- Přidáno: Weather tool (OpenWeatherMap) + Notion tool + Docker tool
- Přidáno: iMessage platform (Mac-only osascript bridge)
- Přidáno: Dockerfile + docker-compose.yml
- Přidáno: PreferenceMemory — detekuje preference z konverzace, persistuje cross-session, wired do Telegram + Discord
- Build: clean, testy: 138/138 passing

### v0.3.0 (2026-03-14)
- Přidáno: Discord platform, MCP server (port 3099)
- Přidáno: VectorStore (TF-IDF + Ollama), TemporalDecay
- Přidáno: SkillSynthesizer, PredictiveContextLoader, AdversarialTester
- Přidáno: Spotify, YouTube, Home Assistant tools
- Přidáno: HierarchicalPlanner wired do mediator pro complex/unknown tasky
- Fixed: managerProvider v fallback chain, qualia regex, Promise.allSettled
- Odstraněno: mrtvý kód callGPTCodexSDK (61 řádků)
- Testy: 48 → 138 (5 nových test souborů)

### v0.2.0 (předchozí session)
- Přidáno: Telegram, WhatsApp platforms, GoalManager, ConversationMemory
- Přidáno: SkillRegistry, SkillScanner, ACP protocol, Ollama provider
- Přidáno: Gmail, GitHub, TTS tools
- Fixed: mnoho bugů z auditu (flood limiter, fire-and-forget, statSync)
