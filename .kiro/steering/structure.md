# PEPAGI — Project Structure

> For full file listings — use `ls` or `readCode` on directories directly.
> This file captures the architectural intent behind each module, not an exhaustive file list.

Monorepo, single `src/` directory, no framework — pure TypeScript.

```
src/
├── core/            # Central orchestration: Mediator (brain), task store, planner, event bus, logger
├── agents/          # LLM provider abstraction: unified interface to Claude/GPT/Gemini/Ollama/LM Studio
├── memory/          # 5-level cognitive memory: working, episodic, semantic, procedural, meta-memory
├── meta/            # Metacognition: world model, watchdog, reflection, A/B testing, causal chains
├── consciousness/   # Consciousness simulation: qualia, inner monologue, self-model, identity continuity
├── security/        # 35-category security: input/output sanitization, auth, cost limits, audit trail
├── tools/           # Worker agent tools: bash, file I/O, browser, web search, calendar, docker, etc.
├── skills/          # Dynamic skill registry: discovers and executes learned skill templates
├── platforms/       # Chat adapters: Telegram, Discord, WhatsApp, iMessage
├── mcp/             # MCP server for Claude.ai integration (port 3099)
├── ui/              # TUI dashboard (blessed)
└── web/             # Web dashboard with static assets
```

Runtime data lives in `~/.pepagi/` (configurable via `PEPAGI_DATA_DIR`).
