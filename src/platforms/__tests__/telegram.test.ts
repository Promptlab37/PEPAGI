// ═══════════════════════════════════════════════════════════════
// Tests: TelegramPlatform
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Telegraf mock ─────────────────────────────────────────────
// We intercept all bot.command / bot.on calls and store the handlers
// so we can invoke them directly in tests.

type HandlerFn = (...args: unknown[]) => Promise<void>;

const registeredCommands = new Map<string, HandlerFn>();
const registeredEvents = new Map<string, HandlerFn>();
let errorHandler: ((err: unknown, ctx: unknown) => void) | undefined;
let systemAlertListener: ((ev: unknown) => void) | undefined;
let goalResultListener: ((ev: unknown) => void) | undefined;

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 99 });
const mockEditMessageText = vi.fn().mockResolvedValue(undefined);
const mockDeleteMessage = vi.fn().mockResolvedValue(undefined);
const mockBotLaunch = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn();
const mockBotReply = vi.fn().mockResolvedValue({ message_id: 1 });
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);
const mockGetFile = vi.fn().mockResolvedValue({ file_path: "voice/file.ogg" });
const mockReplyWithVoice = vi.fn().mockResolvedValue(undefined);

vi.mock("telegraf", () => {
  class MockTelegraf {
    telegram = {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      deleteMessage: mockDeleteMessage,
      getFile: mockGetFile,
    };

    command(cmd: string, handler: HandlerFn): void {
      registeredCommands.set(cmd, handler);
    }

    on(event: string | { toString: () => string }, handler: HandlerFn): void {
      const key = typeof event === "string" ? event : String(event);
      registeredEvents.set(key, handler);
    }

    catch(handler: (err: unknown, ctx: unknown) => void): void {
      errorHandler = handler;
    }

    launch = mockBotLaunch;
    stop = mockBotStop;
  }

  return { Telegraf: MockTelegraf };
});

// telegraf/filters mock
vi.mock("telegraf/filters", () => ({
  message: (type: string) => `message:${type}`,
}));

// ── Logger mock ───────────────────────────────────────────────

vi.mock("../../core/logger.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// ── EventBus mock ─────────────────────────────────────────────

vi.mock("../../core/event-bus.js", () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn().mockImplementation((type: string, handler: (ev: unknown) => void) => {
      // goal_result is still registered via on()
      if (type === "system:goal_result") goalResultListener = handler;
    }),
    // MEM-04: system:alert is now registered via onAny so the reference can be removed in stop()
    onAny: vi.fn().mockImplementation((handler: (ev: unknown) => void) => {
      systemAlertListener = handler;
    }),
    off: vi.fn(),
    offAny: vi.fn(),
  },
}));

// ── ConversationMemory mock ───────────────────────────────────

const mockConversationMemoryInit = vi.fn().mockResolvedValue(undefined);
const mockConversationMemoryAddTurn = vi.fn().mockResolvedValue(undefined);
const mockConversationMemoryClearHistory = vi.fn().mockResolvedValue(undefined);
const mockConversationMemoryGetContext = vi.fn().mockResolvedValue("");

vi.mock("../../memory/conversation-memory.js", () => ({
  ConversationMemory: vi.fn().mockImplementation(() => ({
    init: mockConversationMemoryInit,
    addTurn: mockConversationMemoryAddTurn,
    clearHistory: mockConversationMemoryClearHistory,
    getContext: mockConversationMemoryGetContext,
    getSession: vi.fn().mockResolvedValue({ turns: [], userId: "test", platform: "telegram" }),
  })),
}));

// ── PreferenceMemory mock ─────────────────────────────────────

vi.mock("../../memory/preference-memory.js", () => ({
  PreferenceMemory: vi.fn().mockImplementation(() => ({
    inferFromMessage: vi.fn().mockResolvedValue(undefined),
    buildSystemContext: vi.fn().mockResolvedValue(""),
  })),
}));

// ── Filesystem mock ───────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// ── Config loader mock ────────────────────────────────────────

vi.mock("../../config/loader.js", () => ({
  PEPAGI_DATA_DIR: "/tmp/pepagi-test",
  loadConfig: vi.fn().mockReturnValue({
    managerProvider: "claude",
    managerModel: "claude-opus-4-6",
    agents: {
      claude: { enabled: true, apiKey: "test-key", model: "claude-opus-4-6", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gpt: { enabled: false, apiKey: "", model: "gpt-4o", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      gemini: { enabled: false, apiKey: "", model: "gemini-2.0-flash", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      ollama: { enabled: false, apiKey: "", model: "llama3", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
      lmstudio: { enabled: false, apiKey: "", model: "local", maxOutputTokens: 4096, temperature: 0.3, maxAgenticTurns: 0 },
    },
    security: { maxCostPerTask: 1, maxCostPerSession: 10, blockedCommands: [], requireApproval: [] },
    queue: { maxConcurrentTasks: 5, taskTimeoutMs: 60000 },
    platforms: {
      telegram: { enabled: true, botToken: "test-token", allowedUserIds: [] },
      whatsapp: { enabled: false, allowedNumbers: [] },
      imessage: { enabled: false, allowedNumbers: [] },
    },
  }),
}));

// ── Import after all mocks ────────────────────────────────────

import { TelegramPlatform } from "../telegram.js";
import type { Mediator } from "../../core/mediator.js";
import type { TaskStore } from "../../core/task-store.js";
import type { LLMProvider } from "../../agents/llm-provider.js";

// ── Helpers ───────────────────────────────────────────────────

function makeMockMediator(): Mediator {
  return {
    processTask: vi.fn().mockResolvedValue({
      success: true,
      result: "Task completed successfully",
      summary: "Task ran fine",
      artifacts: [],
      confidence: 0.9,
    }),
  } as unknown as Mediator;
}

function makeMockTaskStore(): TaskStore {
  return {
    create: vi.fn().mockReturnValue({ id: "task-abc", title: "test", status: "pending" }),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ total: 5, completed: 3, failed: 1, running: 1, pending: 0, totalCost: 0.05 }),
    assign: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

function makeMockLLM(): LLMProvider {
  return {
    call: vi.fn().mockResolvedValue({ content: "LLM response", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, cost: 0.001, model: "claude-opus-4-6", latencyMs: 100 }),
    quickClaude: vi.fn().mockResolvedValue({ content: "Quick response", toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, cost: 0.0005, model: "claude-haiku-4-5", latencyMs: 50 }),
    transcribeAudio: vi.fn().mockResolvedValue("Transcribed text"),
    quickVision: vi.fn().mockResolvedValue({ content: "Image description", toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 }, cost: 0.002, model: "claude-opus-4-6", latencyMs: 200 }),
  } as unknown as LLMProvider;
}

function makeTelegramPlatform(
  allowedUserIds: number[] = [],
  mediator?: Mediator,
  taskStore?: TaskStore,
  llm?: LLMProvider,
): TelegramPlatform {
  return new TelegramPlatform(
    "bot-token-123",
    allowedUserIds,
    mediator ?? makeMockMediator(),
    taskStore ?? makeMockTaskStore(),
    llm ?? makeMockLLM(),
    "Welcome to PEPAGI!",
  );
}

/** Build a fake Telegram context for a command */
function makeCtx(userId: number, text = "/start"): Record<string, unknown> {
  return {
    from: { id: userId },
    chat: { id: userId },
    message: { text, message_id: 1 },
    reply: mockBotReply,
    sendChatAction: mockSendChatAction,
    telegram: {
      editMessageText: mockEditMessageText,
      deleteMessage: mockDeleteMessage,
      sendMessage: mockSendMessage,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("TelegramPlatform — initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("constructor initializes without throwing", () => {
    expect(() => makeTelegramPlatform()).not.toThrow();
  });

  it("constructor calls ConversationMemory.init()", () => {
    makeTelegramPlatform();
    expect(mockConversationMemoryInit).toHaveBeenCalled();
  });

  it("start() calls bot.launch()", async () => {
    const platform = makeTelegramPlatform();
    await platform.start();
    expect(mockBotLaunch).toHaveBeenCalled();
  });

  it("start() registers bot handlers (commands are registered during construction)", () => {
    makeTelegramPlatform();
    // Commands registered during setupHandlers (called from constructor)
    expect(registeredCommands.has("start")).toBe(true);
    expect(registeredCommands.has("status")).toBe(true);
    expect(registeredCommands.has("clear")).toBe(true);
  });
});

describe("TelegramPlatform — allowed user check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("allowedUserIds=[] allows all users (empty list = no restriction)", async () => {
    makeTelegramPlatform([]);
    const handler = registeredCommands.get("start");
    expect(handler).toBeDefined();

    const ctx = makeCtx(99999);
    await handler!(ctx);

    // Should reply with welcome message, not "access denied"
    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("Welcome to PEPAGI!"));
  });

  it("allowedUserIds=[123] allows user 123", async () => {
    makeTelegramPlatform([123]);
    const handler = registeredCommands.get("start");
    expect(handler).toBeDefined();

    const ctx = makeCtx(123);
    await handler!(ctx);

    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("Welcome to PEPAGI!"));
  });

  it("allowedUserIds=[123] rejects user 456", async () => {
    makeTelegramPlatform([123]);
    const handler = registeredCommands.get("start");
    expect(handler).toBeDefined();

    const ctx = makeCtx(456);
    await handler!(ctx);

    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("⛔"));
  });

  it("non-allowed user gets access denied on /status", async () => {
    makeTelegramPlatform([100]);
    const handler = registeredCommands.get("status");
    expect(handler).toBeDefined();

    const ctx = makeCtx(999);
    await handler!(ctx);

    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("⛔"));
  });
});

describe("TelegramPlatform — command handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("/start sends welcome message", async () => {
    makeTelegramPlatform([42]);
    const handler = registeredCommands.get("start");
    expect(handler).toBeDefined();

    await handler!(makeCtx(42, "/start"));

    expect(mockBotReply).toHaveBeenCalledWith(
      expect.stringContaining("Welcome to PEPAGI!"),
    );
  });

  it("/status returns task status", async () => {
    const taskStore = makeMockTaskStore();
    new TelegramPlatform("token", [42], makeMockMediator(), taskStore, makeMockLLM(), "Hi!");

    const handler = registeredCommands.get("status");
    expect(handler).toBeDefined();

    await handler!(makeCtx(42, "/status"));

    expect(taskStore.getStats).toHaveBeenCalled();
    expect(mockBotReply).toHaveBeenCalledWith(
      expect.stringContaining("PEPAGI Status"),
    );
  });

  it("/clear resets conversation memory and replies confirmation", async () => {
    makeTelegramPlatform([42]);
    const handler = registeredCommands.get("clear");
    expect(handler).toBeDefined();

    await handler!(makeCtx(42, "/clear"));

    expect(mockConversationMemoryClearHistory).toHaveBeenCalledWith("42", "telegram");
    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("vymazána"));
  });
});

describe("TelegramPlatform — message processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("text message creates a task in TaskStore and calls mediator", async () => {
    const taskStore = makeMockTaskStore();
    const mediator = makeMockMediator();
    new TelegramPlatform("token", [], mediator, taskStore, makeMockLLM(), "Hi!");

    const handler = registeredEvents.get("message:text");
    expect(handler).toBeDefined();

    const ctx = {
      from: { id: 7 },
      chat: { id: 7 },
      message: { text: "What is the capital of France?", message_id: 5 },
      reply: mockBotReply,
      sendChatAction: mockSendChatAction,
      telegram: {
        editMessageText: mockEditMessageText,
        deleteMessage: mockDeleteMessage,
      },
    };

    await handler!(ctx);

    expect(taskStore.create).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("What is the capital of France?"),
    }));
    expect(mediator.processTask).toHaveBeenCalled();
  });

  it("text message from non-allowed user is rejected", async () => {
    new TelegramPlatform("token", [100], makeMockMediator(), makeMockTaskStore(), makeMockLLM(), "Hi!");

    const handler = registeredEvents.get("message:text");
    expect(handler).toBeDefined();

    const ctx = {
      from: { id: 999 },
      chat: { id: 999 },
      message: { text: "Hello!", message_id: 2 },
      reply: mockBotReply,
      sendChatAction: mockSendChatAction,
      telegram: { editMessageText: mockEditMessageText, deleteMessage: mockDeleteMessage },
    };

    await handler!(ctx);

    expect(mockBotReply).toHaveBeenCalledWith(expect.stringContaining("⛔"));
  });

  it("ConversationMemory.addTurn() is called after mediator response", async () => {
    new TelegramPlatform("token", [], makeMockMediator(), makeMockTaskStore(), makeMockLLM(), "Hi!");

    const handler = registeredEvents.get("message:text");
    expect(handler).toBeDefined();

    const ctx = {
      from: { id: 7 },
      chat: { id: 7 },
      message: { text: "Hello!", message_id: 5 },
      reply: mockBotReply,
      sendChatAction: mockSendChatAction,
      telegram: { editMessageText: mockEditMessageText, deleteMessage: mockDeleteMessage },
    };

    await handler!(ctx);

    // addTurn is called for user turn and assistant reply
    expect(mockConversationMemoryAddTurn).toHaveBeenCalled();
  });
});

describe("TelegramPlatform — long response handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("response <= 4096 chars is sent as a single message", async () => {
    const shortResult = "Short answer";
    const mediator = makeMockMediator();
    (mediator.processTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      result: shortResult,
      summary: shortResult,
      artifacts: [],
      confidence: 0.9,
    });

    new TelegramPlatform("token", [], mediator, makeMockTaskStore(), makeMockLLM(), "Hi!");

    const handler = registeredEvents.get("message:text");
    expect(handler).toBeDefined();

    const ctx = {
      from: { id: 7 },
      chat: { id: 7 },
      message: { text: "Tell me something", message_id: 5 },
      reply: mockBotReply,
      sendChatAction: mockSendChatAction,
      telegram: { editMessageText: mockEditMessageText, deleteMessage: mockDeleteMessage },
    };

    await handler!(ctx);

    // reply should have been called once (plus the initial "thinking" message)
    const replyCalls = mockBotReply.mock.calls.filter(
      (call: unknown[]) => call[0] === shortResult,
    );
    expect(replyCalls).toHaveLength(1);
  });

  it("response > 4096 chars is split into chunks sent separately", async () => {
    // Generate a string slightly over 4096 chars
    const longResult = "A".repeat(5000);
    const mediator = makeMockMediator();
    (mediator.processTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      result: longResult,
      summary: longResult,
      artifacts: [],
      confidence: 0.9,
    });

    new TelegramPlatform("token", [], mediator, makeMockTaskStore(), makeMockLLM(), "Hi!");

    const handler = registeredEvents.get("message:text");
    expect(handler).toBeDefined();

    const ctx = {
      from: { id: 7 },
      chat: { id: 7 },
      message: { text: "Write a long response", message_id: 5 },
      reply: mockBotReply,
      sendChatAction: mockSendChatAction,
      telegram: { editMessageText: mockEditMessageText, deleteMessage: mockDeleteMessage },
    };

    await handler!(ctx);

    // At least 2 chunks should have been sent for 5000-char response
    // (1 initial "thinking" + 2 content chunks = at least 2 content replies)
    const contentReplies = mockBotReply.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("A"),
    );
    expect(contentReplies.length).toBeGreaterThanOrEqual(2);
  });
});

describe("TelegramPlatform — stop()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.clear();
    registeredEvents.clear();
  });

  it("stop() calls bot.stop()", async () => {
    const platform = makeTelegramPlatform();
    await platform.stop();
    expect(mockBotStop).toHaveBeenCalled();
  });
});
