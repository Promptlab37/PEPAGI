// ═══════════════════════════════════════════════════════════════
// PEPAGI — iMessage Platform (macOS only)
// Uses AppleScript to send/receive iMessages
// ═══════════════════════════════════════════════════════════════

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { eventBus } from "../core/event-bus.js";
import type { PepagiEvent } from "../core/types.js";
import { Logger } from "../core/logger.js";
import type { Mediator } from "../core/mediator.js";
import type { TaskStore } from "../core/task-store.js";
// SECURITY: SEC-30 — Per-user rate limiting
import { RateLimiter } from "../security/rate-limiter.js";

const execAsync = promisify(exec);
const logger = new Logger("iMessage");

export interface iMessageConfig {
  enabled: boolean;
  allowedNumbers: string[];
}

export class iMessagePlatform {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  // AUD-08: store listener reference for cleanup in stop()
  private alertListener: ((ev: Extract<PepagiEvent, { type: "system:alert" }>) => void) | null = null;
  // BUG-09: Use the same Apple-epoch formula as pollMessages() so the first poll
  // correctly returns only messages received after daemon start, not zero messages.
  private lastChecked: number = Math.floor((Date.now() / 1000 - 978_307_200) * 1_000_000_000);
  private running = false;
  // SECURITY: SEC-30 — 10 messages/min per user (lower for iMessage due to AppleScript costs)
  private rateLimiter = new RateLimiter(10, 60_000, "imessage");

  constructor(
    private config: iMessageConfig,
    private mediator: Mediator,
    private taskStore: TaskStore,
  ) {}

  /**
   * Start the iMessage polling loop (polls every 30 seconds for new messages).
   */
  async start(): Promise<void> {
    if (process.platform !== "darwin") {
      logger.warn("iMessage platform is only supported on macOS — skipping");
      return;
    }

    if (!this.config.enabled) {
      logger.info("iMessage platform is disabled");
      return;
    }

    logger.info("Starting iMessage platform (macOS)...");
    this.running = true;
    // BUG-09: Re-initialize with the correct Apple-epoch formula so the first poll
    // window is anchored at daemon-start time (same formula used in pollMessages).
    this.lastChecked = Math.floor((Date.now() / 1000 - 978_307_200) * 1_000_000_000);

    // Forward system alerts to allowed numbers
    // RATE LIMIT: batch rapid alerts into summaries (max 1 per 30s)
    let lastImsgAlert = 0;
    let pendingImsgAlerts: string[] = [];
    let imsgBatchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushImsgAlerts = () => {
      imsgBatchTimer = null;
      if (pendingImsgAlerts.length === 0) return;
      const summary = pendingImsgAlerts.length === 1
        ? pendingImsgAlerts[0]!
        : `${pendingImsgAlerts.length} security alerts:\n${pendingImsgAlerts.slice(0, 10).map((a, i) => `${i + 1}. ${a}`).join("\n")}${pendingImsgAlerts.length > 10 ? `\n…and ${pendingImsgAlerts.length - 10} more` : ""}`;
      pendingImsgAlerts = [];
      lastImsgAlert = Date.now();
      for (const number of this.config.allowedNumbers) {
        this.sendMessage(number, summary).catch(() => {});
      }
    };

    this.alertListener = (ev: Extract<PepagiEvent, { type: "system:alert" }>) => {
      if (this.config.allowedNumbers.length === 0) return;
      const now = Date.now();
      if (now - lastImsgAlert > 30_000 && pendingImsgAlerts.length === 0) {
        lastImsgAlert = now;
        for (const number of this.config.allowedNumbers) {
          this.sendMessage(number, ev.message).catch(() => {});
        }
      } else {
        pendingImsgAlerts.push(ev.message);
        if (!imsgBatchTimer) {
          imsgBatchTimer = setTimeout(flushImsgAlerts, 30_000);
        }
      }
    };
    eventBus.on("system:alert", this.alertListener);

    // Poll every 30 seconds
    this.pollingTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        logger.warn("iMessage poll error", { error: String(err) });
      });
    }, 30_000);

    logger.info("iMessage platform started — polling every 30s");
  }

  /**
   * Stop the iMessage polling loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    // AUD-08: remove eventBus listener to prevent leaks
    if (this.alertListener) {
      eventBus.off("system:alert", this.alertListener);
      this.alertListener = null;
    }
    logger.info("iMessage platform stopped.");
  }

  /**
   * Send an iMessage to a phone number or Apple ID via AppleScript.
   * @param to - Phone number or Apple ID (e.g. "+1234567890" or "user@example.com")
   * @param text - Message text to send
   */
  async sendMessage(to: string, text: string): Promise<void> {
    if (process.platform !== "darwin") return;

    // SEC-07: Validate `to` strictly before injecting it into AppleScript.
    // Simply stripping `"` is not sufficient — a crafted value could still break
    // out of the AppleScript template. Only phone numbers and Apple-ID emails are
    // accepted; anything else is rejected with an error.
    const RECIPIENT_RE = /^(\+?[0-9\s\-()]{7,20}|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})$/;
    if (!RECIPIENT_RE.test(to.trim())) {
      throw new Error(`iMessage: invalid recipient "${to}" — must be a phone number or Apple ID email`);
    }
    const safeTo = to.trim(); // validated above; no further escaping needed

    // Escape text for AppleScript (escape double quotes and backslashes)
    const safeText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 2000);

    const script = `tell application "Messages"
  set targetBuddy to buddy "${safeTo}" of service "iMessage"
  send "${safeText}" to targetBuddy
end tell`;

    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 15_000 });
      logger.debug("iMessage sent", { to, chars: text.length });
    } catch (err) {
      logger.warn("iMessage send failed", { to, error: String(err) });
      throw err;
    }
  }

  /**
   * Poll the iMessage SQLite database for new incoming messages.
   */
  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    const dbPath = `${process.env.HOME ?? "~"}/Library/Messages/chat.db`;
    // SEC-18: Use ASCII unit-separator (char(31) in SQLite) instead of "|" so that
    // message bodies containing "|" no longer corrupt sender parsing. The separator
    // is extremely unlikely to appear in real message text.
    const query = `SELECT text || char(31) || handle.id FROM message
JOIN handle ON handle.ROWID = message.handle_id
WHERE message.is_from_me = 0 AND message.date > ${this.lastChecked}
ORDER BY message.date DESC LIMIT 10`;

    let output: string;
    try {
      const { stdout } = await execAsync(`sqlite3 "${dbPath}" "${query}"`, { timeout: 10_000 });
      output = stdout.trim();
    } catch (err) {
      // sqlite3 may not be available or DB locked — silently skip
      logger.debug("iMessage DB query failed", { error: String(err) });
      return;
    }

    // Update lastChecked to now (Apple time: nanoseconds since 2001-01-01)
    const appleEpochOffset = 978_307_200; // seconds between Unix epoch and Apple epoch
    this.lastChecked = Math.floor((Date.now() / 1000 - appleEpochOffset) * 1_000_000_000);

    if (!output) return;

    // SEC-18: Split on the ASCII unit-separator (\x1F) that was used in the query,
    // so message bodies containing "|" no longer corrupt sender field parsing.
    const UNIT_SEP = "\x1f";
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      const sepIdx = line.indexOf(UNIT_SEP);
      if (sepIdx === -1) continue;

      const text = line.slice(0, sepIdx).trim();
      const sender = line.slice(sepIdx + 1).trim();

      if (!text || !sender) continue;

      // SECURITY: SEC-30 — Only process messages from allowed numbers
      // Uses exact digit-only matching (no partial substring matching)
      if (this.config.allowedNumbers.length > 0) {
        const senderDigits = sender.replace(/\D/g, "");
        const isAllowed = this.config.allowedNumbers.some((num) => {
          const numDigits = num.replace(/\D/g, "");
          return num === sender || senderDigits === numDigits;
        });
        if (!isAllowed) {
          logger.debug("iMessage: ignoring message from unlisted number", { sender });
          continue;
        }
      }

      // SECURITY: SEC-30 — Per-user rate limiting
      if (this.rateLimiter.isRateLimited(sender)) {
        logger.debug("iMessage: rate limited", { sender });
        continue;
      }

      logger.info("iMessage received", { sender, chars: text.length });
      this.handleMessage(sender, text).catch((err) => {
        logger.warn("iMessage handler error", { sender, error: String(err) });
      });
    }
  }

  /**
   * Handle an incoming iMessage by routing it through the Mediator.
   * @param sender - Sender phone number or Apple ID
   * @param text - Message content
   */
  private async handleMessage(sender: string, text: string): Promise<void> {
    try {
      const task = this.taskStore.create({
        title: text.slice(0, 80),
        description: text,
        priority: "medium",
      });

      const output = await this.mediator.processTask(task.id);
      const result = output.success
        ? (typeof output.result === "string" ? output.result : output.summary)
        : `Error: ${output.summary}`;

      await this.sendMessage(sender, result);
      logger.info("iMessage reply sent", { sender });
    } catch (err) {
      logger.error("iMessage task processing failed", { sender, error: String(err) });
      try {
        await this.sendMessage(sender, `Sorry, an error occurred: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // Ignore send failure in error path
      }
    }
  }
}
