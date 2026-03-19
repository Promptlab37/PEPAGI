# PEPAGI — Tech Stack & Build

## Runtime & Language

- TypeScript in strict mode (`"strict": true`, `"noImplicitAny": true`)
- Node.js ≥ 22
- ESM modules (`"type": "module"` in package.json, `"module": "ESNext"` in tsconfig)
- All imports use `.js` extension (ESM requirement)
- Target: ES2022

## Key Dependencies

- `zod` — schema validation for all external inputs (LLM responses, config, user input)
- `eventemitter3` — typed event bus (singleton `eventBus`)
- `telegraf` — Telegram bot
- `discord.js` — Discord bot
- `playwright` — browser automation tool
- `blessed` / `blessed-contrib` — TUI dashboard
- `chalk` — colored console output
- `nanoid` — ID generation
- `ws` — WebSocket (MCP server, web dashboard)
- `whatsapp-web.js` — WhatsApp (optional dependency)

## Build & Dev

- `tsx` for development execution (no compile step needed for dev)
- `tsc` for production build (outputs to `dist/`)
- No bundler — pure TypeScript compilation

## Common Commands

```bash
npm start              # Interactive CLI chat (tsx src/cli.ts)
npm run dev            # Development mode (tsx src/index.ts)
npm run build          # TypeScript compilation + copy web assets
npm test               # Run all tests (vitest run)
npm run test:watch     # Watch mode tests
npm run setup          # Interactive config wizard
npm run daemon         # Start all platform bots
npm run tui            # TUI dashboard
```

## Testing

- Vitest for all tests
- Tests colocated with source: `src/<module>/__tests__/*.test.ts`
- LLM calls are always mocked in tests — never make real API calls
- Helper pattern: `make*()` factory functions for test fixtures (e.g., `makeConfig()`, `makeMockLLM()`)

## Code Conventions

- Classes: PascalCase, files: kebab-case, methods: camelCase
- Dependency injection via constructors — no global state except `eventBus` singleton
- File I/O uses `node:fs/promises` with `{ recursive: true }` for directory creation
- Atomic file writes for critical data (write to `.tmp`, then `rename`)
- All async operations wrapped in try/catch with typed errors (`PepagiError`, `LLMProviderError`, `SecurityError`)
- JSDoc with `@param` and `@returns` on public methods
- File headers use box-drawing comment style: `// ═══════════════`
- Section separators use: `// ─── Section Name ───────────────`
- Config loaded from: `.env` → env vars → `~/.pepagi/config.json` → Zod defaults
