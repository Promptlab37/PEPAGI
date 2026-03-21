// ═══════════════════════════════════════════════════════════════
// PEPAGI — Platform Manager
// Orchestrates all communication platforms (Telegram, WhatsApp)
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import type { PepagiConfig } from "../config/loader.js";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { GoalManager } from "../core/goal-manager.js";
import type { MemorySystem } from "../memory/memory-system.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { TelegramPlatform } from "./telegram.js";
import { WhatsAppPlatform } from "./whatsapp.js";
import { DiscordPlatform } from "./discord.js";
import { iMessagePlatform } from "./imessage.js";

const logger = new Logger("PlatformManager");

export class PlatformManager {
  private telegram?: TelegramPlatform;
  private whatsapp?: WhatsAppPlatform;
  private discord?: DiscordPlatform;
  private imessage?: iMessagePlatform;
  private active: string[] = [];

  constructor(
    private config: PepagiConfig,
    private mediator: Mediator,
    private taskStore: TaskStore,
    private llm: LLMProvider,
    private goalManager?: GoalManager,
    private memory?: MemorySystem,
    private skillRegistry?: SkillRegistry,
  ) {}

  /** Initialize and start all enabled platforms. */
  async startAll(): Promise<void> {
    const { telegram, whatsapp, discord } = this.config.platforms;
    const profile = this.config.profile;
    const assistantName = profile?.assistantName || "PEPAGI";
    const userName = profile?.userName;

    // Build welcome messages using profile
    const telegramWelcome = telegram.welcomeMessage !== "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat."
      ? telegram.welcomeMessage
      : userName
        ? `Ahoj ${userName}! Jsem ${assistantName}. Napiš mi co chceš udělat 🤖`
        : `Ahoj! Jsem ${assistantName}. Napiš mi co chceš udělat 🤖`;

    const whatsappWelcome = whatsapp.welcomeMessage !== "Ahoj! Jsem PEPAGI. Napiš mi co chceš udělat."
      ? whatsapp.welcomeMessage
      : userName
        ? `Ahoj ${userName}! Jsem ${assistantName}. Napiš mi co chceš udělat 🤖`
        : `Ahoj! Jsem ${assistantName}. Napiš mi co chceš udělat 🤖`;

    if (telegram.enabled && telegram.botToken) {
      this.telegram = new TelegramPlatform(
        telegram.botToken,
        telegram.allowedUserIds,
        this.mediator,
        this.taskStore,
        this.llm,
        telegramWelcome,
        this.goalManager,
        this.memory,
        this.skillRegistry,
      );
      await this.telegram.start();
      this.active.push("telegram");
      eventBus.emit({ type: "platform:status", platform: "telegram", connected: true });
      logger.info("Telegram platform started");
    }

    if (whatsapp.enabled) {
      try {
        this.whatsapp = new WhatsAppPlatform(
          whatsapp.allowedNumbers,
          this.mediator,
          this.taskStore,
          whatsappWelcome,
          whatsapp.sessionPath,
        );
        await this.whatsapp.start();
        this.active.push("whatsapp");
        eventBus.emit({ type: "platform:status", platform: "whatsapp", connected: true });
        logger.info("WhatsApp platform started");
      } catch (err) {
        logger.error("WhatsApp failed to start", { error: String(err) });
      }
    }

    if (discord?.enabled && discord.botToken) {
      this.discord = new DiscordPlatform(
        discord,
        this.mediator,
        this.taskStore,
        this.llm,
        this.memory,
        this.skillRegistry,
      );
      await this.discord.start();
      this.active.push("discord");
      eventBus.emit({ type: "platform:status", platform: "discord", connected: true });
      logger.info("Discord platform started");
    }

    const imessage = this.config.platforms.imessage;
    if (imessage?.enabled) {
      this.imessage = new iMessagePlatform(
        imessage,
        this.mediator,
        this.taskStore,
      );
      await this.imessage.start();
      this.active.push("imessage");
      eventBus.emit({ type: "platform:status", platform: "imessage", connected: true });
      logger.info("iMessage platform started");
    }

    if (this.active.length === 0) {
      logger.warn("No platforms are enabled. Configure Telegram or WhatsApp in ~/.pepagi/config.json");
    } else {
      logger.info(`Active platforms: ${this.active.join(", ")}`);
    }
  }

  /** Stop all platforms gracefully. */
  async stopAll(): Promise<void> {
    const stops: Promise<void>[] = [];
    if (this.telegram) stops.push(this.telegram.stop());
    if (this.whatsapp) stops.push(this.whatsapp.stop());
    if (this.discord) stops.push(this.discord.stop());
    if (this.imessage) stops.push(this.imessage.stop());
    await Promise.allSettled(stops);
    for (const name of this.active) {
      eventBus.emit({ type: "platform:status", platform: name as "telegram" | "whatsapp" | "discord" | "imessage", connected: false });
    }
    this.active = [];
    logger.info("All platforms stopped.");
  }

  /** List active platform names. */
  getActivePlatforms(): string[] {
    return [...this.active];
  }

  /** Whether any platform is running. */
  hasActivePlatforms(): boolean {
    return this.active.length > 0;
  }

  /** Force WhatsApp to logout and re-authenticate (generates new QR). */
  async reconnectWhatsApp(): Promise<void> {
    if (this.whatsapp) {
      await this.whatsapp.reconnect();
    }
  }
}
