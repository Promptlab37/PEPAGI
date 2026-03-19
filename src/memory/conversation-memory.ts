// ═══════════════════════════════════════════════════════════════
// PEPAGI — ConversationMemory (Audit #6 — HIGH PRIORITY)
// Persistent per-user conversation history across sessions.
// Stored in ~/.pepagi/memory/conversations/<userId>.jsonl
// ═══════════════════════════════════════════════════════════════

// OPUS: rename was dynamically imported inside saveSession() on every call — moved to top-level
import { readFile, writeFile, mkdir, appendFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../core/logger.js";

const logger = new Logger("ConversationMemory");

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  /** Optional task ID that produced this assistant reply */
  taskId?: string;
  /** Platform this turn came from (telegram, whatsapp, cli) */
  platform?: string;
}

export interface ConversationSession {
  userId: string;
  platform: string;
  turns: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
  /** Running summary of older turns (to avoid unbounded growth) */
  summary?: string;
}

const CONVERSATIONS_DIR = join(
  process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi"),
  "memory",
  "conversations",
);

/** Max turns kept in memory before compressing older ones into summary */
const MAX_TURNS_BEFORE_SUMMARY = 40;
const MAX_TURNS_IN_MEMORY = 20; // keep last N for active context
// AUD-06: cap in-memory sessions to prevent unbounded Map growth
const MAX_CACHED_SESSIONS = 500;

export class ConversationMemory {
  private sessions = new Map<string, ConversationSession>();

  /** Initialize directory */
  async init(): Promise<void> {
    await mkdir(CONVERSATIONS_DIR, { recursive: true });
  }

  /** Unique key for a user+platform combination */
  private key(userId: string, platform: string): string {
    return `${platform}:${userId}`;
  }

  private filePath(userId: string, platform: string): string {
    // Sanitize userId for filesystem safety
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safePlatform = platform.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(CONVERSATIONS_DIR, `${safePlatform}_${safeId}.json`);
  }

  /**
   * SECURITY: SEC-05 — Verify that the requesting userId owns this session.
   * Prevents cross-user session access in group chats or multi-tenant scenarios.
   */
  verifyOwnership(session: ConversationSession, requestingUserId: string): boolean {
    return session.userId === requestingUserId;
  }

  /** Load session from disk (or create empty). Cached in memory. */
  async getSession(userId: string, platform = "cli"): Promise<ConversationSession> {
    const k = this.key(userId, platform);
    if (this.sessions.has(k)) return this.sessions.get(k)!;

    const path = this.filePath(userId, platform);
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, "utf8");
        const session = JSON.parse(raw) as ConversationSession;
        this.sessions.set(k, session);
        return session;
      } catch (err) {
        logger.warn("Failed to load conversation session", { userId, platform, err: String(err) });
      }
    }

    const session: ConversationSession = {
      userId,
      platform,
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // AUD-06: evict oldest cached sessions if we exceed the cap
    if (this.sessions.size >= MAX_CACHED_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(k, session);
    return session;
  }

  /** Save session to disk (atomic write) */
  private async saveSession(session: ConversationSession): Promise<void> {
    const path = this.filePath(session.userId, session.platform);
    const tmp = path + ".tmp";
    session.updatedAt = new Date().toISOString();
    await writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
    // OPUS: atomic rename — rename is now a top-level import
    await rename(tmp, path);
  }

  /**
   * Add a message turn to the conversation.
   * @param userId - User or session identifier
   * @param role - "user" | "assistant" | "system"
   * @param content - Message content
   * @param platform - Platform name (telegram, whatsapp, cli)
   * @param taskId - Optional task ID
   */
  async addTurn(
    userId: string,
    role: "user" | "assistant" | "system",
    content: string,
    platform = "cli",
    taskId?: string,
  ): Promise<void> {
    const session = await this.getSession(userId, platform);
    session.turns.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      taskId,
      platform,
    });

    // Compress if too long
    if (session.turns.length > MAX_TURNS_BEFORE_SUMMARY) {
      const older = session.turns.splice(0, session.turns.length - MAX_TURNS_IN_MEMORY);
      const olderText = older.map(t => `${t.role}: ${t.content}`).join("\n");
      session.summary = (session.summary ? session.summary + "\n\n" : "") +
        `[Starší část konverzace — ${older.length} zpráv]:\n${olderText.slice(0, 2000)}`;
      logger.debug("Compressed conversation turns", { userId, platform, compressed: older.length });
    }

    await this.saveSession(session);
  }

  /**
   * Get recent turns for context injection into prompts.
   * Returns the last `n` turns plus any compressed summary prefix.
   * @param userId
   * @param platform
   * @param n - Number of recent turns to return (default 10)
   */
  async getContext(userId: string, platform = "cli", n = 10): Promise<string> {
    const session = await this.getSession(userId, platform);
    const recent = session.turns.slice(-n);
    if (recent.length === 0 && !session.summary) return "";

    const parts: string[] = [];
    if (session.summary) {
      parts.push(`[Souhrn předchozí konverzace]:\n${session.summary.slice(0, 800)}`);
    }
    if (recent.length > 0) {
      parts.push(recent.map(t => `${t.role === "user" ? "User" : "PEPAGI"}: ${t.content}`).join("\n"));
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * Get raw recent turns (for platforms that manage their own display).
   */
  async getRecentTurns(userId: string, platform = "cli", n = 10): Promise<ConversationTurn[]> {
    const session = await this.getSession(userId, platform);
    return session.turns.slice(-n);
  }

  /** Clear conversation history for a user */
  async clearHistory(userId: string, platform = "cli"): Promise<void> {
    const k = this.key(userId, platform);
    const session: ConversationSession = {
      userId,
      platform,
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(k, session);
    await this.saveSession(session);
    logger.info("Cleared conversation history", { userId, platform });
  }

  /** Stats for all sessions */
  getSummaryStats(): { totalSessions: number; totalTurns: number } {
    let totalTurns = 0;
    for (const s of this.sessions.values()) totalTurns += s.turns.length;
    return { totalSessions: this.sessions.size, totalTurns };
  }

  /**
   * Append a raw log entry (for audit trail of conversations).
   * Written to ~/.pepagi/memory/conversations/audit.jsonl
   */
  async logEntry(userId: string, platform: string, role: string, content: string): Promise<void> {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      userId,
      platform,
      role,
      content: content.slice(0, 500), // truncate for audit log
    });
    const auditPath = join(CONVERSATIONS_DIR, "audit.jsonl");
    // FIX: log audit write failures
    await appendFile(auditPath, entry + "\n", "utf8").catch(e => logger.debug("FIX: conversation audit write failed", { error: String(e) }));
  }
}
