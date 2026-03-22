# Requirements Document

## Introduction

Add Kiro CLI as a new LLM provider for PEPAGI, alongside the existing Claude, GPT, Gemini, Ollama, and LM Studio providers. Kiro CLI implements the Agent Client Protocol (ACP) — an open standard for agent-editor communication over stdin/stdout using JSON-RPC 2.0. The Kiro_Provider will spawn `kiro-cli acp` as a subprocess, communicate via the ACP protocol (initialize → session/new → session/prompt), parse streaming `session/update` notifications (agent_message_chunk, tool_call, usage_update) and the final prompt response (with `stopReason`), and return results in the standard `LLMResponse` format. Kiro has built-in agentic tools, making it a natural fit for both text-only and agentic task execution within the PEPAGI multi-agent orchestration system.

## Glossary

- **Kiro_Provider**: The provider function (`callKiro`) that spawns `kiro-cli acp` as a subprocess and communicates via the ACP JSON-RPC 2.0 protocol to execute LLM tasks, returning a standard `LLMResponse`.
- **ACP**: Agent Client Protocol — an open standard for agent-editor communication over stdin/stdout using JSON-RPC 2.0 messages. Core methods: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`.
- **LLM_Provider**: The `LLMProvider` class that routes calls to provider-specific functions (callClaude, callGPT, callGemini, callOllama, callLMStudio, and now callKiro) based on `opts.provider`.
- **LLMCallOptions**: The standard input interface for all provider calls, containing provider, model, systemPrompt, messages, agenticMode, taskId, abortController, timeoutMs, and other execution parameters.
- **LLMResponse**: The standard output interface returned by all providers, containing content, toolCalls, usage (inputTokens, outputTokens), cost, model, and latencyMs.
- **AgentProvider**: The union type (`"claude" | "gpt" | "gemini" | "ollama" | "lmstudio"`) that identifies which LLM backend to use. This feature extends it with `"kiro"`.
- **Config_Loader**: The PEPAGI configuration system that reads `~/.pepagi/config.json` and environment variables, validates with Zod schemas, and provides typed `PepagiConfig` objects. The Kiro agent config uses a dedicated schema (enabled, model, agent, timeout) rather than the standard AgentConfigSchema, since Kiro CLI manages its own authentication and model parameters internally.
- **Difficulty_Router**: The component that estimates task difficulty and selects the optimal agent provider based on historical performance profiles and task characteristics.
- **Circuit_Breaker**: The failure-tracking mechanism (as used for Claude Code CLI) that opens after repeated failures to prevent retry storms, with half-open probe recovery.
- **Event_Bus**: The singleton event emitter (`eventBus`) used for inter-component progress reporting during agentic execution.
- **JSON_RPC_Message**: A JSON-RPC 2.0 message object with fields: `jsonrpc` ("2.0"), `method` (string), `params` (object), `id` (number for requests), and optionally `result` or `error` for responses.
- **ACP_Session_Update**: A JSON-RPC 2.0 notification sent by Kiro CLI during session execution, with method `session/update` and params containing an `update` object. The `update.sessionUpdate` field is the discriminator, with values: `agent_message_chunk` (text content at `update.content.text`), `tool_call` (tool invocation), `tool_call_update` (tool progress), `usage_update` (token/cost data). There is no `TurnEnd` notification — turn completion is signaled by the `session/prompt` response arriving with a `stopReason` field.
- **ACP_Session_Mode**: The execution mode for a Kiro ACP session. Modes are agent-specific (e.g., `"kiro_default"`, `"kiro_planner"`, `"rob"`) and returned in the `session/new` response under `modes.availableModes`. The `session/set_mode` method takes `sessionId` and `modeId` parameters. There are no generic "read-only"/"full-access" modes — the provider must select from the available modes returned by the session.
- **ACP_Usage_Update**: A `session/update` notification with `sessionUpdate: "usage_update"` containing context window state (`used` tokens, `size` total) and optional cumulative `cost` object. Defined in the ACP draft RFD "Session Usage and Context Status" (https://agentclientprotocol.com/rfds/session-usage). The RFD also specifies a `usage` field in `PromptResponse` with per-turn token counts (`total_tokens`, `input_tokens`, `output_tokens`, `thought_tokens`, `cached_read_tokens`, `cached_write_tokens`).
- **MCP_Server_Config**: A JSON object describing an MCP server to forward to Kiro via the `session/new` ACP method, with fields: `name`, `command`, `args`, `env`. Uses the ACP stdio transport schema.

## Requirements

### Requirement 1: AgentProvider Type Extension

**User Story:** As a PEPAGI developer, I want `"kiro"` added to the `AgentProvider` union type, so that the type system recognizes Kiro as a valid LLM provider throughout the codebase.

#### Acceptance Criteria

1. THE AgentProvider type SHALL include `"kiro"` as a valid member alongside `"claude"`, `"gpt"`, `"gemini"`, `"ollama"`, and `"lmstudio"`.
2. THE LLMCallOptions `provider` field SHALL accept `"kiro"` as a valid value.

### Requirement 2: ACP Subprocess Lifecycle

**User Story:** As a PEPAGI developer, I want the Kiro provider to spawn and manage a `kiro-cli acp` subprocess, so that PEPAGI can communicate with Kiro using the ACP protocol over stdin/stdout.

#### Acceptance Criteria

1. WHEN `callKiro` is invoked, THE Kiro_Provider SHALL spawn `kiro-cli` with the `acp` argument as a child process with stdio pipes (stdin, stdout, stderr). WHEN a non-default model is configured (i.e. `agents.kiro.model` is not `"auto"`), THE Kiro_Provider SHALL include `--model <model>` in the spawn arguments.
2. WHEN the subprocess is spawned, THE Kiro_Provider SHALL send a JSON-RPC 2.0 `initialize` request with `protocolVersion: 1` (integer) and wait for a successful response before proceeding.
3. IF the `kiro-cli` binary is not found on the system PATH, THEN THE Kiro_Provider SHALL throw an LLMProviderError with a descriptive message indicating that Kiro CLI is not installed.
4. IF the `initialize` request fails or times out after 10 seconds, THEN THE Kiro_Provider SHALL kill the subprocess and throw an LLMProviderError indicating initialization failure.
5. WHEN the LLM call completes or fails, THE Kiro_Provider SHALL terminate the subprocess and release all associated resources (stdin, stdout, stderr listeners).

### Requirement 3: ACP Session Management

**User Story:** As a PEPAGI developer, I want the Kiro provider to create ACP sessions and send prompts, so that tasks are executed through the standard ACP session lifecycle.

#### Acceptance Criteria

1. WHEN the ACP connection is initialized, THE Kiro_Provider SHALL send a `session/new` request with a `cwd` parameter set to the current working directory (absolute path) to create a new session for each LLM call.
2. WHEN a session is created, THE Kiro_Provider SHALL send a `session/prompt` request containing the user prompt as an array of content blocks (`[{type: "text", text: "..."}]`), constructed from the LLMCallOptions messages array.
3. THE Kiro_Provider SHALL construct the prompt content blocks by prepending the system prompt as the first text block, followed by each message content as a separate text block.
4. IF the `session/new` request returns an error, THEN THE Kiro_Provider SHALL throw an LLMProviderError with the error details from the JSON-RPC response.

### Requirement 4: ACP Streaming Event Parsing

**User Story:** As a PEPAGI developer, I want the Kiro provider to parse ACP session notification events in real-time, so that progress is reported to the Event_Bus during execution and the final result is captured.

#### Acceptance Criteria

1. WHILE the session is active, THE Kiro_Provider SHALL read newline-delimited JSON-RPC 2.0 messages from the subprocess stdout and parse each as a `session/update` notification, using `params.update.sessionUpdate` as the discriminator.
2. WHEN a `session/update` notification with `sessionUpdate: "agent_message_chunk"` is received, THE Kiro_Provider SHALL accumulate the text content from `params.update.content.text` for the final response and emit a `mediator:thinking` event on the Event_Bus with the chunk text (truncated to 200 characters) if a taskId is present.
3. WHEN a `session/update` notification with `sessionUpdate: "tool_call"` is received, THE Kiro_Provider SHALL emit a `tool:call` event on the Event_Bus with the tool name and input summary if a taskId is present.
4. WHEN the `session/prompt` JSON-RPC response is received (matching the request id) with a `stopReason` field, THE Kiro_Provider SHALL treat the session as complete and assemble the final LLMResponse from accumulated content. There is no separate `TurnEnd` notification.
5. IF a JSON-RPC 2.0 error response is received for the `session/prompt` request, THEN THE Kiro_Provider SHALL throw an LLMProviderError with the error message and code.
6. THE Kiro_Provider SHALL silently ignore any Kiro-specific extension notifications (e.g., `_kiro.dev/mcp/server_initialized`, `_kiro.dev/commands/available`, `_kiro.dev/metadata`) received during session setup.

### Requirement 5: LLMResponse Construction

**User Story:** As a PEPAGI developer, I want the Kiro provider to return a standard LLMResponse, so that the rest of the PEPAGI system can process Kiro results identically to other providers.

#### Acceptance Criteria

1. THE Kiro_Provider SHALL return an LLMResponse with the `content` field set to the accumulated text from all `agent_message_chunk` session/update notifications.
2. THE Kiro_Provider SHALL return an LLMResponse with the `toolCalls` field populated from `tool_call` session/update notifications received during the session.
3. IF the ACP response does not include token usage data, THE Kiro_Provider SHALL estimate usage.inputTokens as the prompt character count divided by 4, and usage.outputTokens as the response character count divided by 4.
4. IF the ACP response does not include cost data, THE Kiro_Provider SHALL set cost to 0.
5. THE Kiro_Provider SHALL return an LLMResponse with `model` set to the model string from the LLMCallOptions.
6. THE Kiro_Provider SHALL return an LLMResponse with `latencyMs` measured from the start of the `callKiro` invocation to the receipt of the `session/prompt` response (with `stopReason`).

### Requirement 6: LLMProvider Routing Integration

**User Story:** As a PEPAGI developer, I want the LLMProvider.call() method to route `"kiro"` provider requests to callKiro, so that Kiro is usable as a drop-in provider for any PEPAGI task.

#### Acceptance Criteria

1. WHEN `LLMProvider.call()` receives an LLMCallOptions with `provider` set to `"kiro"`, THE LLM_Provider SHALL route the call to the `callKiro` function.
2. THE LLM_Provider SHALL wrap the `callKiro` call with the existing `withRetry` mechanism using `"kiro"` as the provider identifier.

### Requirement 7: Configuration Schema

**User Story:** As a PEPAGI operator, I want to configure the Kiro provider through the standard PEPAGI config system, so that Kiro can be enabled, disabled, and tuned consistently with other providers.

#### Acceptance Criteria

1. THE Config_Loader SHALL include a `kiro` key within the `agents` configuration object, using a dedicated Zod schema with fields: `enabled` (boolean, default `false`), `model` (string, default `"auto"`), `agent` (string, default `""`), and `timeout` (number, default `120`).
2. THE `kiro` agent configuration SHALL NOT include `apiKey`, `maxOutputTokens`, `temperature`, or `maxAgenticTurns` fields, as Kiro CLI manages authentication and model parameters internally.
3. THE `model` field SHALL accept any of the Kiro CLI supported model identifiers: `"auto"`, `"claude-opus-4.6"`, `"claude-opus-4.5"`, `"claude-sonnet-4.6"`, `"claude-sonnet-4.5"`, `"claude-sonnet-4.0"`, `"claude-haiku-4.5"`, `"deepseek-3.2"`, `"minimax-2.5"`, `"minimax-2.1"`, `"qwen3-coder-next"`.
4. THE `agent` field SHALL specify an optional custom agent name corresponding to a Kiro agent configuration in `.kiro/agents/`, with an empty string meaning no custom agent.
5. THE `timeout` field SHALL specify the timeout in seconds for ACP operations, defaulting to 120 seconds.
6. WHEN `agents.kiro.enabled` is `true` in the configuration, THE agent pool SHALL include Kiro as an available provider for task assignment.
7. THE Config_Loader SHALL support enabling Kiro via the `KIRO_CLI_ENABLED=true` environment variable, setting `agents.kiro.enabled` to `true` when detected.

### Requirement 8: Difficulty Router Integration

**User Story:** As a PEPAGI developer, I want the Difficulty_Router to consider Kiro as a candidate provider for task assignment, so that tasks can be routed to Kiro based on performance profiles and availability.

#### Acceptance Criteria

1. WHEN Kiro is enabled and available in the agent pool, THE Difficulty_Router SHALL include `"kiro"` as a candidate when selecting the optimal agent for a task.
2. THE Difficulty_Router SHALL treat Kiro as a local provider (similar to Ollama) with zero API cost when computing the performance score.

### Requirement 9: Circuit Breaker Protection

**User Story:** As a PEPAGI operator, I want the Kiro provider to be protected by a circuit breaker, so that repeated Kiro CLI failures do not cause retry storms or block the task queue.

#### Acceptance Criteria

1. THE Kiro_Provider SHALL use a dedicated Circuit_Breaker instance (separate from the Claude Code circuit breaker) to track failures.
2. WHEN the Kiro circuit breaker is in the "open" state, THE Kiro_Provider SHALL throw a non-retryable LLMProviderError indicating that Kiro CLI is unavailable and the circuit breaker is open.
3. WHEN the circuit breaker reset timeout elapses, THE Kiro_Provider SHALL transition to "half-open" state and allow one probe call to test recovery.

### Requirement 10: Abort and Timeout Support

**User Story:** As a PEPAGI developer, I want the Kiro provider to support abort signals and timeouts, so that long-running or stuck Kiro sessions can be cancelled cleanly.

#### Acceptance Criteria

1. WHEN an AbortController signal is triggered during a Kiro session, THE Kiro_Provider SHALL send a `session/cancel` JSON-RPC request to the subprocess, then kill the process with SIGTERM.
2. IF the subprocess does not exit within 5 seconds after SIGTERM, THEN THE Kiro_Provider SHALL escalate to SIGKILL.
3. WHEN a timeout (from LLMCallOptions.timeoutMs or a default of 120 seconds) elapses, THE Kiro_Provider SHALL kill the subprocess and throw an LLMProviderError indicating a timeout.

### Requirement 11: Health Check

**User Story:** As a PEPAGI developer, I want a health check function for Kiro CLI, so that the system can verify Kiro availability before attempting to use it as a provider.

#### Acceptance Criteria

1. THE Kiro_Provider module SHALL export a `checkKiroHealth` function that returns a Promise resolving to a boolean.
2. WHEN `checkKiroHealth` is called, THE function SHALL spawn `kiro-cli acp`, send an `initialize` request, and return `true` if a valid response is received within 5 seconds.
3. IF the `kiro-cli` binary is not found or the initialize request fails, THEN `checkKiroHealth` SHALL return `false`.


### Requirement 12: Custom Agent Passthrough

**User Story:** As a PEPAGI operator, I want to specify a custom Kiro agent via configuration, so that PEPAGI can use specialized Kiro agents (e.g., a security auditor agent, a code reviewer agent) with scoped tools, prompts, and MCP servers.

#### Acceptance Criteria

1. WHEN `agents.kiro.agent` is set to a non-empty string in the configuration, THE Kiro_Provider SHALL spawn `kiro-cli` with arguments `["acp", "--agent", "<agent_name>"]` (plus `--model <model>` if model != "auto").
2. WHEN `agents.kiro.agent` is empty or absent, THE Kiro_Provider SHALL spawn `kiro-cli` with arguments `["acp"]` only (plus `--model <model>` if model != "auto").
3. THE Kiro_Provider SHALL log the agent name being used at INFO level when a custom agent is configured.

### Requirement 13: Session Mode Passthrough

**User Story:** As a PEPAGI developer, I want the Kiro provider to optionally set the ACP session mode based on available modes, so that the session uses an appropriate mode when one is available.

#### Acceptance Criteria

1. WHEN the `session/new` response includes `modes.availableModes`, THE Kiro_Provider SHALL store the available modes and the `currentModeId` for potential mode selection.
2. WHEN `agenticMode` is `true` and the available modes include a mode whose `id` contains "default" or matches the agent name, THE Kiro_Provider SHALL send a `session/set_mode` JSON-RPC request with `sessionId` and `modeId` set to that mode's `id`.
3. WHEN `agenticMode` is `false` and the available modes include a mode whose `id` contains "planner" or "readonly", THE Kiro_Provider SHALL send a `session/set_mode` with that mode's `id`. If no such mode exists, THE Kiro_Provider SHALL skip the `session/set_mode` call and use the default mode.
4. THE Kiro_Provider SHALL emit a `mediator:thinking` event indicating the session mode being used if a taskId is present.

### Requirement 14: Token Usage and Context Window Tracking

**User Story:** As a PEPAGI developer, I want the Kiro provider to parse ACP usage data and context window updates, so that LLMResponse token counts and costs are accurate instead of rough character-based estimations.

#### Acceptance Criteria

1. WHEN the `session/prompt` response includes a `usage` field, THE Kiro_Provider SHALL use the `input_tokens` and `output_tokens` values for the LLMResponse `usage` field instead of the character-based estimation.
2. WHEN a `session/update` notification with `sessionUpdate: "usage_update"` is received, THE Kiro_Provider SHALL parse the `used` and `size` fields to track context window utilization.
3. WHEN a `usage_update` notification includes a `cost` object, THE Kiro_Provider SHALL use the `cost.amount` value for the LLMResponse `cost` field instead of 0.
4. IF the ACP response does not include usage data (older Kiro CLI versions), THEN THE Kiro_Provider SHALL fall back to the character-based estimation (prompt chars / 4 for input, response chars / 4 for output) and cost of 0.
5. WHEN a `usage_update` notification is received with context window data, THE Kiro_Provider SHALL emit a `mediator:thinking` event with the context utilization percentage (used/size * 100) if a taskId is present.

### Requirement 15: MCP Server Forwarding

**User Story:** As a PEPAGI operator, I want to forward MCP server configurations to Kiro via the ACP session, so that Kiro has access to PEPAGI's tool ecosystem (e.g., the PEPAGI MCP server at port 3099) during task execution.

#### Acceptance Criteria

1. THE Config_Loader SHALL include an optional `forwardMcpServers` array field within the `agents.kiro` configuration, defaulting to an empty array.
2. WHEN `forwardMcpServers` contains one or more MCP server configurations, THE Kiro_Provider SHALL include them in the `mcpServers` parameter of the `session/new` JSON-RPC request.
3. EACH forwarded MCP server configuration SHALL conform to the ACP stdio transport schema with fields: `name` (string), `command` (string), `args` (string array), and `env` (array of `{name, value}` objects).
4. WHEN `forwardMcpServers` is empty or absent, THE Kiro_Provider SHALL send the `session/new` request with an empty `mcpServers` array.

### Requirement 16: Failover Event Emission

**User Story:** As a PEPAGI developer, I want the Kiro circuit breaker to emit explicit events on state transitions, so that the Difficulty_Router and other components can observe failover behavior and skip Kiro when it is unavailable.

#### Acceptance Criteria

1. WHEN the Kiro Circuit_Breaker transitions from "closed" to "open" state, THE Kiro_Provider SHALL emit a `system:alert` event on the Event_Bus with level `"warn"` and a message indicating that Kiro CLI is temporarily unavailable.
2. WHEN the Kiro Circuit_Breaker transitions from "open" to "half-open" state, THE Kiro_Provider SHALL emit a `system:alert` event on the Event_Bus with level `"warn"` and a message indicating that Kiro CLI recovery is being probed.
3. WHEN the Kiro Circuit_Breaker transitions from "half-open" to "closed" state (successful probe), THE Kiro_Provider SHALL emit a `system:alert` event on the Event_Bus with level `"warn"` and a message indicating that Kiro CLI has recovered.
