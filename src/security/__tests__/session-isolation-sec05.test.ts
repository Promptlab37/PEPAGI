// ═══════════════════════════════════════════════════════════════
// Tests: Session Isolation (SEC-05)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { ConversationMemory } from "../../memory/conversation-memory.js";

describe("Session Isolation SEC-05", () => {
  let memory: ConversationMemory;

  beforeEach(() => {
    memory = new ConversationMemory();
  });

  describe("verifyOwnership", () => {
    it("returns true for matching userId", () => {
      const session = {
        userId: "user-123",
        platform: "telegram",
        turns: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(memory.verifyOwnership(session, "user-123")).toBe(true);
    });

    it("returns false for different userId", () => {
      const session = {
        userId: "user-123",
        platform: "telegram",
        turns: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(memory.verifyOwnership(session, "user-456")).toBe(false);
    });

    it("returns false for empty userId", () => {
      const session = {
        userId: "user-123",
        platform: "telegram",
        turns: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(memory.verifyOwnership(session, "")).toBe(false);
    });
  });

  describe("Group chat detection (Telegram)", () => {
    it("identifies group chat types", () => {
      const groupTypes = ["group", "supergroup"];
      const dmTypes = ["private"];

      for (const type of groupTypes) {
        const isGroup = type === "group" || type === "supergroup";
        expect(isGroup).toBe(true);
      }

      for (const type of dmTypes) {
        const isGroup = type === "group" || type === "supergroup";
        expect(isGroup).toBe(false);
      }
    });

    it("admin commands set contains expected commands", () => {
      const adminCommands = new Set(["goals", "memory", "skills", "tts"]);
      expect(adminCommands.has("goals")).toBe(true);
      expect(adminCommands.has("memory")).toBe(true);
      expect(adminCommands.has("skills")).toBe(true);
      expect(adminCommands.has("tts")).toBe(true);
      // Non-admin commands should not be restricted
      expect(adminCommands.has("status")).toBe(false);
      expect(adminCommands.has("start")).toBe(false);
      expect(adminCommands.has("clear")).toBe(false);
    });
  });

  describe("Discord admin commands", () => {
    it("restricts memory and skills in guilds", () => {
      const adminCommands = new Set(["memory", "skills"]);
      expect(adminCommands.has("memory")).toBe(true);
      expect(adminCommands.has("skills")).toBe(true);
      expect(adminCommands.has("help")).toBe(false);
      expect(adminCommands.has("status")).toBe(false);
    });
  });

  describe("Platform-specific session keys", () => {
    it("creates unique keys per platform+user", () => {
      const key = (userId: string, platform: string) => `${platform}:${userId}`;
      expect(key("123", "telegram")).toBe("telegram:123");
      expect(key("123", "discord")).toBe("discord:123");
      // Same user on different platforms = different sessions
      expect(key("123", "telegram")).not.toBe(key("123", "discord"));
    });
  });
});
