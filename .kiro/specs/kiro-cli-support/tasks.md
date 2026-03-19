# Implementation Plan: Kiro CLI Support as LLM Provider

## Overview

Add Kiro CLI as a new LLM provider to PEPAGI using the Agent Client Protocol (ACP) over stdin/stdout JSON-RPC 2.0. The implementation builds incrementally: types and config first, then the ACP subprocess simulator (so tests can use it), then the core provider logic, then integration wiring, and finally the test suite.

## Tasks

- [x] 1. Add "kiro" to AgentProvider type and add Kiro pricing entry
  - [x] 1.1 Extend AgentProvider union type in `src/core/types.ts`
    - Add `"kiro"` to the `AgentProvider` type union
    - _Requirements: 1.1, 1.2_
  - [x] 1.2 Add Kiro pricing entry in `src/agents/pricing.ts`
    - Add `"kiro"` to the `ModelPricing.provider` union
    - Add zero-cost pricing entry: `{ model: "auto", provider: "kiro", inputCostPer1M: 0, outputCostPer1M: 0, contextWindow: 200_000, supportsTools: true }`
    - _Requirements: 8.2_

- [x] 2. Add Kiro configuration schema to config loader
  - [x] 2.1 Define KiroAgentConfigSchema in `src/config/loader.ts`
    - Create dedicated Zod schema with fields: `enabled` (boolean, default false), `model` (string, default "auto"), `agent` (string, default ""), `timeout` (number, default 120), `forwardMcpServers` (array of MCP server objects, default [])
    - Schema must NOT include apiKey, temperature, maxOutputTokens, or maxAgenticTurns
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 15.1_
  - [x] 2.2 Add `kiro` key to agents config object in PepagiConfigSchema
    - Add as optional field using KiroAgentConfigSchema
    - Add KIRO_CLI_ENABLED env var overlay in loadConfig()
    - Add default kiro agent entry in the pre-populate block
    - _Requirements: 7.6, 7.7_
  - [ ]* 2.3 Write unit tests for Kiro config schema
    - Test schema rejects apiKey field
    - Test default values (enabled=false, model="auto", timeout=120)
    - Test KIRO_CLI_ENABLED env var overlay
    - Test forwardMcpServers validation
    - **Property 8: Config Schema Validation Round-Trip**
    - **Validates: Requirements 7.1, 7.2**

- [ ] 3. Build ACP subprocess simulator (Layer 1 testing infrastructure)
  - [ ] 3.1 Create `src/agents/__tests__/acp-simulator.ts`
    - Standalone TypeScript script that reads JSON-RPC 2.0 from stdin and writes ACP responses to stdout
    - Scenario-driven via ACP_SCENARIO env var
    - Implement all 11 scenarios: happy-path, happy-no-usage, error-on-session-new, error-on-prompt, hang-on-initialize, crash-mid-stream, malformed-json, slow-chunks, partial-lines, sigterm-graceful, sigterm-ignore
    - Read ACP_MODEL, ACP_AGENT, ACP_MCP_SERVERS env vars to validate spawn arguments
    - Must be compilable to JS and spawnable via `node`
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4_

- [ ] 4. Checkpoint — Verify simulator compiles and types/config are correct
  - Ensure `npm run build` succeeds with the new types, config schema, and simulator
  - Ensure all existing tests still pass (`npm test`)
  - Ask the user if questions arise.

- [ ] 5. Implement KiroCircuitBreaker and ACP helpers in `src/agents/llm-provider.ts`
  - [ ] 5.1 Add KiroCircuitBreaker class
    - Follow exact same pattern as ClaudeCodeCircuitBreaker (THRESHOLD=10, RESET_TIMEOUT=300_000, WINDOW=600_000)
    - Emit system:alert events on state transitions (closed→open, open→half-open, half-open→closed)
    - Export singleton `kiroCircuitBreaker`
    - _Requirements: 9.1, 9.2, 9.3, 16.1, 16.2, 16.3_
  - [ ] 5.2 Add ACP JSON-RPC helper functions
    - `acpRequest(id, method, params)` — builds JSON-RPC 2.0 request string
    - `ACPMessage` interface for parsing responses/notifications
    - _Requirements: 2.2, 3.1, 3.2_
  - [ ]* 5.3 Write property test for circuit breaker state machine
    - **Property 11: Circuit Breaker State Machine**
    - Use fast-check to generate random sequences of success/failure outcomes
    - Verify state transitions: closed→open after THRESHOLD failures, open→half-open after RESET_TIMEOUT, half-open→closed on success, half-open→open on failure
    - Verify system:alert events emitted on each transition
    - **Validates: Requirements 9.2, 9.3, 16.1, 16.2, 16.3**

- [ ] 6. Implement callKiro() core provider function
  - [ ] 6.1 Implement callKiro() in `src/agents/llm-provider.ts`
    - Spawn `kiro-cli acp` subprocess with stdio pipes
    - Perform ACP handshake: initialize → session/new → (optional session/set_model) → session/set_mode → session/prompt
    - Parse streaming JSONL notifications: AgentMessageChunk, ToolCall, usage_update, TurnEnd
    - Accumulate text content, track tool calls, extract usage data
    - Handle subprocess errors (ENOENT, non-zero exit, stderr)
    - Support AbortController (SIGTERM → SIGKILL escalation after 5s)
    - Support timeout (from opts.timeoutMs or kiroConfig.timeout)
    - Emit eventBus events: mediator:thinking, tool:call
    - Return standard LLMResponse with content, toolCalls, usage, cost, model, latencyMs
    - Wrap in kiroCircuitBreaker.call()
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 10.1, 10.2, 10.3, 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 14.1, 14.2, 14.3, 14.4, 14.5, 15.2, 15.3, 15.4_
  - [ ] 6.2 Implement checkKiroHealth() function
    - Spawn `kiro-cli acp`, send initialize, return true if response within 5s
    - Return false on ENOENT or timeout
    - Export the function
    - _Requirements: 11.1, 11.2, 11.3_
  - [ ] 6.3 Add "kiro" case to LLMProvider.call() routing switch
    - Load kiro config from PepagiConfig and pass to callKiro()
    - Existing withRetry wrapper applies automatically
    - _Requirements: 6.1, 6.2_

- [ ] 7. Integrate Kiro into Agent Pool and Difficulty Router
  - [ ] 7.1 Add Kiro to agent definitions in `src/agents/agent-pool.ts`
    - Add `{ provider: "kiro", displayName: "Kiro CLI (ACP)", defaultModel: "auto" }` to agentDefs
    - Use dedicated config schema (no apiKey check), availability based on enabled flag
    - Import and call checkKiroHealth() in probeLocalModels()
    - _Requirements: 7.6, 9.1_
  - [ ] 7.2 Add Kiro to fallback chain and routing in `src/core/difficulty-router.ts`
    - Add `"kiro"` to the fallback chain order in getFallbackChain()
    - Treat Kiro as zero-cost local provider (like Ollama) for trivial/simple tasks
    - _Requirements: 8.1, 8.2_

- [ ] 8. Checkpoint — Verify full build and existing tests pass
  - Ensure `npm run build` succeeds with all new code
  - Ensure all existing tests still pass (`npm test`)
  - Ask the user if questions arise.

- [ ] 9. Write provider tests using ACP simulator
  - [ ] 9.1 Create `src/agents/__tests__/kiro-provider.test.ts` with unit tests
    - Test happy-path: spawn simulator, verify LLMResponse has correct content, toolCalls, usage, cost, latencyMs
    - Test happy-no-usage: verify fallback estimation (chars/4, cost=0)
    - Test error-on-session-new: verify LLMProviderError thrown
    - Test error-on-prompt: verify LLMProviderError thrown
    - Test hang-on-initialize: verify 10s timeout and subprocess cleanup
    - Test crash-mid-stream: verify error handling and subprocess cleanup
    - Test malformed-json: verify parser resilience (valid data still extracted)
    - Test partial-lines: verify line buffer reassembly
    - Test kiro-cli not found: mock spawn ENOENT, verify LLMProviderError
    - Test abort signal: simulator scenario sigterm-graceful
    - Test SIGKILL escalation: simulator scenario sigterm-ignore
    - Test health check healthy: simulator happy-path
    - Test health check unhealthy: mock spawn ENOENT
    - Test LLMProvider routing: verify "kiro" case routes to callKiro
    - Test circuit breaker is separate instance from claudeCircuitBreaker
    - Test agent pool availability: kiro enabled → available, disabled → not available
    - Test usage data from ACP response (happy-path with usage)
    - Test cost from usage_update notification
    - _Requirements: 2.1–2.5, 3.1–3.5, 4.1–4.5, 5.1–5.6, 6.1, 6.2, 9.1–9.3, 10.1–10.3, 11.1–11.3, 14.1–14.4_
  - [ ]* 9.2 Write property test: ACP Protocol Message Ordering
    - **Property 1: ACP Protocol Message Ordering**
    - Spawn simulator, capture stdin writes, verify sequence: initialize → session/new → (optional set_model) → session/set_mode → session/prompt
    - Use fast-check to generate random LLMCallOptions + KiroAgentConfig (model: "auto" vs specific)
    - **Validates: Requirements 2.2, 3.1, 3.2, 3.5**
  - [ ]* 9.3 Write property test: Prompt Construction Completeness
    - **Property 3: Prompt Construction Completeness**
    - Verify prompt sent to simulator contains full systemPrompt and all message contents
    - Use fast-check to generate random systemPrompt + random message arrays
    - **Validates: Requirements 3.3**
  - [ ]* 9.4 Write property test: JSONL Parsing Round-Trip
    - **Property 4: JSONL Notification Parsing Round-Trip**
    - Serialize random JSON-RPC message objects to newline-delimited JSON, feed through parser, verify equivalence
    - **Validates: Requirements 4.1**
  - [ ]* 9.5 Write property test: AgentMessageChunk Accumulation
    - **Property 5: AgentMessageChunk Accumulation**
    - Feed random arrays of text chunks via simulator, verify LLMResponse.content equals concatenation
    - **Validates: Requirements 4.2, 4.4, 5.1**
  - [ ]* 9.6 Write property test: ToolCall Notification Mapping
    - **Property 6: ToolCall Notification Mapping**
    - Feed random ToolCall notification sequences via simulator, verify LLMResponse.toolCalls matches
    - **Validates: Requirements 4.3, 5.2**
  - [ ]* 9.7 Write property test: Token Usage Estimation Fallback
    - **Property 7: Token Usage Estimation Fallback**
    - Generate random prompt/response strings, verify chars/4 calculation and cost=0
    - **Validates: Requirements 5.3, 5.4, 14.4**
  - [ ]* 9.8 Write property test: Spawn Arguments from Agent Config
    - **Property 12: Spawn Arguments from Config**
    - Generate random agent name strings (empty and non-empty), verify spawn args via simulator env capture
    - **Validates: Requirements 12.1, 12.2**
  - [ ]* 9.9 Write property test: Session Mode Mapping
    - **Property 13: Session Mode Mapping**
    - Generate random boolean agenticMode values, verify mode string via simulator stdin capture
    - **Validates: Requirements 13.1, 13.2**
  - [ ]* 9.10 Write property test: MCP Server Forwarding
    - **Property 15: MCP Server Forwarding**
    - Generate random MCP server config arrays, verify session/new params via simulator stdin capture
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**

- [ ] 10. Add Layer 2 integration smoke test
  - [ ]* 10.1 Add integration smoke test in `src/agents/__tests__/kiro-provider.test.ts`
    - Gated behind `KIRO_CLI_AVAILABLE=true` env var using `describe.skipIf`
    - Spawn actual `kiro-cli acp`, send trivial prompt in read-only mode
    - Verify: initialize response received, session created, TurnEnd received, LLMResponse has non-empty content
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 4.4, 5.1_

- [ ] 11. Final checkpoint — Ensure all tests pass
  - Run `npm run build` and `npm test`
  - Verify no regressions in existing test suites
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The ACP simulator (task 3) is built early so all subsequent tests can spawn it as a real subprocess
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Layer 2 integration test requires real Kiro CLI installed — not run in CI by default
