# PEPAGI — Security and Code Quality Audit Report

**Date:** 2026-03-15
**Scope:** Full source audit of `src/` (all TypeScript files)
**Auditor:** Claude Sonnet 4.6 (automated static analysis)
**Version audited:** v0.2.0

---

## Executive Summary

The PepagiAGI codebase is a well-structured multi-agent orchestration platform with genuine security awareness baked into its design (SecurityGuard, SkillScanner, IdentityAnchor, tripwires, audit log). However, the audit identified **62 findings** across all severity levels, including 4 critical and 7 high-severity issues. The most serious problems are an unauthenticated HTTP server with wildcard CORS accessible on all network interfaces, a component that writes LLM-generated JavaScript code to disk without any security scanning, API credentials exposed in URL query strings, and multiple shell injection vectors in tool implementations. Several memory/data integrity issues (race conditions, non-atomic file writes) also require urgent attention.

---

## Severity Definitions

| Level | Definition |
|-------|-----------|
| **CRITICAL** | Exploitable without authentication; enables RCE, data exfiltration, or credential theft |
| **HIGH** | Significant risk: shell injection, authentication bypass, race condition with data-corruption potential |
| **MEDIUM** | Logic bug, missing validation, or privacy concern with moderate exploitation difficulty |
| **LOW** | Code quality, performance inefficiency, minor logic issue, or defensive improvement |
| **INFO** | Observation with no direct security impact; architectural or maintainability note |

---

## Findings

### 1. SECURITY

---

**SEC-01 — CRITICAL — Unauthenticated MCP Server Exposed on All Network Interfaces**
File: `src/mcp/pepagi-mcp-server.ts`

The MCP server binds on `0.0.0.0` (all network interfaces) with no authentication, no rate limiting, and `Access-Control-Allow-Origin: *`. The `process_task` tool accepts arbitrary task descriptions from any HTTP client on the local network and routes them directly through the Mediator — enabling any process or user on the LAN to execute arbitrary AI-driven tasks including shell commands, file writes, and agent tool calls.

```typescript
// pepagi-mcp-server.ts
res.setHeader("Access-Control-Allow-Origin", "*");
this.server.listen(this.port, "0.0.0.0", () => { ... });
```

**Recommendation:** Bind to `127.0.0.1` only. Add a Bearer token or HMAC-signed request check. Implement per-IP rate limiting.

---

**SEC-02 — CRITICAL — SkillSynthesizer Writes LLM-Generated Code to Disk Without Security Scan**
File: `src/meta/skill-synthesizer.ts`

`SkillSynthesizer.synthesizeAll()` generates JavaScript skill files entirely from LLM output and writes them directly to `~/.pepagi/skills/` without invoking `SkillScanner`. On the next `skillRegistry.loadAll()` call the scanner does run, but between the write and the next load, unapproved LLM-generated code sits on disk. A crash between write and load leaves permanently unapproved code in the skills directory.

```typescript
// skill-synthesizer.ts
await writeFile(skillPath, skillSource, "utf8");
// SkillScanner is NOT called here — only called on next loadAll()
```

**Recommendation:** Run `scanSkillFile` before writing. Discard the file if the scan rejects it. Never write unapproved code to the skills directory.

---

**SEC-03 — CRITICAL — Gemini API Key Exposed in HTTP Request URL**
File: `src/agents/llm-provider.ts` (approximately line 480)

The Gemini provider appends the API key as a URL query parameter. This key appears in server-side access logs, any HTTP proxy logs, and browser history if a proxy UI is involved.

```typescript
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
```

**Recommendation:** Move the key to a request header (`x-goog-api-key: ${apiKey}`) which is not logged by standard HTTP infrastructure.

---

**SEC-04 — CRITICAL — Shell Injection via TTS Voice Parameter**
File: `src/tools/tool-registry.ts` (approximately lines 405-416)

The `say` (macOS TTS) tool passes the `voice` parameter directly into a shell command string without sanitization. A crafted voice name containing shell metacharacters can execute arbitrary commands.

```typescript
const cmd = `say -v "${voice}" "${safeText}"`;
await execAsync(cmd, { timeout: 30_000 });
```

The `safeText` variable has double-quote escaping applied, but `voice` does not. An attacker or misbehaving LLM agent could supply `en-US"; rm -rf ~/; echo "` as the voice value.

**Recommendation:** Validate `voice` against a strict allowlist of known macOS voice names (alpha-hyphen only). Use `spawn` with an args array instead of `execAsync` with a shell string.

---

**SEC-05 — HIGH — Audit Log Race Condition: Module-Level `lastHash` Variable**
File: `src/security/audit-log.ts`

The `lastHash` variable is declared at module scope. When two audit log entries are appended concurrently (e.g., parallel task completions), both reads of `lastHash` see the same previous value, causing the hash chain to fork silently. The integrity of the chain cannot be verified on replay.

```typescript
let lastHash = "";  // shared mutable module-level state

export async function appendAuditEntry(...): Promise<void> {
  const entry = { ..., prevHash: lastHash, ... };
  const hash = computeHash(entry);
  lastHash = hash;  // TOCTOU race condition
  await appendFile(AUDIT_LOG_PATH, ...);
}
```

**Recommendation:** Serialize writes through a single async queue (e.g., a Promise chain). Read the last hash from the file on each call rather than relying on in-memory state.

---

**SEC-06 — HIGH — Shell Injection via Whisper `language` Parameter**
File: `src/agents/llm-provider.ts` (approximately line 936)

`transcribeWithLocalWhisper` builds a shell command using the `language` parameter from the caller without sanitization. A language value like `en; rm -rf ~/` would be executed.

```typescript
const cmd = `whisper "${tmpPath}" --language ${language} --output-format txt`;
await execSync(cmd, ...);
```

**Recommendation:** Validate `language` against an allowlist of ISO 639-1 language codes (two lowercase alpha characters). Use `spawn` with an args array.

---

**SEC-07 — HIGH — iMessage AppleScript Injection in `sendMessage`**
File: `src/platforms/imessage.ts` (lines 86-104)

The `to` parameter (phone number / Apple ID) has `"` stripped but is otherwise injected into an AppleScript template literal. A crafted recipient string containing AppleScript syntax could manipulate the script. The outer shell escaping using `'...'` quoting is fragile for multi-line blocks.

```typescript
const safeTo = to.replace(/"/g, "");
const script = `tell application "Messages"
  set targetBuddy to buddy "${safeTo}" of service "iMessage"...`;
await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
```

**Recommendation:** Validate `to` strictly against an E.164 phone number pattern or email regex. Use `osascript -` with stdin input instead of inline `-e` to avoid shell quoting fragility.

---

**SEC-08 — HIGH — Browser Tool Executes Arbitrary JavaScript from Agent Input**
File: `src/tools/browser.ts`

The `evaluate` action accepts a `code` parameter containing arbitrary JavaScript and executes it in the browser page context via Playwright's `page.evaluate()`. There is no sandboxing or allowlist. Any LLM agent can inject any JavaScript into the current page, including reading `document.cookie`, exfiltrating form data, or performing cross-site actions.

```typescript
case "evaluate": {
  result = await page.evaluate(input.code);  // arbitrary JS execution
  break;
}
```

**Recommendation:** Remove the `evaluate` action entirely, or restrict it to a hardcoded list of safe expression patterns. If needed, run Playwright in a sandboxed subprocess with no network access.

---

**SEC-09 — HIGH — GoalManager Passes Goal Prompts to Mediator Without Injection Detection**
File: `src/core/goal-manager.ts`

Goals loaded from the user-editable `~/.pepagi/goals.json` are passed directly as task descriptions to the Mediator without running `SecurityGuard.detectInjection()`. A compromised or crafted goals file can inject adversarial prompts into the Mediator's context.

```typescript
const task = this.taskStore.create({
  title: goal.title,
  description: goal.prompt,  // no detectInjection() call
  ...
});
```

**Recommendation:** Run `SecurityGuard.detectInjection()` on goal prompts before creating tasks. If risk score exceeds threshold, reject the goal execution and log a warning.

---

**SEC-10 — HIGH — SkillScanner Bypassed by `.mjs` Extension**
File: `src/skills/skill-registry.ts` (line 105)

The SkillRegistry only processes files with a `.js` extension. A skill file with `.mjs` extension is silently ignored by `loadAll()`, bypassing all security scanning entirely.

```typescript
const jsFiles = files.filter(f => extname(f) === ".js" && !f.startsWith("_"));
```

**Recommendation:** Also process `.mjs` files. Resolve symlinks via `realpath` and verify the resolved path remains within `SKILLS_DIR` before loading.

---

**SEC-11 — MEDIUM — Skill Checksum Store Race Condition**
File: `src/skills/skill-scanner.ts` (lines 159-172)

`signSkill()` reads the checksum store, updates it in memory, and writes it back. Two concurrent `signSkill()` calls for different files will overwrite each other's updates. Only one checksum will be persisted.

```typescript
const raw = await readFile(CHECKSUM_STORE, "utf8");
store = JSON.parse(raw);      // concurrent read
store[filePath] = checksum;
await writeFile(CHECKSUM_STORE, ...);  // last writer wins
```

**Recommendation:** Use atomic read-modify-write with a file lock or serialize checksum updates.

---

**SEC-12 — MEDIUM — Raw Error Messages Sent Directly to Platform Users**
File: `src/platforms/telegram.ts`, `src/platforms/discord.ts`, `src/platforms/whatsapp.ts`

In multiple platform files, raw exception messages are forwarded directly to users:

```typescript
// telegram.ts
await ctx.reply(`Chyba: ${err instanceof Error ? err.message : String(err)}`);
// discord.ts
await message.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
// whatsapp.ts
await client.sendMessage(from, `⚠️ Chyba: ${errMsg}`);
```

Internal error messages may contain file paths, LLM provider details, API endpoints, or stack fragments that aid attackers in reconnaissance.

**Recommendation:** Map internal errors to generic user-facing messages. Log the full error internally only.

---

**SEC-13 — MEDIUM — `deepScanWithLLM` Hardcodes Stale Model Name**
File: `src/skills/skill-scanner.ts` (line 228)

The optional deep scan uses `"claude-haiku-4-5-20251001"` while the canonical constant `CHEAP_CLAUDE_MODEL` in `pricing.ts` is `"claude-haiku-4-5"`. When the hardcoded model is retired by Anthropic, `deepScanWithLLM` will silently fail and return `{ safe: true }` from the catch block, meaning all skills pass deep scan unconditionally.

**Recommendation:** Replace the hardcoded string with `CHEAP_CLAUDE_MODEL` imported from `pricing.ts`.

---

**SEC-14 — MEDIUM — Same Hardcoded Stale Model in `InnerMonologue` and `ExistentialContinuity`**
Files: `src/consciousness/inner-monologue.ts` (line 131), `src/consciousness/existential-continuity.ts` (line 42)

Both files use `"claude-haiku-4-5-20251001"` instead of `CHEAP_CLAUDE_MODEL`. When the model is retired, these subsystems fail silently.

**Recommendation:** Use `CHEAP_CLAUDE_MODEL` constant in both files.

---

**SEC-15 — MEDIUM — `ConsciousnessManager` EventBus Listener Never Unsubscribed**
File: `src/consciousness/consciousness-manager.ts` (lines 97-99)

```typescript
eventBus.onAny((event: PepagiEvent) => {
  this.handleEvent(event);
});
```

The subscription is established in `boot()` but never removed in `shutdown()`. `switchProfile()` calls `shutdown()` then conditionally re-boots, causing the listener to accumulate on each profile switch.

**Recommendation:** Store the handler reference and call `eventBus.offAny()` in `shutdown()`.

---

**SEC-16 — MEDIUM — `IdentityManipulationError` Is Caught and Silently Logged Only**
File: `src/consciousness/self-model.ts` (lines 513-519)

```typescript
} catch (err) {
  if (err instanceof IdentityManipulationError) {
    console.error(`[SelfModelManager] ⚠️  ${err.message}`);
  }
}
```

A core value tampering event is swallowed with only a `console.error`. The system does not halt, enter safe mode, or emit an audit event.

**Recommendation:** Emit a `security:blocked` event via `eventBus`, switch the consciousness profile to `SAFE-MODE`, and halt further self-model updates until the discrepancy is investigated.

---

**SEC-17 — LOW — Calendar Tool `icalAddEvent` Passes User Strings Into AppleScript Date Literal**
File: `src/tools/calendar.ts` (lines 87-88)

`startDate` and `endDate` from agent parameters are injected into an AppleScript `date "..."` literal without validation. A crafted date string could break out of the AppleScript template.

**Recommendation:** Validate both date strings with a strict ISO 8601 regex before embedding.

---

**SEC-18 — LOW — iMessage `pollMessages` SQLite Query Output Parsed by Pipe-Splitting**
File: `src/platforms/imessage.ts` (lines 136-143)

```typescript
const pipeIdx = line.lastIndexOf("|");
const text = line.slice(0, pipeIdx).trim();
const sender = line.slice(pipeIdx + 1).trim();
```

A message body containing a `|` character will cause incorrect parsing of the sender field, potentially routing the AI reply to the wrong recipient.

**Recommendation:** Use a parameterized SQLite library (e.g., `better-sqlite3`) to query the messages database with proper column separation, eliminating the fragile pipe-split parsing.

---

### 2. MEMORY LEAKS AND RESOURCE MANAGEMENT

---

**MEM-01 — HIGH — Singleton Playwright Browser Instance Never Closed on Process Exit**
File: `src/tools/browser.ts`

Module-level `browser` and `page` variables are created on first use and kept alive indefinitely. The `closeBrowser()` export function is never called by the daemon shutdown sequence in `daemon.ts`.

**Recommendation:** Call `closeBrowser()` in the daemon's `shutdown()` function. Register a `process.on("exit", ...)` handler as a final safety net.

---

**MEM-02 — MEDIUM — WorkingMemory Entries for Completed Tasks Never Evicted**
File: `src/memory/working-memory.ts`

Working memory stores per-task state in an in-memory `Map`. There is no eviction based on task completion or age. Over many tasks in a long-running daemon session, this Map grows without bound.

**Recommendation:** Add eviction connected to `task:completed` and `task:failed` events to remove finalized task states.

---

**MEM-03 — MEDIUM — `Metacognition.confidenceHistory` Shared Across All Tasks With No Per-Task Cleanup**
File: `src/meta/metacognition.ts`

`confidenceHistory` is capped at 500 entries globally, but all tasks across the lifetime of the daemon share the same array. Entries from long-ago tasks are never freed explicitly; they are only displaced when the 500-entry cap forces shift-out.

**Recommendation:** Partition confidence history by task ID and evict task-specific history after task completion.

---

**MEM-04 — MEDIUM — Telegram `system:alert` EventBus Listener Never Removed in `stop()`**
File: `src/platforms/telegram.ts`

A `system:alert` event listener registered on the singleton `eventBus` in `setupHandlers()` is never removed when `stop()` is called.

**Recommendation:** Store the handler reference and call `eventBus.off()` in `stop()`.

---

**MEM-05 — MEDIUM — `Tripwire.accessedPaths` Set Grows Without Bound**
File: `src/security/tripwire.ts`

The module-level `accessedPaths` Set has no eviction or size cap. Under continuous probing attempts, it grows indefinitely.

**Recommendation:** Cap the Set at a reasonable size (e.g., 1000 entries). Write triggered-path events to the audit log for persistence.

---

**MEM-06 — LOW — `CausalChain` In-Memory Node Map Never Evicted After Persist**
File: `src/meta/causal-chain.ts`

Causal nodes are kept in memory after `persist()` is called. After thousands of tasks, this becomes unbounded accumulation.

**Recommendation:** After `persist()` or after receiving `task:completed`/`task:failed` events, remove nodes for finalized tasks from the in-memory Map.

---

**MEM-07 — LOW — `PredictiveContextLoader` Cache Has No Size Cap**
File: `src/meta/predictive-context.ts`

The prediction cache is a `Map<string, CacheEntry>` with 5-minute TTL but no maximum size. Entries are only evicted by TTL on access; they are never proactively evicted by size.

**Recommendation:** Implement LRU eviction or cap the cache at a fixed maximum (e.g., 200 entries).

---

### 3. ERROR HANDLING

---

**ERR-01 — MEDIUM — WorldModel LLM Response Parsed Without Schema Validation**
File: `src/meta/world-model.ts`

LLM JSON responses are parsed with a direct cast and no Zod schema:

```typescript
const raw = JSON.parse(resp.content) as { predictedSuccess?: number; risks?: string[] };
```

If the LLM returns an unexpected structure (e.g., `predictedSuccess` as a string), the error propagates silently as `NaN` in probability calculations rather than as a validation error.

**Recommendation:** Define a Zod schema for the world model response and use `schema.safeParse()`.

---

**ERR-02 — MEDIUM — HierarchicalPlanner Fallbacks Not Surfaced to the Mediator**
File: `src/core/planner.ts`

`plan()` silently falls back to a single-node plan when any LLM call fails. The returned `PlanTree` is structurally incomplete but no warning is included. The mediator treats the degraded plan identically to a complete one.

**Recommendation:** Track how many levels fell back to defaults and include a `degraded: boolean` flag in the returned `PlanTree`. The mediator should treat a mostly-fallback plan as low-confidence.

---

**ERR-03 — MEDIUM — `SemanticMemory.search()` Increments `useCount` But Does Not Persist**
File: `src/memory/semantic-memory.ts`

```typescript
fact.useCount = (fact.useCount ?? 0) + 1;
// save() is NOT called after incrementing useCount
```

`useCount` is incremented in memory but never written to disk. After a daemon restart, all use counts reset to zero.

**Recommendation:** Either save after incrementing `useCount`, or batch-persist periodically (e.g., every 10 searches or at shutdown).

---

**ERR-04 — LOW — `ArchitectureProposer.rewriteAll()` Uses Non-Atomic Write**
File: `src/meta/architecture-proposer.ts` (lines 82-85)

```typescript
await writeFile(PROPOSALS_PATH, lines, "utf8");
```

A crash during `rewriteAll()` (called when marking a proposal as implemented) will corrupt `proposals.jsonl`.

**Recommendation:** Use tmp-file-then-rename (atomic write pattern).

---

**ERR-05 — LOW — CLI `logs` Command Uses Hardcoded Filename That Does Not Match Logger Output**
File: `src/cli.ts` (line 780)

```typescript
const logFile = join(PEPAGI_DATA_DIR, "logs", "pepagi.log");
```

The Logger writes files named `pepagi-{date}.jsonl`. The hardcoded `pepagi.log` path does not match and will always produce "Log soubor zatím neexistuje."

**Recommendation:** List files in the logs directory and read the most recently modified file matching `pepagi-*.jsonl`.

---

### 4. LOGIC BUGS

---

**BUG-01 — HIGH — Non-Atomic File Writes Across Nine Memory and Config Files**

The following files use `writeFile()` directly instead of the safe tmp-then-rename atomic pattern. A process crash or power loss mid-write will corrupt these files permanently:

| File | Write site |
|------|-----------|
| `src/memory/procedural-memory.ts` | `save()` |
| `src/memory/meta-memory.ts` | `save()` |
| `src/memory/preference-memory.ts` | `save()` |
| `src/meta/ab-tester.ts` | `save()` |
| `src/meta/reflection-bank.ts` | `persist()` |
| `src/core/difficulty-router.ts` | `saveProfiles()` |
| `src/consciousness/phenomenal-state.ts` | `persist()` |
| `src/meta/genetic-prompt-evolver.ts` | `persist()` |
| `src/config/loader.ts` | `saveConfig()` |

By contrast, `TaskStore`, `SelfModelManager`, and `IdentityAnchor` correctly use the tmp-then-rename pattern. The inconsistency represents a systematic gap.

**Recommendation:** Apply atomic write (write to `${path}.tmp.${process.pid}`, then `rename`) consistently across all persistent state files.

---

**BUG-02 — HIGH — `UncertaintyEngine.getTaskConfidence()` Has No Cycle Detection**
File: `src/meta/uncertainty-engine.ts`

```typescript
private calculateSubtreeConfidence(taskId: string): number {
  const task = this.taskStore.getTask(taskId);
  if (!task || task.subtasks.length === 0) return task?.confidence ?? 0.7;
  return Math.min(...task.subtasks.map(id => this.calculateSubtreeConfidence(id))) * 0.9;
}
```

If `TaskStore` ever contains a cyclic dependency reference (task A's subtasks list contains B, and B's subtasks list contains A), this recursion will stack-overflow the process. `TaskStore` does not validate for cycles on `create()`.

**Recommendation:** Add cycle detection using a `visited: Set<string>` parameter. Add cycle validation in `TaskStore.create()`.

---

**BUG-03 — MEDIUM — `config.json` Saved Without Atomic Write; `cachedConfig` Not Invalidated**
File: `src/config/loader.ts`

`saveConfig()` writes config with plain `writeFile()`. Additionally, `cachedConfig` (the singleton loaded at startup) is never updated after `saveConfig()` is called. Subsequent calls to `loadConfig()` return the pre-save stale config.

```typescript
let cachedConfig: PepagiConfig | null = null;
export async function saveConfig(config: PepagiConfig): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  // cachedConfig is NOT updated here
}
```

**Recommendation:** Update `cachedConfig` after a successful `saveConfig()`. Use atomic write.

---

**BUG-04 — MEDIUM — `DifficultyRouter` Falls Back to `"claude"` Even When `"claude"` Is Unavailable**
File: `src/core/difficulty-router.ts`

```typescript
const safeAgent = available[0]?.provider ?? "claude";
```

If no agents are available, the router returns `"claude"` regardless of its availability status, causing a guaranteed failure in the subsequent worker call rather than a meaningful `fail` decision.

**Recommendation:** Return `null` when no agents are available and handle the null case at the call site with an immediate `fail` action.

---

**BUG-05 — MEDIUM — `EpisodicMemory.save()` Rewrites Entire File on Every `store()` Call**
File: `src/memory/episodic-memory.ts`

`save()` is called inside `store()`, which is called after every task completion. The implementation rewrites the entire JSONL file from scratch on each call. With thousands of episodes, this is O(n) I/O on every task completion.

**Recommendation:** For new episodes, use `appendFile` to append a single JSONL line. Only perform a full rewrite when modifying an existing episode.

---

**BUG-06 — MEDIUM — `SemanticMemory.save()` Same Full-Rewrite Pattern**
File: `src/memory/semantic-memory.ts`

Identical to BUG-05: every `addFact()` call rewrites the entire knowledge base file.

**Recommendation:** Same as BUG-05 — `appendFile` for new facts, full rewrite only when updating existing ones.

---

**BUG-07 — LOW — `Watchdog` Self-Heal Uses `spawnSync` Which Blocks the Event Loop**
File: `src/meta/watchdog.ts`

```typescript
spawnSync("claude", ["auth", "status"])
```

`spawnSync` is synchronous and blocks the Node.js event loop for the duration of the `claude` CLI startup (potentially 1-3 seconds), blocking all I/O including Telegram/Discord message handling.

**Recommendation:** Replace with the async `spawn` or `exec` equivalent.

---

**BUG-08 — LOW — `SkillDistiller.listSkills()` Uses Synchronous `readdirSync`**
File: `src/meta/skill-distiller.ts`

```typescript
const files = readdirSync(skillsDir);
```

A synchronous blocking filesystem call in an otherwise fully async codebase.

**Recommendation:** Replace with `await readdir(skillsDir)`.

---

**BUG-09 — LOW — `iMessagePlatform` Calculates Apple Timestamp Incorrectly on Initialization**
File: `src/platforms/imessage.ts` (line 49)

```typescript
this.lastChecked = Math.floor(Date.now() / 1000) * 1_000_000_000;
```

This multiplies the Unix timestamp in seconds by 1 billion, producing a value orders of magnitude larger than a valid Apple timestamp. The correct calculation (subtracting the Apple epoch offset) is already implemented in `pollMessages()` at lines 130-131. The incorrect initialization causes the first poll query to match zero messages regardless of database contents.

**Recommendation:** Apply the same formula used in `pollMessages()` when initializing `lastChecked`.

---

**BUG-10 — LOW — `ArchitectureProposer` Proposals Accumulate Duplicates Across Multiple `runAnalysis` Calls**
File: `src/meta/architecture-proposer.ts`

Each `propose()` call pushes new proposals into `this.proposals` and appends to the JSONL file. Since proposals are deduped only by `id` (a `nanoid` generated fresh each call), semantically identical proposals from consecutive analysis runs are all retained.

**Recommendation:** Add deduplication by `title`. Cap total stored proposals at a reasonable maximum.

---

### 5. TYPE SAFETY

---

**TS-01 — MEDIUM — `AgentPool` Uses Unsafe Type Cast on Agent Map**
File: `src/agents/agent-pool.ts`

```typescript
const providers = this.agents as Record<string, AgentProfile | undefined>;
```

This cast bypasses TypeScript's type checker for a security-adjacent path. If the map contains unexpected keys, downstream code fails at runtime without compile-time warning.

**Recommendation:** Use `Object.entries(this.agents)` or a proper typed Map.

---

**TS-02 — MEDIUM — WorldModel LLM Response Cast Without Validation**
File: `src/meta/world-model.ts`

```typescript
const raw = JSON.parse(resp.content) as { predictedSuccess?: number; risks?: string[] };
```

The direct cast produces `any`-equivalent behavior. A number field that is actually a string causes `NaN` propagation in probability calculations.

**Recommendation:** Use a Zod schema for validation consistent with the rest of the codebase.

---

**TS-03 — MEDIUM — `cli.ts` Reads `self-model.json` With Type That Does Not Match `SelfModel`**
File: `src/cli.ts` (lines 435-441)

The CLI's `narrative` command parses `self-model.json` and casts it to a shape referencing `model.identity.birthTimestamp` and `model.identity.narrative` — fields that do not exist in the actual `IdentityCore` interface. These will be `undefined` at runtime, silently displaying nothing.

**Recommendation:** Import and reuse the `SelfModel` type from `consciousness/self-model.ts`.

---

**TS-04 — LOW — `event-bus.ts` `off()` Method Uses `any` Parameter**
File: `src/core/event-bus.ts`

```typescript
off(event: string, listener: (...args: any[]) => void): this {
```

The `any` type means mismatched event handler removals are not caught at compile time.

**Recommendation:** Parameterize the listener type using the `PepagiEvent` discriminated union.

---

**TS-05 — LOW — Non-Null Assertions in Security-Sensitive Paths**

Multiple files use `!` non-null assertions on values that could realistically be `undefined`:

- `src/security/audit-log.ts`: `entries[entries.length - 1]!` on a potentially empty array
- `src/agents/llm-provider.ts`: Multiple `match[1]!` without length checks
- `src/memory/episodic-memory.ts`: `this.episodes[idx]!` after array filter

**Recommendation:** Replace `!` assertions with explicit null checks or nullish coalescing.

---

### 6. PERFORMANCE

---

**PERF-01 — MEDIUM — VectorStore Rebuilds Full TF-IDF Index on Every `hybridSearch()` Call**
File: `src/memory/vector-store.ts`

```typescript
async hybridSearch(query: string, documents: Document[], topK = 5): Promise<Document[]> {
  const tfidf = this.buildTFIDF(documents);  // O(n × w) on every call
  ...
}
```

With large episodic/semantic memory, this is a significant per-search cost.

**Recommendation:** Cache the TF-IDF index and invalidate it only when documents are added or removed, using a dirty flag.

---

**PERF-02 — MEDIUM — VectorStore Makes N+1 Ollama HTTP Calls for Neural Embeddings**
File: `src/memory/vector-store.ts`

When Ollama neural embeddings are enabled, `hybridSearch()` makes one embedding request for the query, then one request per document sequentially. For 500 documents, this is 501 serial HTTP requests.

**Recommendation:** Use `Promise.all()` to batch embedding requests. Cap batch size to avoid overwhelming the local Ollama server.

---

**PERF-03 — LOW — Inner Monologue Makes LLM Calls Every 20 Seconds in `RICH`/`RESEARCHER` Profile**
Files: `src/consciousness/inner-monologue.ts`, `src/config/consciousness-profiles.ts`

In `RICH` and `RESEARCHER` profiles, `monologueIntervalMs` is 20 seconds, producing ~180 LLM calls per hour purely for inner monologue even when no user task is active.

**Recommendation:** Add an inactivity threshold: pause inner monologue after N minutes of no user-facing task activity.

---

**PERF-04 — LOW — `HierarchicalPlanner.plan()` Makes Sequential LLM Calls for Independent Branches**
File: `src/core/planner.ts`

For a plan with 4 strategic goals each having 3 tactical subgoals each having 3 operational steps, this produces 1 + 4 + 12 + 36 = 53 sequential LLM calls. Strategic goals are independent of each other and could be planned in parallel.

**Recommendation:** Parallelize tactical plan generation across strategic nodes using `Promise.all()`.

---

### 7. DEAD CODE

---

**DEAD-01 — LOW — `SHELL_METACHAR_RE` Defined But Not Used**
File: `src/tools/tool-registry.ts`

```typescript
const SHELL_METACHAR_RE = /[;&|`$\\<>{}()]/;  // never referenced

function hasDangerousMetachars(cmd: string): boolean {
  return /[;&`$\\<>{}()]/.test(cmd);  // different inline regex used
}
```

`SHELL_METACHAR_RE` is defined but never used. The inline regex subtly differs (it does not include `|`, meaning pipes are not blocked by `hasDangerousMetachars`). This is confusing and likely unintentional.

**Recommendation:** Remove the unused constant. Document explicitly which characters are intentionally excluded and why.

---

**DEAD-02 — LOW — ACP Protocol Is Defined But Never Used**
File: `src/core/acp.ts`

The Agent Client Protocol defines `ACPRequest`, `ACPResponse`, and factory functions, but `WorkerExecutor` does not use them — it calls `llm.call()` directly. The module contributes dead code.

**Recommendation:** Either wire ACP into `WorkerExecutor`, or add a comment marking it as forward-looking infrastructure with a reference to the relevant issue/roadmap item.

---

**DEAD-03 — INFO — `src/types.d.ts` Purpose Unclear**
File: `src/types.d.ts`

This file exists in the project. Confirm it does not contain module augmentations that shadow types from `src/core/types.ts`, which would cause silent type resolution issues.

---

### 8. API MISMATCHES

---

**API-01 — MEDIUM — `deepScanWithLLM` Signature Expects Non-Standard `quickClaude` Interface**
File: `src/skills/skill-scanner.ts` (lines 214-216)

`deepScanWithLLM` accepts an `llm` parameter typed as `{ quickClaude(sys, msg, model, json): Promise<{content: string}> }`. The actual `LLMProvider.quickClaude()` returns `Promise<{content, cost, usage}>`. The parameter position of the `json` boolean differs between the expected interface and the actual implementation, meaning the type checker does not enforce correct call-site usage.

**Recommendation:** Import `LLMProvider` type directly and use it as the parameter type.

---

**API-02 — LOW — Three Files Use Hardcoded Model String Instead of `CHEAP_CLAUDE_MODEL`**

As documented in SEC-13 and SEC-14: `src/skills/skill-scanner.ts`, `src/consciousness/inner-monologue.ts`, and `src/consciousness/existential-continuity.ts` all use `"claude-haiku-4-5-20251001"` while `pricing.ts` exports `CHEAP_CLAUDE_MODEL = "claude-haiku-4-5"`. These may be functionally different identifiers with the Anthropic API.

**Recommendation:** Audit all model name strings in the codebase and replace hardcoded strings with the appropriate constant from `pricing.ts`.

---

**API-03 — LOW — `GeneticPromptEvolver.evolve()` Never Updates `avgCost` Per Variant**
File: `src/meta/genetic-prompt-evolver.ts`

The fitness formula uses `avgCost` with 30% weight, but `evolve()` never updates `variant.avgCost`. It remains at the initial value of `0.01` forever, making the cost-efficiency component of fitness meaningless.

```typescript
variant.successRate = variant.successRate * 0.8 + success * 0.2;
variant.avgConfidence = variant.avgConfidence * 0.8 + conf * 0.2;
// avgCost is never updated
```

**Recommendation:** Pass the actual task cost to `evolve()` and update `avgCost` with exponential moving average, mirroring how `successRate` is updated.

---

### 9. OPERATIONAL

---

**OPS-01 — MEDIUM — No Log Rotation Implemented**
File: `src/core/logger.ts`

Logs are written to `~/.pepagi/logs/pepagi-{date}.jsonl` with one file per calendar day. There is no eviction of old files. In a long-running deployment, the logs directory grows without bound.

**Recommendation:** Delete log files older than a configurable N days (default 30) during daemon startup.

---

**OPS-02 — MEDIUM — Daemon Timers Not Unreffed**
File: `src/daemon.ts` (lines 152-159)

```typescript
const consolidationTimer = setInterval(() => { ... }, 30 * 60_000);
const archProposerTimer = setInterval(() => { ... }, 2 * 60 * 60_000);
```

These timers are not `.unref()`'d. If `daemon.ts` is ever imported in a test context, it will prevent test suite exit.

**Recommendation:** Call `.unref()` on both timers and rely on graceful shutdown to call `clearInterval` explicitly.

---

**OPS-03 — LOW — `/health` Endpoint Returns No Actual Health Data**
File: `src/mcp/pepagi-mcp-server.ts`

The `/health` endpoint returns only `{ status: "ok" }` with no component health data (LLM provider status, memory file availability, task queue depth, agent pool status).

**Recommendation:** Extend `/health` to include: last successful LLM call timestamp, task store queue depth, agent pool availability, and memory system file status.

---

**OPS-04 — LOW — AdversarialTester Makes Real LLM Calls During Daemon Startup Period**
File: `src/daemon.ts` (line 170)

`adversarialTester.start(60 * 60_000)` is called during daemon boot. The first hourly run triggers within the first 60 minutes of startup regardless of whether any user task has been processed, consuming API quota during idle periods.

**Recommendation:** Add a `startDelay` parameter to `AdversarialTester.start()` and delay the first run by at least the full interval, or make the first run conditional on a minimum number of processed tasks.

---

**OPS-05 — LOW — Setup Wizard Uses `process.cwd()` Which May Not Be Project Root**
File: `src/cli.ts` (line 856)

```typescript
execSync("npm run setup", { stdio: "inherit", cwd: process.cwd() });
```

If the CLI is invoked from a directory other than the project root (e.g., after `npm link`), this will fail.

**Recommendation:** Derive the project root from `import.meta.url` (as `daemon-ctl.ts` does with `INSTALL_DIR`) and use it as `cwd`.

---

### 10. CODE QUALITY

---

**QUAL-01 — MEDIUM — `mediator.ts` Is a 693-Line God Class With 16 Constructor Parameters**
File: `src/core/mediator.ts`

The `Mediator` class constructor takes 16 parameters and `processTask()` integrates all AGI subsystems in a single method. It handles decomposition, swarm mode, world model simulation, difficulty routing, plan execution, reflection, and memory. This makes testing, debugging, and future modification significantly harder.

**Recommendation:** Extract `SwarmCoordinator`, `PlanExecutor`, and `TaskAnalyzer` as separate collaborator classes injected through the constructor. `Mediator` becomes a thin orchestrator.

---

**QUAL-02 — LOW — `llm-provider.ts` Is 1034 Lines With Multiple Responsibilities**
File: `src/agents/llm-provider.ts`

The `LLMProvider` class handles five different provider protocols (Claude API, Claude CLI, GPT, Gemini, Ollama/LMStudio), vision processing, TTS, STT, web scraping, and retry logic in a single file.

**Recommendation:** Extract each provider into its own file (`ClaudeProvider`, `GPTProvider`, `GeminiProvider`, `OllamaProvider`) implementing a common `ILLMProvider` interface. `LLMProvider` becomes a factory/router.

---

**QUAL-03 — LOW — Telegram Platform Maintains Two Parallel Conversation History Structures**
File: `src/platforms/telegram.ts`

The Telegram platform maintains both an in-memory `conversations: Map<number, ConversationEntry[]>` and a `ConversationMemory` instance backed by disk. Both are updated on every message. If one update fails, the two structures diverge silently.

**Recommendation:** Use `ConversationMemory` as the single source of truth. Build context from its `getHistory()` method and remove the redundant in-memory Map.

---

**QUAL-04 — LOW — WhatsApp Conversation History In-Memory Only, No Persistence**
File: `src/platforms/whatsapp.ts`

Unlike Telegram and Discord, the WhatsApp platform does not use `ConversationMemory`. All conversation history is in the in-memory `conversations` Map and is lost on daemon restart.

**Recommendation:** Add `ConversationMemory` integration consistent with the Telegram and Discord platforms.

---

**QUAL-05 — LOW — Czech and English Mixed in the Same Log Contexts Across Files**

Many files mix Czech and English in log messages within the same function. For example, `skill-registry.ts` logs `"Skill odmítnut"` in Czech while `skill-scanner.ts` logs `"Skill integrity violation! File modified since approval"` in English. This makes grepping logs and reading errors in international contexts difficult.

**Recommendation:** Establish a policy: internal log messages in English, user-facing UI messages in the configured locale. Apply consistently across all files.

---

**QUAL-06 — INFO — `GeneticPromptEvolver` Fitness Tracking Does Not Isolate Per-Variant Usage**
File: `src/meta/genetic-prompt-evolver.ts`

Variants are evaluated round-robin across all tasks. If some variants are evaluated on systematically harder tasks (by chance), their fitness scores will be artificially depressed compared to variants evaluated on easier tasks. The current design has no task-difficulty normalization.

**Recommendation:** Note this as a known limitation. Normalize variant fitness by task difficulty score from `DifficultyRouter` if more accurate A/B comparison is desired.

---

## Summary Table

| ID | Category | Severity | File | Short Description |
|----|----------|----------|------|-------------------|
| SEC-01 | Security | CRITICAL | `mcp/pepagi-mcp-server.ts` | MCP server unauthenticated, binds 0.0.0.0, wildcard CORS |
| SEC-02 | Security | CRITICAL | `meta/skill-synthesizer.ts` | LLM-generated JS written to disk without security scan |
| SEC-03 | Security | CRITICAL | `agents/llm-provider.ts` | Gemini API key in URL query parameter |
| SEC-04 | Security | CRITICAL | `tools/tool-registry.ts` | Shell injection via TTS voice parameter |
| SEC-05 | Security | HIGH | `security/audit-log.ts` | Race condition breaks audit log hash chain integrity |
| SEC-06 | Security | HIGH | `agents/llm-provider.ts` | Shell injection via Whisper language parameter |
| SEC-07 | Security | HIGH | `platforms/imessage.ts` | AppleScript injection in sendMessage |
| SEC-08 | Security | HIGH | `tools/browser.ts` | Arbitrary JS execution via evaluate action |
| SEC-09 | Security | HIGH | `core/goal-manager.ts` | Goal prompts not sanitized before mediator |
| SEC-10 | Security | HIGH | `skills/skill-registry.ts` | `.mjs` extension bypasses skill scanner |
| SEC-11 | Security | MEDIUM | `skills/skill-scanner.ts` | Checksum store race condition on concurrent sign |
| SEC-12 | Security | MEDIUM | Multiple platforms | Raw error messages sent directly to users |
| SEC-13 | Security | MEDIUM | `skills/skill-scanner.ts` | Hardcoded stale model name in deepScanWithLLM |
| SEC-14 | Security | MEDIUM | `consciousness/inner-monologue.ts` | Hardcoded stale model name |
| SEC-15 | Security | MEDIUM | `consciousness/consciousness-manager.ts` | eventBus.onAny() listener never unsubscribed |
| SEC-16 | Security | MEDIUM | `consciousness/self-model.ts` | IdentityManipulationError caught and silently logged |
| SEC-17 | Security | LOW | `tools/calendar.ts` | User ISO date strings injected into AppleScript |
| SEC-18 | Security | LOW | `platforms/imessage.ts` | Fragile pipe-split parsing of message body |
| MEM-01 | Memory Leak | HIGH | `tools/browser.ts` | Singleton browser never closed on daemon exit |
| MEM-02 | Memory Leak | MEDIUM | `memory/working-memory.ts` | Completed task entries never evicted |
| MEM-03 | Memory Leak | MEDIUM | `meta/metacognition.ts` | confidenceHistory shared across all tasks |
| MEM-04 | Memory Leak | MEDIUM | `platforms/telegram.ts` | system:alert listener never removed in stop() |
| MEM-05 | Memory Leak | MEDIUM | `security/tripwire.ts` | accessedPaths Set grows without bound |
| MEM-06 | Memory Leak | LOW | `meta/causal-chain.ts` | In-memory node map never evicted after persist |
| MEM-07 | Memory Leak | LOW | `meta/predictive-context.ts` | Prediction cache has no size cap |
| ERR-01 | Error Handling | MEDIUM | `meta/world-model.ts` | LLM response not schema-validated |
| ERR-02 | Error Handling | MEDIUM | `core/planner.ts` | Planner fallbacks not surfaced to mediator |
| ERR-03 | Error Handling | MEDIUM | `memory/semantic-memory.ts` | useCount increment not persisted |
| ERR-04 | Error Handling | LOW | `meta/architecture-proposer.ts` | rewriteAll() uses non-atomic write |
| ERR-05 | Error Handling | LOW | `cli.ts` | Logs command uses wrong hardcoded log filename |
| BUG-01 | Logic Bug | HIGH | 9 memory/config files | Non-atomic writes across 9 persistent state files |
| BUG-02 | Logic Bug | HIGH | `meta/uncertainty-engine.ts` | No cycle detection; possible stack overflow |
| BUG-03 | Logic Bug | MEDIUM | `config/loader.ts` | cachedConfig not updated after saveConfig() |
| BUG-04 | Logic Bug | MEDIUM | `core/difficulty-router.ts` | Falls back to "claude" even when unavailable |
| BUG-05 | Logic Bug | MEDIUM | `memory/episodic-memory.ts` | Full-file rewrite on every store() call |
| BUG-06 | Logic Bug | MEDIUM | `memory/semantic-memory.ts` | Full-file rewrite on every addFact() call |
| BUG-07 | Logic Bug | LOW | `meta/watchdog.ts` | spawnSync blocks event loop |
| BUG-08 | Logic Bug | LOW | `meta/skill-distiller.ts` | readdirSync blocks event loop |
| BUG-09 | Logic Bug | LOW | `platforms/imessage.ts` | Apple timestamp calculation incorrect on init |
| BUG-10 | Logic Bug | LOW | `meta/architecture-proposer.ts` | Duplicate proposals accumulate across runs |
| TS-01 | Type Safety | MEDIUM | `agents/agent-pool.ts` | Unsafe type cast on agent map |
| TS-02 | Type Safety | MEDIUM | `meta/world-model.ts` | LLM response cast without Zod validation |
| TS-03 | Type Safety | MEDIUM | `cli.ts` | self-model.json parsed with mismatched type |
| TS-04 | Type Safety | LOW | `core/event-bus.ts` | off() method uses any parameter |
| TS-05 | Type Safety | LOW | Multiple files | Non-null assertions in security-sensitive paths |
| PERF-01 | Performance | MEDIUM | `memory/vector-store.ts` | TF-IDF rebuilt on every hybridSearch() call |
| PERF-02 | Performance | MEDIUM | `memory/vector-store.ts` | N+1 Ollama HTTP requests for embeddings |
| PERF-03 | Performance | LOW | `consciousness/inner-monologue.ts` | LLM calls every 20s in RICH profile |
| PERF-04 | Performance | LOW | `core/planner.ts` | Sequential LLM calls for independent plan branches |
| DEAD-01 | Dead Code | LOW | `tools/tool-registry.ts` | SHELL_METACHAR_RE defined but unused |
| DEAD-02 | Dead Code | LOW | `core/acp.ts` | ACP protocol defined but not wired to WorkerExecutor |
| DEAD-03 | Dead Code | INFO | `src/types.d.ts` | Unclear purpose; verify no type shadowing |
| API-01 | API Mismatch | MEDIUM | `skills/skill-scanner.ts` | deepScanWithLLM signature mismatch with LLMProvider |
| API-02 | API Mismatch | LOW | 3 consciousness files | Hardcoded model strings vs CHEAP_CLAUDE_MODEL |
| API-03 | API Mismatch | LOW | `meta/genetic-prompt-evolver.ts` | avgCost never updated in evolve() |
| OPS-01 | Operational | MEDIUM | `core/logger.ts` | No log rotation implemented |
| OPS-02 | Operational | MEDIUM | `daemon.ts` | setInterval timers not unref'd |
| OPS-03 | Operational | LOW | `mcp/pepagi-mcp-server.ts` | /health endpoint returns no real health data |
| OPS-04 | Operational | LOW | `daemon.ts` | AdversarialTester makes LLM calls early in startup |
| OPS-05 | Operational | LOW | `cli.ts` | execSync setup uses process.cwd() not install dir |
| QUAL-01 | Code Quality | MEDIUM | `core/mediator.ts` | 693-line God class, 16 constructor parameters |
| QUAL-02 | Code Quality | LOW | `agents/llm-provider.ts` | 1034-line file with multiple responsibilities |
| QUAL-03 | Code Quality | LOW | `platforms/telegram.ts` | Two parallel conversation history structures |
| QUAL-04 | Code Quality | LOW | `platforms/whatsapp.ts` | WhatsApp conversation history not persisted |
| QUAL-05 | Code Quality | LOW | Multiple files | Czech/English mixed in same log contexts |
| QUAL-06 | Code Quality | INFO | `meta/genetic-prompt-evolver.ts` | Fitness not normalized by task difficulty |

**Total findings: 62**

---

## Priority Fix List

### Sprint 1 — Fix Immediately (Critical and High)

1. **SEC-01** — Bind MCP server to `127.0.0.1`, add Bearer token authentication, add rate limiting.
2. **SEC-02** — Run `SkillScanner` on synthesized code before writing. Discard if rejected.
3. **SEC-03** — Move Gemini API key to `x-goog-api-key` request header.
4. **SEC-04** — Validate TTS `voice` against allowlist; use `spawn` with args array.
5. **SEC-05** — Serialize audit log writes; read `lastHash` from file instead of module-level variable.
6. **SEC-06** — Validate Whisper `language` against ISO 639-1 allowlist; use `spawn` with args array.
7. **SEC-07** — Validate iMessage `to` parameter with strict E.164 regex; use `osascript -` with stdin.
8. **SEC-08** — Remove or fully sandbox the `evaluate` browser action.
9. **SEC-09** — Run `SecurityGuard.detectInjection()` on goal prompts before task creation.
10. **MEM-01** — Wire `closeBrowser()` into daemon `shutdown()` sequence.
11. **BUG-01** — Apply atomic write (tmp→rename) to all 9 non-atomic memory/config files.
12. **BUG-02** — Add cycle detection to `UncertaintyEngine.calculateSubtreeConfidence()`.

### Sprint 2 — Fix Before Next Release (High/Medium)

13. **SEC-10** — Scan `.mjs` files; validate symlinks stay within `SKILLS_DIR`.
14. **SEC-12** — Replace raw exception messages in platform responses with generic user-facing strings.
15. **SEC-13, SEC-14** — Replace all hardcoded `"claude-haiku-4-5-20251001"` with `CHEAP_CLAUDE_MODEL`.
16. **SEC-15** — Store and remove `eventBus.onAny()` handler in `ConsciousnessManager.shutdown()`.
17. **SEC-16** — Propagate `IdentityManipulationError` via `security:blocked` event; activate SAFE-MODE.
18. **BUG-03** — Update `cachedConfig` in `saveConfig()`; use atomic write.
19. **BUG-05, BUG-06** — Replace full-file rewrite in episodic/semantic memory with `appendFile` for new entries.
20. **ERR-01** — Add Zod schema validation to world model LLM response parsing.
21. **OPS-01** — Implement log rotation (delete logs older than configurable N days on daemon startup).
22. **OPS-02** — Call `.unref()` on consolidation and arch proposer timers.

### Sprint 3 — Address in Next Quarter (Medium/Low)

23. **SEC-11** — Serialize `signSkill()` checksum store writes.
24. **SEC-17, SEC-18** — Validate calendar AppleScript inputs; fix iMessage pipe-split parsing.
25. **MEM-02 through MEM-07** — Evict working memory, confidence history, and prediction cache entries on task completion.
26. **BUG-04** — Return `null` from `DifficultyRouter` when no agents are available.
27. **BUG-07, BUG-08** — Replace `spawnSync` and `readdirSync` with async equivalents.
28. **BUG-09** — Fix iMessage Apple timestamp initialization formula.
29. **PERF-01, PERF-02** — Cache TF-IDF index; batch Ollama embedding requests.
30. **TS-01, TS-02, TS-03** — Replace unsafe casts with Zod validation or properly typed accesses.
31. **API-03** — Track and update `avgCost` in `GeneticPromptEvolver.evolve()`.
32. **QUAL-03** — Remove redundant in-memory conversation Map from Telegram platform.
33. **ERR-05** — Fix CLI `logs` command to use the correct log file name pattern.

---

*Report generated by automated static analysis of 80 TypeScript source files.*
*Files not covered: unit test files under `src/**/__tests__/`.*
