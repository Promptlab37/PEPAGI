// ═══════════════════════════════════════════════════════════════
// PEPAGI — Discord Platform
// Receives messages from Discord, routes through Mediator
// Supports: text messages, slash-style commands (prefix-based)
// ═══════════════════════════════════════════════════════════════

import { Client, GatewayIntentBits, Events, ChannelType, type Message, type TextBasedChannel } from "discord.js";
import { eventBus } from "../core/event-bus.js";
import type { PepagiEvent } from "../core/types.js";
import { Logger } from "../core/logger.js";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { MemorySystem } from "../memory/memory-system.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { ConversationMemory } from "../memory/conversation-memory.js";
import { PreferenceMemory } from "../memory/preference-memory.js";
// SECURITY: SEC-30 — Per-user rate limiting
import { RateLimiter } from "../security/rate-limiter.js";

const logger = new Logger("Discord");

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  /** Discord user snowflake IDs. Empty array = allow everyone. */
  allowedUserIds: string[];
  /** Channel IDs to listen on. Empty array = all channels. */
  allowedChannelIds: string[];
  /** Prefix for commands, default "!" */
  commandPrefix: string;
  welcomeMessage: string;
}

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

/** Maximum Discord message length */
const DISCORD_MAX_LEN = 2000;

export class DiscordPlatform {
  private client: Client;
  private conversationMemory: ConversationMemory;
  private conversations = new Map<string, ConversationEntry[]>();
  private preferenceMemory = new PreferenceMemory();
  // SECURITY: SEC-30 — 20 messages/min per user
  private rateLimiter = new RateLimiter(20, 60_000, "discord");
  // AUD-08: store eventBus listener references for cleanup in stop()
  private alertHandler: ((ev: Extract<PepagiEvent, { type: "system:alert" }>) => void) | null = null;
  private goalResultHandler: ((ev: Extract<PepagiEvent, { type: "system:goal_result" }>) => void) | null = null;

  constructor(
    private config: DiscordConfig,
    private mediator: Mediator,
    private taskStore: TaskStore,
    private llm: LLMProvider,
    private memory?: MemorySystem,
    private skillRegistry?: SkillRegistry,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.conversationMemory = new ConversationMemory();
    this.conversationMemory.init().catch(() => {});
  }

  // ─── Access control ───────────────────────────────────────────

  private isAllowedUser(userId: string): boolean {
    if (this.config.allowedUserIds.length === 0) return true;
    return this.config.allowedUserIds.includes(userId);
  }

  private isAllowedChannel(channelId: string, isDM: boolean): boolean {
    if (isDM) return true; // DMs are always allowed if user is allowed
    if (this.config.allowedChannelIds.length === 0) return true;
    return this.config.allowedChannelIds.includes(channelId);
  }

  // ─── Conversation history ─────────────────────────────────────

  // FIX: cap conversation map to prevent unbounded memory growth
  private static readonly MAX_CONVERSATIONS = 100;

  private getHistory(userId: string): ConversationEntry[] {
    if (!this.conversations.has(userId)) {
      // FIX: evict oldest conversation if map exceeds cap
      if (this.conversations.size >= DiscordPlatform.MAX_CONVERSATIONS) {
        const oldest = this.conversations.keys().next().value;
        if (oldest !== undefined) this.conversations.delete(oldest);
      }
      this.conversations.set(userId, []);
    }
    return this.conversations.get(userId)!;
  }

  private buildContext(history: ConversationEntry[], maxEntries = 6): string {
    const recent = history.slice(-maxEntries);
    if (recent.length === 0) return "";
    return "\n\nConversation history:\n" + recent
      .map(e => `${e.role === "user" ? "User" : "PEPAGI"}: ${e.content}`)
      .join("\n");
  }

  // ─── Send helpers ─────────────────────────────────────────────

  /**
   * Returns true if the channel supports send() / sendTyping() (excludes PartialGroupDMChannel).
   */
  private isSendableChannel(channel: Message["channel"]): channel is TextBasedChannel & { send: unknown; sendTyping: unknown } {
    return channel.type !== ChannelType.GroupDM;
  }

  /**
   * Split a long message into 2000-char chunks and send each.
   */
  private async sendChunked(message: Message, text: string): Promise<void> {
    if (text.length <= DISCORD_MAX_LEN) {
      await message.reply(text);
      return;
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, DISCORD_MAX_LEN));
      remaining = remaining.slice(DISCORD_MAX_LEN);
    }
    if (!this.isSendableChannel(message.channel)) {
      // Fallback: reply with the first chunk only
      await message.reply(chunks[0] ?? text);
      return;
    }
    for (const chunk of chunks) {
      await (message.channel as { send(text: string): Promise<unknown> }).send(chunk);
    }
  }

  // ─── Core task runner ─────────────────────────────────────────

  /**
   * Run a text task through the mediator and return the result string.
   * @param userId - Discord user snowflake (string)
   * @param userContent - Full user message text
   * @param taskTitle - Short task title (max 80 chars)
   */
  private async runTask(
    userId: string,
    userContent: string,
    taskTitle: string,
  ): Promise<string> {
    // Infer and persist user preferences from message content
    await this.preferenceMemory.inferFromMessage(userId, userContent).catch(() => {});

    const history = this.getHistory(userId);
    history.push({ role: "user", content: userContent, timestamp: new Date() });
    const context = this.buildContext(history.slice(0, -1));

    // Persist user turn to ConversationMemory
    this.conversationMemory.addTurn(userId, "user", userContent, "discord").catch(() => {});

    // Append user preference context to task description
    const prefContext = await this.preferenceMemory.buildSystemContext(userId).catch(() => "");

    const task = this.taskStore.create({
      title: taskTitle.slice(0, 80),
      description: userContent,
      priority: "medium",
      input: {
        ...(context ? { conversationHistory: context } : {}),
        ...(prefContext ? { userPreferences: prefContext } : {}),
      },
    });

    // Track this task and any subtasks it spawns
    const trackedIds = new Set<string>([task.id]);

    const taskCreatedHandler = (ev: Extract<PepagiEvent, { type: "task:created" }>) => {
      if (ev.task.parentId && trackedIds.has(ev.task.parentId)) {
        trackedIds.add(ev.task.id);
      }
    };

    eventBus.on("task:created", taskCreatedHandler);

    try {
      const output = await this.mediator.processTask(task.id);
      const result = output.success
        ? (typeof output.result === "string" ? output.result : output.summary)
        : `Task failed: ${output.summary}`;

      history.push({ role: "assistant", content: result, timestamp: new Date() });
      if (history.length > 20) {
        this.conversations.set(userId, history.slice(-20));
      }

      // Persist assistant reply to ConversationMemory
      this.conversationMemory.addTurn(userId, "assistant", result, "discord", task.id).catch(() => {});
      return result;
    } finally {
      eventBus.off("task:created", taskCreatedHandler);
    }
  }

  // ─── Command handlers ─────────────────────────────────────────

  // SECURITY: SEC-05 — Admin commands restricted to DM only
  private static readonly ADMIN_COMMANDS = new Set(["memory", "skills"]);

  private async handleCommand(message: Message, command: string, _args: string[]): Promise<void> {
    const userId = message.author.id;

    // SECURITY: SEC-05 — Block admin commands in guild channels (non-DM)
    if (DiscordPlatform.ADMIN_COMMANDS.has(command) && message.channel.type !== ChannelType.DM) {
      await message.reply("This command is only available in DMs for security reasons.");
      return;
    }

    switch (command) {
      case "help": {
        const prefix = this.config.commandPrefix;
        await message.reply(
          `**PEPAGI** — Commands:\n` +
          `\`${prefix}status\` — Show task statistics\n` +
          `\`${prefix}clear\` — Clear conversation history\n` +
          `\`${prefix}memory\` — Show memory stats\n` +
          `\`${prefix}skills\` — List loaded skills\n` +
          `\`${prefix}help\` — Show this message\n\n` +
          `Or just send a message to start a task!`,
        );
        break;
      }

      case "status": {
        const stats = this.taskStore.getStats();
        await message.reply(
          `**PEPAGI Status**\n\n` +
          `Tasks: ${stats.total} total\n` +
          `Completed: ${stats.completed}\n` +
          `Failed: ${stats.failed}\n` +
          `Running: ${stats.running}`,
        );
        break;
      }

      case "clear": {
        this.conversations.delete(userId);
        await this.conversationMemory.clearHistory(userId, "discord");
        await message.reply("Conversation history cleared.");
        break;
      }

      case "memory": {
        if (!this.memory) {
          await message.reply("Memory system is not available.");
          return;
        }
        if (this.isSendableChannel(message.channel)) {
          await (message.channel as { sendTyping(): Promise<void> }).sendTyping().catch(() => {});
        }
        try {
          const stats = await this.memory.getStats();
          const ep = stats.episodic as { total: number; successRate: number; avgCost: number };
          const sem = stats.semantic as { total: number; avgConfidence: number };
          const proc = stats.procedural as { total: number; reliable: number; avgSuccessRate: number };
          await message.reply(
            `**Memory System**\n\n` +
            `Episodes: ${ep.total ?? 0} (success rate ${((ep.successRate ?? 0) * 100).toFixed(0)}%)\n` +
            `Facts: ${sem.total ?? 0} (avg confidence ${((sem.avgConfidence ?? 0) * 100).toFixed(0)}%)\n` +
            `Procedures: ${proc.total ?? 0} (${proc.reliable ?? 0} reliable)`,
          );
        } catch (err) {
          // SEC-12 fix: log full error internally, send only a generic message to the user
          logger.error("Memory command error", { userId, error: String(err) });
          await message.reply("An internal error occurred. Please try again.");
        }
        break;
      }

      case "skills": {
        if (!this.skillRegistry) {
          await message.reply("SkillRegistry is not available.");
          return;
        }
        const skills = this.skillRegistry.list();
        if (skills.length === 0) {
          await message.reply("No skills loaded. Place .js skill files in `~/.pepagi/skills/`.");
          return;
        }
        const text = skills.map((s, i) =>
          `**${i + 1}. ${s.name}**\n${s.description.slice(0, 80)}\nTriggers: ${s.triggers.slice(0, 2).join(", ")}`
        ).join("\n\n");
        await this.sendChunked(message, `**Active Skills (${skills.length}):**\n\n${text}`);
        break;
      }

      default: {
        await message.reply(`Unknown command: \`${this.config.commandPrefix}${command}\`. Use \`${this.config.commandPrefix}help\` to see available commands.`);
        break;
      }
    }
  }

  // ─── Event setup ──────────────────────────────────────────────

  private setupHandlers(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info(`Discord bot ready as ${readyClient.user.tag}`);
    });

    // Forward critical system alerts to allowed users via DM
    // RATE LIMIT: batch rapid alerts (e.g., adversarial tester burst) into summaries
    let lastDiscordAlert = 0;
    let pendingDiscordAlerts: string[] = [];
    let discordBatchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushDiscordAlerts = () => {
      discordBatchTimer = null;
      if (pendingDiscordAlerts.length === 0) return;
      const summary = pendingDiscordAlerts.length === 1
        ? pendingDiscordAlerts[0]!
        : `⚠️ ${pendingDiscordAlerts.length} security alerts:\n${pendingDiscordAlerts.slice(0, 10).map((a, i) => `${i + 1}. ${a}`).join("\n")}${pendingDiscordAlerts.length > 10 ? `\n…and ${pendingDiscordAlerts.length - 10} more` : ""}`;
      pendingDiscordAlerts = [];
      lastDiscordAlert = Date.now();
      for (const uid of this.config.allowedUserIds) {
        this.client.users.fetch(uid).then(user => {
          user.send(summary.slice(0, DISCORD_MAX_LEN)).catch(() => {});
        }).catch(() => {});
      }
    };

    this.alertHandler = (ev: Extract<PepagiEvent, { type: "system:alert" }>) => {
      if (this.config.allowedUserIds.length === 0) return;
      const now = Date.now();
      if (now - lastDiscordAlert > 30_000 && pendingDiscordAlerts.length === 0) {
        lastDiscordAlert = now;
        for (const uid of this.config.allowedUserIds) {
          this.client.users.fetch(uid).then(user => {
            user.send(ev.message.slice(0, DISCORD_MAX_LEN)).catch(() => {});
          }).catch(() => {});
        }
      } else {
        pendingDiscordAlerts.push(ev.message);
        if (!discordBatchTimer) {
          discordBatchTimer = setTimeout(flushDiscordAlerts, 30_000);
        }
      }
    };
    eventBus.on("system:alert", this.alertHandler);

    // Deliver goal results to specific user
    this.goalResultHandler = (ev: Extract<PepagiEvent, { type: "system:goal_result" }>) => {
      const targetId = ev.userId ?? null;
      const text = ev.message.length <= DISCORD_MAX_LEN
        ? ev.message
        : ev.message.slice(0, DISCORD_MAX_LEN - 3) + "...";

      if (targetId) {
        this.client.users.fetch(targetId).then(user => {
          user.send(text).catch(() => {});
        }).catch(() => {});
      } else {
        for (const uid of this.config.allowedUserIds) {
          this.client.users.fetch(uid).then(user => {
            user.send(text).catch(() => {});
          }).catch(() => {});
        }
      }
    };
    eventBus.on("system:goal_result", this.goalResultHandler);

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore messages from bots (including self)
      if (message.author.bot) return;

      const userId = message.author.id;
      const channelId = message.channelId;
      const isDM = message.channel.type === 1; // ChannelType.DM = 1

      // Access control
      if (!this.isAllowedUser(userId)) {
        logger.debug("Ignoring message from unauthorized user", { userId });
        return;
      }
      if (!this.isAllowedChannel(channelId, isDM)) {
        logger.debug("Ignoring message from unauthorized channel", { channelId });
        return;
      }

      // SECURITY: SEC-30 — Per-user rate limiting
      if (this.rateLimiter.isRateLimited(userId)) {
        await message.reply("Too many messages. Please wait a moment.").catch(() => {});
        return;
      }

      const content = message.content.trim();
      if (!content) return;

      const prefix = this.config.commandPrefix;

      // Command handling
      if (content.startsWith(prefix)) {
        const withoutPrefix = content.slice(prefix.length).trim();
        const parts = withoutPrefix.split(/\s+/);
        const command = (parts[0] ?? "").toLowerCase();
        const args = parts.slice(1);

        logger.info("Discord command received", { userId, command });
        await this.handleCommand(message, command, args);
        return;
      }

      // Task processing
      logger.info("Discord message received", { userId, len: content.length });

      try {
        if (this.isSendableChannel(message.channel)) {
          await (message.channel as { sendTyping(): Promise<void> }).sendTyping().catch(() => {});
        }
        const result = await this.runTask(userId, content, content);
        await this.sendChunked(message, result);
        logger.info("Discord reply sent", { userId });
      } catch (err) {
        // SEC-12 fix: already logged; send only a generic message to the user
        logger.error("Discord message handler error", { userId, error: String(err) });
        await message.reply("An internal error occurred. Please try again.").catch(() => {});
      }
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Start the Discord bot by registering event handlers and logging in.
   */
  async start(): Promise<void> {
    // AUDIT: warn if allowedUserIds is empty — bot will accept messages from anyone
    if (this.config.allowedUserIds.length === 0) {
      logger.warn("Discord allowedUserIds is empty — bot accepts messages from ALL users");
    }
    logger.info("Starting Discord bot...");
    this.setupHandlers();
    await this.client.login(this.config.botToken);
    logger.info("Discord bot started");
  }

  /**
   * Stop the Discord bot and destroy the client connection.
   */
  async stop(): Promise<void> {
    // AUD-08: remove eventBus listeners to prevent leaks
    if (this.alertHandler) {
      eventBus.off("system:alert", this.alertHandler);
      this.alertHandler = null;
    }
    if (this.goalResultHandler) {
      eventBus.off("system:goal_result", this.goalResultHandler);
      this.goalResultHandler = null;
    }
    this.client.destroy();
    logger.info("Discord bot stopped.");
  }
}
