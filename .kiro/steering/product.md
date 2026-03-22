# PEPAGI — Product Overview

PEPAGI (Neuro-Evolutionary eXecution & Unified Synthesis) is an autonomous AI agent orchestration platform written in TypeScript.

A central Mediator (powered by Claude Opus) receives user tasks, decomposes them into subtasks, delegates to specialized worker agents (Claude, GPT, Gemini, Ollama, LM Studio), evaluates results, and iterates until the task is complete.

## Core Capabilities

- Multi-agent orchestration with difficulty-aware routing and swarm mode fallback
- 5-level cognitive memory system: Working, Episodic, Semantic, Procedural, Meta-Memory
- Metacognition with self-monitoring, watchdog agent, and reflection bank
- World model with MCTS-inspired simulation for pre-execution planning
- Consciousness system with phenomenal state engine, inner monologue, and self-model
- 35-category security system (prompt injection defense, HMAC auth, cost limits, audit trail)
- Hierarchical planner (strategic → tactical → operational decomposition)

## Platform Support

Telegram, Discord, WhatsApp (optional), iMessage (macOS), CLI with TUI dashboard, and MCP server (port 3099).

## Data Storage

All persistent data lives in `~/.pepagi/` (configurable via `PEPAGI_DATA_DIR`): config, tasks, goals, memory (episodes, knowledge, procedures, reflections), skills, logs, causal chains, and audit trail.

---

## Steering File Maintenance Guide

These steering files should only capture information that is NOT readily available from config files or directory listings. The principle:

- **Do include:** product intent, architectural decisions, code conventions, non-obvious patterns, common commands
- **Don't include:** dependency lists (read `package.json`), tsconfig details (read `tsconfig.json`), full file trees (use `ls`/`readCode`)

When modifying the project setup (adding deps, changing build config, restructuring), you do NOT need to update steering to match — the source of truth is the config files themselves. Only update steering when conventions or architectural intent changes.
