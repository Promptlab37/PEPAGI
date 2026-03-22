# PEPAGI — Tech & Conventions

> For dependencies, tsconfig, and build config — read `package.json` and `tsconfig.json` directly.
> This file captures conventions and commands that aren't obvious from config files alone.

## Common Commands

```bash
npm start              # Interactive CLI chat
npm run build          # TypeScript strict compilation (tsc)
npm test               # Run all tests (vitest run)
npm run setup          # Interactive config wizard
npm run daemon         # Start all platform bots
npm run tui            # TUI dashboard
```

## Code Conventions

- Classes: PascalCase, files: kebab-case, methods: camelCase
- All imports use `.js` extension (ESM requirement)
- Dependency injection via constructors — no global state except `eventBus` singleton
- Zod validation for all external inputs (LLM responses, config, user input)
- Atomic file writes for critical data (write to `.tmp`, then `rename`)
- All async operations wrapped in try/catch with typed errors (`PepagiError`, `LLMProviderError`, `SecurityError`)
- JSDoc with `@param` and `@returns` on public methods
- File headers use box-drawing comment style: `// ═══════════════`
- Section separators use: `// ─── Section Name ───────────────`
- File I/O uses `node:fs/promises` with `{ recursive: true }` for directory creation
- Config loaded from: `.env` → env vars → `~/.pepagi/config.json` → Zod defaults

## Testing Conventions

- Tests colocated: `src/<module>/__tests__/*.test.ts`
- LLM calls are always mocked — never make real API calls in tests
- Helper pattern: `make*()` factory functions for test fixtures (e.g., `makeConfig()`, `makeMockLLM()`)
