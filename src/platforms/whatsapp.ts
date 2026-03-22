// ═══════════════════════════════════════════════════════════════
// PEPAGI — WhatsApp Platform
// Uses whatsapp-web.js (QR scan authentication)
// ═══════════════════════════════════════════════════════════════
// NOTE: Requires optional dependency: npm install whatsapp-web.js qrcode-terminal
// This is an unofficial WhatsApp Web client. Use responsibly.

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
import { ConversationMemory } from "../memory/conversation-memory.js";
import { join } from "node:path";
import { homedir } from "node:os";

const logger = new Logger("WhatsApp");

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

export class WhatsAppPlatform {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private conversations = new Map<string, ConversationEntry[]>();
  private sessionPath: string;
  // QUAL-04: persist conversation history across sessions (mirrors Telegram's ConversationMemory)
  private conversationMemory = new ConversationMemory();

  constructor(
    private allowedNumbers: string[],
    private mediator: Mediator,
    private taskStore: TaskStore,
    private welcomeMessage: string,
    sessionPath?: string,
  ) {
    this.sessionPath = sessionPath || join(homedir(), ".pepagi", "whatsapp-session");
    // QUAL-04: initialize storage directory on construction (non-blocking)
    this.conversationMemory.init().catch(() => {});
  }

  private isAllowed(from: string): boolean {
    if (this.allowedNumbers.length === 0) return true;
    const number = from.replace("@c.us", "").replace(/\D/g, "");
    return this.allowedNumbers.some(n => n.replace(/\D/g, "") === number);
  }

  // FIX: cap conversation map to prevent unbounded memory growth
  private static readonly MAX_CONVERSATIONS = 100;

  private getHistory(from: string): ConversationEntry[] {
    if (!this.conversations.has(from)) {
      // FIX: evict oldest conversation if map exceeds cap
      if (this.conversations.size >= WhatsAppPlatform.MAX_CONVERSATIONS) {
        const oldest = this.conversations.keys().next().value;
        if (oldest !== undefined) this.conversations.delete(oldest);
      }
      this.conversations.set(from, []);
    }
    return this.conversations.get(from)!;
  }

  private buildContext(history: ConversationEntry[], max = 6): string {
    const recent = history.slice(-max);
    if (recent.length === 0) return "";
    return "\n\nConversation history:\n" + recent
      .map(e => `${e.role === "user" ? "User" : "PEPAGI"}: ${e.content}`)
      .join("\n");
  }

  /**
   * Start the WhatsApp client.
   * Dynamically loads whatsapp-web.js to keep it as optional dependency.
   */
  async start(): Promise<void> {
    logger.info("Starting WhatsApp platform...");

    // Dynamic import — whatsapp-web.js is optional (CJS module, exports on .default)
    let Client: new (opts: unknown) => unknown;
    let LocalAuth: new (opts?: unknown) => unknown;
    let qrcodeTerminal: { generate: (qr: string, opts: unknown) => void };

    try {
      const wwMod = await import("whatsapp-web.js");
      const ww = wwMod.default ?? wwMod;
      Client = (ww as Record<string, unknown>).Client as typeof Client;
      LocalAuth = (ww as Record<string, unknown>).LocalAuth as typeof LocalAuth;
      qrcodeTerminal = await import("qrcode-terminal") as typeof qrcodeTerminal;
    } catch {
      throw new Error(
        "WhatsApp dependencies missing. Run: npm install whatsapp-web.js qrcode-terminal"
      );
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionPath }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.client as any;

    client.on("qr", (qr: string) => {
      logger.info("WhatsApp — naskenuj QR kód svým telefonem");
      eventBus.emit({ type: "platform:qr", platform: "whatsapp", qr });
      qrcodeTerminal.generate(qr, { small: true });
    });

    client.on("authenticated", () => {
      logger.info("WhatsApp authenticated ✓");
    });

    client.on("ready", async () => {
      logger.info("WhatsApp client ready ✓");
      eventBus.emit({ type: "platform:status", platform: "whatsapp", connected: true });
    });

    client.on("auth_failure", (msg: string) => {
      // FIX: use logger instead of console.error for production code
      logger.error("WhatsApp auth failed", { msg });
    });

    // Track recently sent messages to avoid reacting to bot's own replies
    const recentBotReplies = new Set<string>();
    const botSend = async (to: string, text: string) => {
      recentBotReplies.add(text.slice(0, 100));
      // Auto-expire after 10s to prevent memory leak
      setTimeout(() => recentBotReplies.delete(text.slice(0, 100)), 10_000);
      await client.sendMessage(to, text);
    };

    client.on("message_create", async (msg: { from: string; to: string; body: string; fromMe: boolean; id: { _serialized: string } }) => {
      // Skip messages with no body or internal markers
      if (!msg.body || msg.body.startsWith("_pepagi_")) return;
      // If this is a bot reply we just sent, remember it and skip
      if (msg.fromMe && recentBotReplies.delete(msg.body.slice(0, 100))) return;
      // For non-self messages, skip own outgoing messages
      if (msg.fromMe && msg.from !== msg.to) return;

      const from = msg.from;

      if (!this.isAllowed(from)) {
        logger.info("WhatsApp blocked unauthorized sender", { from });
        return;
      }

      const userMessage = msg.body.trim();
      logger.info("WhatsApp message received", { from, length: userMessage.length });

      // Handle commands
      if (userMessage.toLowerCase() === "/start" || userMessage.toLowerCase() === "start") {
        this.conversations.delete(from);
        await botSend(from, this.welcomeMessage);
        return;
      }
      if (userMessage.toLowerCase() === "/clear") {
        this.conversations.delete(from);
        // QUAL-04: also clear persistent ConversationMemory for this user
        await this.conversationMemory.clearHistory(from, "whatsapp");
        await botSend(from, "🧹 Konverzace vymazána.");
        return;
      }
      if (userMessage.toLowerCase() === "/status") {
        const stats = this.taskStore.getStats();
        await botSend(from,
          `📊 PEPAGI Status\nÚlohy: ${stats.total} | ✓ ${stats.completed} | ✗ ${stats.failed} | ⏳ ${stats.running}`
        );
        return;
      }

      const history = this.getHistory(from);
      history.push({ role: "user", content: userMessage });
      // QUAL-04: persist user turn to ConversationMemory for cross-session history
      this.conversationMemory.addTurn(from, "user", userMessage, "whatsapp").catch(() => {});

      const context = this.buildContext(history.slice(0, -1));

      const task = this.taskStore.create({
        title: userMessage.slice(0, 80),
        description: userMessage,
        priority: "medium",
        input: {
          ...(context ? { conversationHistory: context } : {}),
        },
      });

      try {
        const output = await this.mediator.processTask(task.id);
        const result = output.success
          ? (typeof output.result === "string" ? output.result : output.summary)
          : `❌ Nepodařilo se: ${output.summary}`;

        history.push({ role: "assistant", content: result });
        if (history.length > 20) {
          this.conversations.set(from, history.slice(-20));
        }
        // QUAL-04: persist assistant reply to ConversationMemory
        this.conversationMemory.addTurn(from, "assistant", result, "whatsapp", task.id).catch(() => {});

        // WhatsApp has no strict char limit but split at 4000 to be safe
        if (result.length <= 4000) {
          await botSend(from, result);
        } else {
          const chunks = result.match(/.{1,4000}/gs) ?? [result];
          for (const chunk of chunks) {
            await botSend(from, chunk);
          }
        }
      } catch (err) {
        // SEC-12: log full error internally, send only a generic message to the user
        logger.error("WhatsApp task failed", { error: err instanceof Error ? err.message : String(err) });
        await botSend(from, "Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    await client.initialize();
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      logger.info("WhatsApp client stopped.");
    }
  }

  /** Logout and restart — forces new QR code generation. */
  async reconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.logout(); } catch {}
      try { await this.client.destroy(); } catch {}
      eventBus.emit({ type: "platform:status", platform: "whatsapp", connected: false });
    }
    logger.info("WhatsApp reconnecting — new QR code will be generated");
    await this.start();
  }
}
