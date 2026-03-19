// ═══════════════════════════════════════════════════════════════
// Tests: Credential Scrubber (SEC-02)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { scrubCredentials, likelyContainsCredentials } from "../credential-scrubber.js";

describe("CredentialScrubber", () => {
  describe("scrubCredentials", () => {
    it("scrubs Anthropic API keys", () => {
      const text = "Using key sk-ant-api03-abcdefghij1234567890abcdefgh";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[ANTHROPIC_KEY_REDACTED]");
      expect(scrubbed).not.toContain("sk-ant-api03");
      expect(redacted).toContain("anthropic_key");
    });

    it("scrubs OpenAI API keys", () => {
      const text = "key=sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[OPENAI_KEY_REDACTED]");
      expect(redacted).toContain("openai_key");
    });

    it("scrubs Google API keys", () => {
      const text = "google: AIzaSyB12345678901234567890123456789ABCD";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[GOOGLE_KEY_REDACTED]");
      expect(redacted).toContain("google_key");
    });

    it("scrubs Telegram bot tokens", () => {
      const text = "Bot 1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ1234567890a";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[TELEGRAM_TOKEN_REDACTED]");
      expect(redacted).toContain("telegram_token");
    });

    it("scrubs SSH private keys", () => {
      const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...long key content...\n-----END RSA PRIVATE KEY-----";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[SSH_KEY_REDACTED]");
      expect(redacted).toContain("ssh_key");
    });

    it("scrubs credit card numbers", () => {
      const text = "Card: 4111 1111 1111 1111";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[CARD_REDACTED]");
      expect(redacted).toContain("credit_card");
    });

    it("scrubs password assignments", () => {
      const text = 'password=mysuperSecretPassword123';
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[REDACTED]");
      expect(scrubbed).not.toContain("mysuperSecret");
      expect(redacted).toContain("password_field");
    });

    it("scrubs email addresses", () => {
      const text = "Contact: user@example.com for support";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toContain("[EMAIL_REDACTED]");
      expect(redacted).toContain("email");
    });

    it("handles multiple credential types in same text", () => {
      const text = "key=sk-ant-api03-12345678901234567890 email=admin@company.com";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(redacted.length).toBeGreaterThanOrEqual(2);
      expect(scrubbed).not.toContain("sk-ant-api03");
      expect(scrubbed).not.toContain("admin@company.com");
    });

    it("does not modify text without credentials", () => {
      const text = "This is a normal log message about task processing";
      const { scrubbed, redacted } = scrubCredentials(text);
      expect(scrubbed).toBe(text);
      expect(redacted).toHaveLength(0);
    });

    it("preserves surrounding text", () => {
      const text = "Error: API call failed with key sk-ant-api03-abcdef12345678901234 at timestamp 12:00";
      const { scrubbed } = scrubCredentials(text);
      expect(scrubbed).toContain("Error: API call failed with key");
      expect(scrubbed).toContain("at timestamp 12:00");
    });
  });

  describe("likelyContainsCredentials", () => {
    it("returns true for text with API keys", () => {
      expect(likelyContainsCredentials("sk-ant-api03-abcdefghij1234567890abcdefgh")).toBe(true);
    });

    it("returns false for clean text", () => {
      expect(likelyContainsCredentials("Just a normal message")).toBe(false);
    });
  });
});
