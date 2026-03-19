// ═══════════════════════════════════════════════════════════════
// PEPAGI — Telegram Platform
// Receives messages from Telegram, routes through Mediator
// Supports: text · photos · voice messages · documents · stickers
// ═══════════════════════════════════════════════════════════════

import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { eventBus } from "../core/event-bus.js";
import type { PepagiEvent } from "../core/types.js";
import { Logger } from "../core/logger.js";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
import type { LLMProvider } from "../agents/llm-provider.js";
import type { GoalManager } from "../core/goal-manager.js";
import type { MemorySystem } from "../memory/memory-system.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import { ConversationMemory } from "../memory/conversation-memory.js";
import { PreferenceMemory } from "../memory/preference-memory.js";
// SECURITY: SEC-30 — Per-user rate limiting
import { RateLimiter } from "../security/rate-limiter.js";

const logger = new Logger("Telegram");

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export class TelegramPlatform {
  private bot: Telegraf;
  private conversations = new Map<number, ConversationEntry[]>();
  private conversationMemory = new ConversationMemory();
  private preferenceMemory = new PreferenceMemory();
  // SECURITY: SEC-30 — 20 messages/min per user
  private rateLimiter = new RateLimiter(20, 60_000, "telegram");
  // MEM-04 fix: store the alert handler reference so we can remove it in stop()
  private alertHandler: ((e: PepagiEvent) => void) | null = null;
  // FIX: store goal_result handler for cleanup in stop()
  private goalResultHandler: ((e: PepagiEvent) => void) | null = null;
  // FIX: store signal handlers to prevent MaxListenersExceeded
  private _sigintHandler: (() => void) | null = null;
  private _sigtermHandler: (() => void) | null = null;

  constructor(
    private botToken: string,
    private allowedUserIds: number[],
    private mediator: Mediator,
    private taskStore: TaskStore,
    private llm: LLMProvider,
    private welcomeMessage: string,
    private goalManager?: GoalManager,
    private memory?: MemorySystem,
    private skillRegistry?: SkillRegistry,
  ) {
    this.bot = new Telegraf(botToken);
    this.conversationMemory.init().catch(() => {});
    this.setupHandlers();
  }

  private isAllowed(userId: number): boolean {
    if (this.allowedUserIds.length === 0) return true;
    return this.allowedUserIds.includes(userId);
  }

  // SECURITY: SEC-05 — Detect group chats to restrict admin commands
  private isGroupChat(ctx: { chat?: { type: string } }): boolean {
    return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  }

  // SECURITY: SEC-05 — Admin commands that expose sensitive data or modify system state
  private static readonly ADMIN_COMMANDS = new Set(["goals", "memory", "skills", "tts"]);

  // FIX: cap conversation map to prevent unbounded memory growth
  private static readonly MAX_CONVERSATIONS = 100;

  private getHistory(userId: number): ConversationEntry[] {
    if (!this.conversations.has(userId)) {
      // FIX: evict oldest conversation if map exceeds cap
      if (this.conversations.size >= TelegramPlatform.MAX_CONVERSATIONS) {
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

  /** Download a file from Telegram and return its Buffer */
  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const file = await this.bot.telegram.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Run a text task through the mediator and return the result string */
  private async runTask(
    userId: number,
    userContent: string,
    taskTitle: string,
    onProgress?: (text: string) => Promise<void>,
  ): Promise<string> {
    // Infer and persist user preferences from message content
    await this.preferenceMemory.inferFromMessage(String(userId), userContent).catch(() => {});

    const history = this.getHistory(userId);
    history.push({ role: "user", content: userContent, timestamp: new Date() });
    const context = this.buildContext(history.slice(0, -1));
    // Persist user turn to ConversationMemory
    this.conversationMemory.addTurn(String(userId), "user", userContent, "telegram").catch(() => {});

    // Append user preference context to task description
    const prefContext = await this.preferenceMemory.buildSystemContext(String(userId)).catch(() => "");

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

    const ACTION_LABELS: Record<string, string> = {
      decompose: "🔀 Rozkládám na podúkoly",
      assign:    "🤖 Přiřazuji agentovi",
      complete:  "✅ Vyhodnocuji",
      fail:      "❌ Selhalo",
      ask_user:  "❓ Potřebuji upřesnění",
      swarm:     "🌊 Swarm mode",
    };

    const taskCreatedHandler = (ev: Extract<PepagiEvent, { type: "task:created" }>) => {
      if (ev.task.parentId && trackedIds.has(ev.task.parentId)) {
        trackedIds.add(ev.task.id);
      }
    };

    const decisionHandler = (ev: Extract<PepagiEvent, { type: "mediator:decision" }>) => {
      if (!trackedIds.has(ev.taskId) || !onProgress) return;
      const label = ACTION_LABELS[ev.decision.action] ?? "⚙️ Pracuji";
      const reason = ev.decision.reasoning.slice(0, 140);
      onProgress(`${label}\n\n_${reason}${ev.decision.reasoning.length > 140 ? "…" : ""}_`).catch(() => {});
    };

    eventBus.on("task:created", taskCreatedHandler);
    eventBus.on("mediator:decision", decisionHandler);

    try {
      const output = await this.mediator.processTask(task.id);
      const result = output.success
        ? (typeof output.result === "string" ? output.result : output.summary)
        : `❌ Nepodařilo se: ${output.summary}`;

      history.push({ role: "assistant", content: result, timestamp: new Date() });
      if (history.length > 20) {
        this.conversations.set(userId, history.slice(-20));
      }
      // Persist assistant reply to ConversationMemory
      this.conversationMemory.addTurn(String(userId), "assistant", result, "telegram", task.id).catch(() => {});
      return result;
    } finally {
      eventBus.off("task:created", taskCreatedHandler);
      eventBus.off("mediator:decision", decisionHandler);
    }
  }

  /** Send a long result, splitting if needed (Telegram limit 4096) */
  private async sendResult(ctx: { reply: (text: string) => Promise<unknown> }, result: string): Promise<void> {
    if (result.length <= 4096) {
      await ctx.reply(result);
    } else {
      const chunks = result.match(/.{1,4000}/gs) ?? [result];
      for (const chunk of chunks) await ctx.reply(chunk);
    }
  }

  private setupHandlers(): void {
    const bot = this.bot;

    // Forward critical system alerts to all allowed users via Telegram.
    // MEM-04 fix: store the handler reference so stop() can remove it and prevent
    // listener accumulation on the singleton eventBus when stop() is called repeatedly.
    //
    // RATE LIMIT: Max 1 alert per 30 seconds. If multiple alerts fire in
    // rapid succession (e.g., adversarial tester finding 30+ vulnerabilities),
    // batch them into a single summary message instead of flooding the user.
    let lastAlertSent = 0;
    let pendingAlerts: string[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushAlerts = () => {
      batchTimer = null;
      if (pendingAlerts.length === 0) return;
      const summary = pendingAlerts.length === 1
        ? pendingAlerts[0]!
        : `⚠️ ${pendingAlerts.length} security alerts:\n\n${pendingAlerts.slice(0, 10).map((a, i) => `${i + 1}. ${a}`).join("\n")}${pendingAlerts.length > 10 ? `\n…and ${pendingAlerts.length - 10} more` : ""}`;
      pendingAlerts = [];
      lastAlertSent = Date.now();
      for (const uid of this.allowedUserIds) {
        bot.telegram.sendMessage(uid, summary.slice(0, 4096)).catch(() => {});
      }
    };

    this.alertHandler = (ev: PepagiEvent) => {
      if (ev.type !== "system:alert") return;
      if (this.allowedUserIds.length === 0) return;

      const now = Date.now();
      if (now - lastAlertSent > 30_000 && pendingAlerts.length === 0) {
        // Enough time passed and no batch pending — send immediately
        lastAlertSent = now;
        for (const uid of this.allowedUserIds) {
          bot.telegram.sendMessage(uid, ev.message.slice(0, 4096)).catch(() => {});
        }
      } else {
        // Batch: accumulate and flush after 30s window
        pendingAlerts.push(ev.message);
        if (!batchTimer) {
          batchTimer = setTimeout(flushAlerts, 30_000);
        }
      }
    };
    // MEM-04 fix: registered via onAny so the stored reference can be removed in stop()
    eventBus.onAny(this.alertHandler);

    // FIX: store goal_result handler for cleanup in stop()
    this.goalResultHandler = (ev: PepagiEvent) => {
      if (ev.type !== "system:goal_result") return;
      const targetId = ev.userId ? parseInt(ev.userId, 10) : null;
      if (targetId && !isNaN(targetId)) {
        // Send directly to the configured user
        const text = ev.message.length <= 4096 ? ev.message : ev.message.slice(0, 4000) + "…";
        bot.telegram.sendMessage(targetId, text).catch(() => {});
      } else {
        // Fallback to broadcast
        for (const uid of this.allowedUserIds) {
          bot.telegram.sendMessage(uid, ev.message.slice(0, 4096)).catch(() => {});
        }
      }
    };
    eventBus.onAny(this.goalResultHandler);

    // /start command
    bot.command("start", async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) {
        await ctx.reply("⛔ Přístup odepřen.");
        return;
      }
      this.conversations.delete(userId);
      await ctx.reply(
        this.welcomeMessage +
        "\n\n📋 Příkazy:\n/start — reset\n/status — stav systému\n/clear — vymazat historii\n/goals — naplánované úkoly\n/memory — paměť a znalosti\n/skills — aktivní skills\n/tts <text> — hlasová odpověď\n\n" +
        "💬 Umím pracovat s:\n• Textovými zprávami\n• 🎤 Hlasovými zprávami (přepis + odpověď)\n• 📷 Fotkami (vidím a popis)\n• 📄 Dokumenty (.txt, .docx, .pdf)",
      );
    });

    // /status command
    bot.command("status", async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) { await ctx.reply("⛔"); return; }
      const stats = this.taskStore.getStats();
      await ctx.reply(
        `📊 PEPAGI Status\n\nÚlohy: ${stats.total} celkem\n` +
        `✓ Dokončeno: ${stats.completed}\n✗ Selhalo: ${stats.failed}\n⏳ Běží: ${stats.running}`,
      );
    });

    // /clear command
    bot.command("clear", async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) { await ctx.reply("⛔"); return; }
      this.conversations.delete(ctx.from.id);
      await this.conversationMemory.clearHistory(String(ctx.from.id), "telegram");
      await ctx.reply("🧹 Konverzace vymazána.");
    });

    // /goals command — list, enable, disable, run
    bot.command("goals", async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) { await ctx.reply("⛔"); return; }
      // SECURITY: SEC-05 — Restrict admin commands to DM only
      if (this.isGroupChat(ctx)) { await ctx.reply("⛔ Tento příkaz je dostupný pouze v přímé zprávě."); return; }
      if (!this.goalManager) {
        await ctx.reply("⚠️ GoalManager není k dispozici.");
        return;
      }

      const args = ctx.message.text.replace(/^\/goals\s*/i, "").trim().split(/\s+/);
      const sub = args[0]?.toLowerCase() ?? "list";

      if (sub === "list" || sub === "") {
        const goals = this.goalManager.listGoals();
        if (goals.length === 0) {
          await ctx.reply("📋 Žádné goals nejsou definovány.\n\nVytvoř je v ~/.pepagi/goals.json");
          return;
        }
        const lines = goals.map(g => {
          const status = g.enabled ? "✅" : "⏸️";
          const next = g.enabled && g.nextTriggerMs !== null
            ? ` (za ${Math.round(g.nextTriggerMs / 60_000)} min)`
            : "";
          const last = g.lastTriggered
            ? ` | naposledy: ${new Date(g.lastTriggered).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}`
            : "";
          return `${status} *${g.name}*${next}\n  📅 ${g.schedule}${last}\n  💬 ${g.description}`;
        }).join("\n\n");
        await ctx.reply(`🎯 *Goals (${goals.length}):*\n\n${lines}\n\n📌 Příkazy: /goals enable <name> | /goals disable <name> | /goals run <name>`, { parse_mode: "Markdown" });

      } else if (sub === "enable" || sub === "disable") {
        const name = args.slice(1).join(" ");
        if (!name) { await ctx.reply(`Použití: /goals ${sub} <název>`); return; }
        const ok = await this.goalManager.toggleGoal(name, sub === "enable");
        if (ok) {
          await ctx.reply(`${sub === "enable" ? "✅ Goal zapnut" : "⏸️ Goal vypnut"}: *${name}*`, { parse_mode: "Markdown" });
        } else {
          await ctx.reply(`❌ Goal "${name}" nenalezen. Zkontroluj /goals list`);
        }

      } else if (sub === "run") {
        const name = args.slice(1).join(" ");
        if (!name) { await ctx.reply("Použití: /goals run <název>"); return; }
        const goals = this.goalManager.listGoals();
        const goal = goals.find(g => g.name === name);
        if (!goal) { await ctx.reply(`❌ Goal "${name}" nenalezen.`); return; }
        await ctx.reply(`⚙️ Spouštím goal *${name}*…`, { parse_mode: "Markdown" });
        // triggerGoal is private — add goal temporarily to force it via addGoal trick
        // Instead: directly submit the prompt as a task
        const task = this.taskStore.create({
          title: `[Goal:run] ${goal.name}`,
          description: goal.prompt,
          priority: "low",
        });
        try {
          const output = await this.mediator.processTask(task.id);
          const result = output.success
            ? (typeof output.result === "string" ? output.result : output.summary)
            : `❌ Goal selhal: ${output.summary}`;
          await this.sendResult(ctx, `🎯 *${name}*\n\n${result}`);
        } catch (err) {
          // SEC-12 fix: log full error internally, send only a generic message to the user
          logger.error("Goal run error", { goal: name, error: String(err) });
          await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
        }

      } else {
        await ctx.reply("📋 Použití:\n/goals list — zobrazit všechny\n/goals enable <name> — zapnout\n/goals disable <name> — vypnout\n/goals run <name> — spustit ihned");
      }
    });

    // /memory command — show memory stats and recent content
    bot.command("memory", async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) { await ctx.reply("⛔"); return; }
      // SECURITY: SEC-05 — Restrict admin commands to DM only
      if (this.isGroupChat(ctx)) { await ctx.reply("⛔ Tento příkaz je dostupný pouze v přímé zprávě."); return; }
      if (!this.memory) {
        await ctx.reply("⚠️ Memory system není k dispozici.");
        return;
      }

      const args = ctx.message.text.replace(/^\/memory\s*/i, "").trim().toLowerCase();
      await ctx.sendChatAction("typing");

      try {
        if (args === "facts" || args === "fakta") {
          const facts = await this.memory.semantic.search("", 10);
          if (facts.length === 0) { await ctx.reply("📚 Žádné uložené faktické znalosti."); return; }
          const text = facts.map((f, i) => `${i + 1}. ${f.fact}\n   _conf: ${(f.confidence * 100).toFixed(0)}%_`).join("\n\n");
          await ctx.reply(`📚 *Fakta (${facts.length}):*\n\n${text}`, { parse_mode: "Markdown" });

        } else if (args === "episodes" || args === "epizody") {
          const episodes = await this.memory.episodic.search("", 8);
          if (episodes.length === 0) { await ctx.reply("📖 Žádné epizody."); return; }
          const text = episodes.map((e, i) => {
            const date = new Date(e.timestamp).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
            return `${i + 1}. ${e.success ? "✅" : "❌"} *${e.taskTitle}*\n   ${date}\n   ${e.resultSummary.slice(0, 80)}`;
          }).join("\n\n");
          await ctx.reply(`📖 *Epizody (${episodes.length}):*\n\n${text}`, { parse_mode: "Markdown" });

        } else if (args === "procedures" || args === "procedury") {
          const procs = await this.memory.procedural.getReliable();
          if (procs.length === 0) { await ctx.reply("⚙️ Žádné procedury."); return; }
          const text = procs.map((p, i) => `${i + 1}. *${p.name}* (${p.timesUsed}× | ${(p.successRate * 100).toFixed(0)}% úspěch)`).join("\n");
          await ctx.reply(`⚙️ *Procedury (${procs.length}):*\n\n${text}`, { parse_mode: "Markdown" });

        } else {
          // Default: stats overview
          const stats = await this.memory.getStats();
          const ep = stats.episodic as { total: number; successRate: number; avgCost: number };
          const sem = stats.semantic as { total: number; avgConfidence: number };
          const proc = stats.procedural as { total: number; reliable: number; avgSuccessRate: number };
          await ctx.reply(
            `🧠 *Memory System*\n\n` +
            `📖 Epizody: ${ep.total ?? 0} (úspěšnost ${((ep.successRate ?? 0) * 100).toFixed(0)}%)\n` +
            `📚 Fakta: ${sem.total ?? 0} (avg. jistota ${((sem.avgConfidence ?? 0) * 100).toFixed(0)}%)\n` +
            `⚙️ Procedury: ${proc.total ?? 0} (${proc.reliable ?? 0} spolehlivých)\n\n` +
            `📌 Detaily: /memory facts | /memory episodes | /memory procedures`,
            { parse_mode: "Markdown" }
          );
        }
      } catch (err) {
        // SEC-12 fix: log full error internally, send only a generic message to the user
        logger.error("Memory command error", { userId: ctx.from.id, error: String(err) });
        await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    // /skills command — list loaded dynamic skills
    bot.command("skills", async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) { await ctx.reply("⛔"); return; }
      // SECURITY: SEC-05 — Restrict admin commands to DM only
      if (this.isGroupChat(ctx)) { await ctx.reply("⛔ Tento příkaz je dostupný pouze v přímé zprávě."); return; }
      if (!this.skillRegistry) {
        await ctx.reply("⚠️ SkillRegistry není k dispozici.");
        return;
      }

      const skills = this.skillRegistry.list();
      if (skills.length === 0) {
        await ctx.reply("🔌 Žádné skills nejsou načteny.\n\nSkills umístěte do ~/.pepagi/skills/ jako .js soubory.");
        return;
      }

      const text = skills.map((s, i) =>
        `${i + 1}. *${s.name}*\n   ${s.description.slice(0, 80)}\n   🎯 ${s.triggers.slice(0, 2).join(", ")}`
      ).join("\n\n");

      await ctx.reply(`🔌 *Aktivní Skills (${skills.length}):*\n\n${text}`, { parse_mode: "Markdown" });
    });

    // ── Text messages ─────────────────────────────────────────
    bot.on(message("text"), async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) {
        await ctx.reply("⛔ Přístup odepřen. Požádej správce o přidání tvého ID: " + userId);
        return;
      }
      // SECURITY: SEC-30 — Per-user rate limiting
      if (this.rateLimiter.isRateLimited(String(userId))) {
        await ctx.reply("⏳ Příliš mnoho zpráv. Zkuste to za chvíli.");
        return;
      }
      logger.info("Telegram text received", { userId, len: ctx.message.text.length });

      const progressMsg = await ctx.reply("⚙️ _Přemýšlím…_", { parse_mode: "Markdown" });
      const updateProgress = async (text: string) => {
        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text, { parse_mode: "Markdown" }).catch(() => {});
      };

      try {
        const result = await this.runTask(userId, ctx.message.text, ctx.message.text, updateProgress);
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
        await this.sendResult(ctx, result);
        logger.info("Telegram reply sent", { userId });
      } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
        // SEC-12 fix: log full error internally, send only a generic message to the user
        logger.error("Text handler error", { userId, error: String(err) });
        await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    // ── Voice messages 🎤 ─────────────────────────────────────
    bot.on(message("voice"), async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) { await ctx.reply("⛔ Přístup odepřen."); return; }

      await ctx.sendChatAction("typing");
      logger.info("Telegram voice received", { userId, duration: ctx.message.voice.duration });

      try {
        // Download the .ogg voice file
        const audioBuffer = await this.downloadTelegramFile(ctx.message.voice.file_id);

        // Transcribe to text
        let transcription: string;
        try {
          transcription = await this.llm.transcribeAudio(audioBuffer, "cs");
          logger.info("Voice transcribed", { userId, chars: transcription.length });
        } catch (transcribeErr) {
          // SEC-12 fix: log full error internally, send only a generic message to the user
          logger.warn("Voice transcription failed", { userId, error: String(transcribeErr) });
          await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
          return;
        }

        // Show user what was transcribed
        await ctx.reply(`🎤 Přepis: „${transcription}"`);

        const progressMsg = await ctx.reply("⚙️ _Zpracovávám…_", { parse_mode: "Markdown" });
        const updateProgress = async (text: string) => {
          await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text, { parse_mode: "Markdown" }).catch(() => {});
        };

        // Route transcription through mediator
        const result = await this.runTask(
          userId,
          transcription,
          `Hlasová zpráva (${ctx.message.voice.duration}s)`,
          updateProgress,
        );
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
        await this.sendResult(ctx, result);
      } catch (err) {
        // SEC-12 fix: already logged; send only a generic message to the user
        logger.error("Voice handler error", { userId, error: String(err) });
        await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    // ── Photo messages 📷 ─────────────────────────────────────
    bot.on(message("photo"), async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) { await ctx.reply("⛔ Přístup odepřen."); return; }

      const caption = ctx.message.caption ?? "";
      const prompt = caption || "Popiš co vidíš na tomto obrázku. Buď detailní.";
      await ctx.sendChatAction("typing");
      logger.info("Telegram photo received", { userId, hasCaption: !!caption });

      try {
        // Download the largest available photo
        const photos = ctx.message.photo;
        const largestPhoto = photos[photos.length - 1]; // Telegram sorts by size ascending
        const imageBuffer = await this.downloadTelegramFile(largestPhoto.file_id);
        const imageBase64 = imageBuffer.toString("base64");

        // Call vision model directly
        const visionResponse = await this.llm.quickVision(
          "Jsi PEPAGI — AI asistent. Pečlivě analyzuj obrázek a odpověz na dotaz uživatele.",
          prompt,
          imageBase64,
          "image/jpeg",
        );

        const description = visionResponse.content || "Nepodařilo se analyzovat obrázek.";

        // Store in history and reply
        const history = this.getHistory(userId);
        history.push({ role: "user", content: `[Obrázek] ${caption}`, timestamp: new Date() });
        history.push({ role: "assistant", content: description, timestamp: new Date() });
        if (history.length > 20) this.conversations.set(userId, history.slice(-20));

        await this.sendResult(ctx, description);
        logger.info("Photo analyzed and replied", { userId });
      } catch (err) {
        // SEC-12 fix: already logged; send only a generic message to the user
        logger.error("Photo handler error", { userId, error: String(err) });
        await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    // ── Document messages 📄 ──────────────────────────────────
    bot.on(message("document"), async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) { await ctx.reply("⛔ Přístup odepřen."); return; }

      const doc = ctx.message.document;
      const fileName = doc.file_name ?? "soubor";
      const mimeType = doc.mime_type ?? "";
      const caption = ctx.message.caption ?? "";

      await ctx.sendChatAction("typing");

      let fileContent: string;
      try {
        const buffer = await this.downloadTelegramFile(doc.file_id);

        const isDocx = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          || fileName.toLowerCase().endsWith(".docx");
        const isText = mimeType.startsWith("text/")
          || fileName.toLowerCase().endsWith(".txt")
          || fileName.toLowerCase().endsWith(".md")
          || fileName.toLowerCase().endsWith(".csv");
        const isAudio = mimeType.startsWith("audio/")
          || fileName.toLowerCase().match(/\.(mp3|m4a|ogg|wav|opus|flac)$/) !== null;

        if (isDocx) {
          const mammoth = await import("mammoth");
          const result = await mammoth.extractRawText({ buffer });
          fileContent = `Obsah dokumentu „${fileName}":\n\n${result.value.trim()}`;
        } else if (isText) {
          fileContent = `Obsah souboru „${fileName}":\n\n${buffer.toString("utf8").slice(0, 20000)}`;
        } else if (isAudio) {
          // Audio file sent as document — transcribe it
          await ctx.reply(`🎵 Přepisuji audio soubor „${fileName}"…`);
          try {
            const transcription = await this.llm.transcribeAudio(buffer, "cs");
            fileContent = `Přepis audio souboru „${fileName}":\n\n${transcription}`;
          } catch (transcribeErr) {
            fileContent = `Audio soubor „${fileName}" — přepis se nezdařil: ${transcribeErr instanceof Error ? transcribeErr.message : String(transcribeErr)}`;
          }
        } else {
          fileContent = `Uživatel zaslal soubor „${fileName}" (typ: ${mimeType || "neznámý"}, velikost: ${doc.file_size ?? 0} B). Soubor tohoto typu neumím přečíst — pošli ho jako .docx nebo .txt.`;
        }
      } catch (err) {
        fileContent = `Nepodařilo se načíst soubor „${fileName}": ${String(err)}`;
      }

      const fullPrompt = caption ? `${caption}\n\n${fileContent}` : fileContent;

      const progressMsg = await ctx.reply("⚙️ _Analyzuji dokument…_", { parse_mode: "Markdown" });
      const updateProgress = async (text: string) => {
        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text, { parse_mode: "Markdown" }).catch(() => {});
      };

      try {
        const result = await this.runTask(userId, fullPrompt, `Dokument: ${fileName.slice(0, 70)}`, updateProgress);
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
        await this.sendResult(ctx, result);
      } catch (err) {
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
        // SEC-12 fix: log full error internally, send only a generic message to the user
        logger.error("Document handler error", { userId, error: String(err) });
        await ctx.reply("Nastala interní chyba. Zkuste to prosím znovu.");
      }
    });

    // ── /tts — respond with voice message ────────────────────
    bot.command("tts", async (ctx) => {
      const userId = ctx.from.id;
      if (!this.isAllowed(userId)) { await ctx.reply("⛔ Přístup odepřen."); return; }
      // SECURITY: SEC-05 — Restrict admin commands to DM only
      if (this.isGroupChat(ctx)) { await ctx.reply("⛔ Tento příkaz je dostupný pouze v přímé zprávě."); return; }

      const text = ctx.message.text.replace(/^\/tts\s*/i, "").trim();
      if (!text) {
        await ctx.reply("Použití: /tts <text>\nPříklad: /tts Dobrý den, jak se máš?");
        return;
      }

      await ctx.sendChatAction("upload_voice");

      try {
        const { execFile } = await import("node:child_process");
        const { promisify: prom } = await import("node:util");
        const execFileAsync = prom(execFile);
        const { mkdirSync, existsSync } = await import("node:fs");
        const { join: j } = await import("node:path");
        const { tmpdir } = await import("node:os");

        const tmpDir = j(tmpdir(), "pepagi-tts");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

        const aiffPath = j(tmpDir, `tts_${Date.now()}.aiff`);
        const mp3Path = aiffPath.replace(".aiff", ".mp3");
        const safeText = text.replace(/'/g, " ").slice(0, 1500);

        await execFileAsync("say", ["-v", "Zuzana", "-o", aiffPath, safeText], { timeout: 30_000 });

        // Try ffmpeg conversion to mp3
        let audioPath = aiffPath;
        try {
          await execFileAsync("ffmpeg", ["-y", "-i", aiffPath, mp3Path], { timeout: 30_000 });
          audioPath = mp3Path;
        } catch {
          // ffmpeg not available, use aiff directly
        }

        const { createReadStream } = await import("node:fs");
        await ctx.replyWithVoice({ source: createReadStream(audioPath) });
        logger.info("TTS voice sent", { userId, chars: text.length });
      } catch (err) {
        // SEC-12 fix: log full error internally, send only a generic message to the user
        logger.warn("TTS failed", { userId, error: String(err) });
        await ctx.reply(`Nastala interní chyba. Zkuste to prosím znovu.\n\nTextová odpověď:\n${text}`);
      }
    });

    // ── Sticker — friendly response ───────────────────────────
    bot.on(message("sticker"), async (ctx) => {
      if (!this.isAllowed(ctx.from.id)) return;
      const emoji = ctx.message.sticker.emoji ?? "😊";
      await ctx.reply(`${emoji} Sticker přijat! Napiš mi co chceš udělat.`);
    });

    // Error handler
    bot.catch((err, ctx) => {
      logger.error("Telegraf error", { error: String(err), update: ctx.updateType });
    });
  }

  async start(): Promise<void> {
    // AUDIT: warn if allowedUserIds is empty — bot will accept messages from anyone
    if (this.allowedUserIds.length === 0) {
      logger.warn("Telegram allowedUserIds is empty — bot accepts messages from ALL users");
    }
    logger.info("Starting Telegram bot...");
    // Timeout: Telegraf's launch() can hang if a previous long-poll connection
    // is still active on Telegram's servers (up to 90s after kill).
    const launchTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Telegram bot launch timed out after 30s — retrying in background")), 30_000),
    );
    try {
      await Promise.race([this.bot.launch({ dropPendingUpdates: true }), launchTimeout]);
    } catch (err) {
      logger.warn("Telegram launch timed out, retrying in background...", { error: String(err) });
      // Retry in background after old polling connection expires
      setTimeout(() => {
        this.bot.launch({ dropPendingUpdates: true })
          .then(() => logger.info("Telegram bot started ✓ (delayed)"))
          .catch(e => logger.error("Telegram bot background launch failed", { error: String(e) }));
      }, 35_000);
      return; // don't block daemon startup
    }
    logger.info("Telegram bot started ✓");
    // Store signal handlers so they can be removed in stop() — prevents MaxListenersExceeded
    this._sigintHandler = () => this.bot.stop("SIGINT");
    this._sigtermHandler = () => this.bot.stop("SIGTERM");
    process.once("SIGINT", this._sigintHandler);
    process.once("SIGTERM", this._sigtermHandler);
  }

  async stop(): Promise<void> {
    // MEM-04 fix: remove the system:alert listener to prevent accumulation on
    // the singleton eventBus when the platform is stopped and restarted.
    if (this.alertHandler) {
      eventBus.offAny(this.alertHandler);
      this.alertHandler = null;
    }
    // FIX: remove goal_result listener to prevent accumulation
    if (this.goalResultHandler) {
      eventBus.offAny(this.goalResultHandler);
      this.goalResultHandler = null;
    }
    // Remove signal handlers to prevent MaxListenersExceeded on restart
    if (this._sigintHandler) { process.removeListener("SIGINT", this._sigintHandler); this._sigintHandler = null; }
    if (this._sigtermHandler) { process.removeListener("SIGTERM", this._sigtermHandler); this._sigtermHandler = null; }
    this.bot.stop();
    logger.info("Telegram bot stopped.");
  }
}
