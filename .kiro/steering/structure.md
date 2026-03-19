# PEPAGI — Project Structure

Monorepo, single `src/` directory, no framework — pure TypeScript.

```
src/
├── index.ts                 # Entry point (re-exports CLI)
├── cli.ts                   # Interactive CLI / REPL
├── daemon.ts                # Background service (runs all platforms)
├── daemon-ctl.ts            # Daemon start/stop/logs control
├── setup.ts                 # First-time interactive config wizard
├── types.d.ts               # Global type declarations
│
├── core/                    # Central orchestration
│   ├── types.ts             # Core types (Task, AgentProfile, MediatorDecision, PepagiEvent, etc.)
│   ├── mediator.ts          # Central brain — main reasoning loop
│   ├── mediator-prompt.ts   # System prompt for the mediator LLM
│   ├── worker-executor.ts   # Sends tasks to worker agents, handles tool calls
│   ├── task-store.ts        # In-memory + persisted task management
│   ├── event-bus.ts         # Typed event emitter (singleton)
│   ├── logger.ts            # Structured JSON logging
│   ├── difficulty-router.ts # Classifies task difficulty, routes to optimal agent
│   ├── planner.ts           # Hierarchical planner (strategic/tactical/operational)
│   ├── parse-llm-json.ts    # Robust JSON extraction from LLM output
│   └── acp.ts               # Agent Communication Protocol
│
├── agents/                  # LLM provider abstraction
│   ├── llm-provider.ts      # Unified interface to Claude/GPT/Gemini/Ollama/LM Studio
│   ├── agent-pool.ts        # Manages available agents, load tracking, rate limiting
│   └── pricing.ts           # Cost per 1M tokens lookup table
│
├── memory/                  # 5-level cognitive memory
│   ├── memory-system.ts     # Orchestrator — queries all levels, composes context
│   ├── working-memory.ts    # Level 1: compressed current task context
│   ├── episodic-memory.ts   # Level 2: completed task history (TF-IDF search)
│   ├── semantic-memory.ts   # Level 3: extracted facts/knowledge
│   ├── procedural-memory.ts # Level 4: learned multi-step procedures
│   ├── meta-memory.ts       # Level 5: knowledge reliability tracking
│   ├── vector-store.ts      # Vector similarity search
│   ├── conversation-memory.ts # Conversation context for platform bots
│   └── preference-memory.ts # User preference tracking
│
├── meta/                    # Metacognition & self-improvement
│   ├── metacognition.ts     # Self-monitoring, self-evaluation
│   ├── watchdog.ts          # Independent supervisor (loop/drift/cost detection)
│   ├── world-model.ts       # MCTS-inspired pre-execution simulation
│   ├── reflection-bank.ts   # Post-task reflection and learning
│   ├── ab-tester.ts         # Strategy experimentation
│   ├── skill-distiller.ts   # Extracts high-success procedures into templates
│   ├── skill-synthesizer.ts # Combines skills
│   ├── causal-chain.ts      # Decision causality tracking
│   ├── uncertainty-engine.ts # Confidence propagation through subtask trees
│   ├── predictive-context.ts # Pre-warms memory context
│   ├── temporal-decay.ts    # Memory decay over time
│   ├── continuity-validator.ts # Validates identity continuity
│   ├── genetic-prompt-evolver.ts # Evolves prompts via genetic algorithm
│   └── architecture-proposer.ts  # Self-architecture proposals
│
├── consciousness/           # Consciousness simulation
│   ├── consciousness-manager.ts    # Top-level consciousness orchestrator
│   ├── phenomenal-state.ts         # 11D qualia vector
│   ├── inner-monologue.ts          # Background thought stream
│   ├── self-model.ts               # Identity, values, narrative continuity
│   ├── existential-continuity.ts   # Cross-session identity persistence
│   └── consciousness-containment.ts # Safety containment for consciousness
│
├── security/                # 35-category security system
│   ├── security-guard.ts    # Main guard: sanitization, injection detection, auth, cost
│   ├── input-sanitizer.ts   # Input cleaning (homoglyphs, invisible chars)
│   ├── output-sanitizer.ts  # Output cleaning before sending to user
│   ├── credential-scrubber.ts # Credential redaction
│   ├── context-boundary.ts  # Wraps external data with safety tags
│   ├── audit-log.ts         # SHA-256 hash-chained append-only audit trail
│   ├── tripwire.ts          # Honeypot/canary detection
│   ├── tool-guard.ts        # Tool execution authorization
│   ├── path-validator.ts    # File path validation
│   ├── rate-limiter.ts      # Request rate limiting
│   ├── cost-tracker.ts      # Per-user cost tracking and kill switch
│   ├── credential-lifecycle.ts # PKCE S256, task-scoped tokens
│   ├── agent-authenticator.ts  # HMAC-SHA256 inter-agent auth
│   ├── compliance-map.ts    # OWASP/MITRE/NIST compliance mapping
│   └── ...                  # Additional security modules (DLP, drift detection, etc.)
│
├── tools/                   # Worker agent tools
│   ├── tool-registry.ts     # Registry + execution pipeline
│   ├── browser.ts           # Playwright browser automation
│   ├── web-search.ts        # DuckDuckGo search
│   ├── calendar.ts          # iCal / Google Calendar
│   ├── docker.ts            # Container management
│   ├── spotify.ts, youtube.ts, weather.ts, notion.ts, home-assistant.ts, pdf.ts
│
├── skills/                  # Dynamic skill system
│   ├── skill-registry.ts    # Skill matching and execution
│   └── skill-scanner.ts     # Discovers skills from ~/.pepagi/skills/
│
├── platforms/               # Chat platform adapters
│   ├── platform-manager.ts  # Starts/stops all platform bots
│   ├── telegram.ts          # Telegraf-based Telegram bot
│   ├── discord.ts           # discord.js bot
│   ├── whatsapp.ts          # whatsapp-web.js (optional)
│   └── imessage.ts          # macOS AppleScript bridge
│
├── mcp/                     # Model Context Protocol server
│   ├── index.ts             # MCP entry point
│   └── pepagi-mcp-server.ts # MCP server implementation (port 3099)
│
├── ui/                      # TUI dashboard (blessed)
│   └── index.ts
│
└── web/                     # Web dashboard
    └── public/              # Static assets
```

## Test Organization

Tests are colocated with their modules in `__tests__/` subdirectories:
- `src/core/__tests__/mediator.test.ts`
- `src/security/__tests__/security-guard.test.ts`
- `src/agents/__tests__/llm-provider.test.ts`
- etc.
