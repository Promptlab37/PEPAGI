// ═══════════════════════════════════════════════════════════════
// Tests: Side-Channel Attack Mitigation (SEC-19)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  padResponse,
  getPaddedSize,
  getTimingJitter,
  sanitizeLatency,
  sanitizeResponseMeta,
  batchTokenCount,
} from "../side-channel.js";

describe("Side-Channel Mitigation SEC-19", () => {
  describe("response padding", () => {
    it("pads short response to 512 bytes", () => {
      const padded = padResponse("hello");
      expect(Buffer.byteLength(padded, "utf8")).toBe(512);
    });

    it("pads to next 512-byte boundary", () => {
      const content = "x".repeat(600);
      const padded = padResponse(content);
      expect(Buffer.byteLength(padded, "utf8")).toBe(1024);
    });

    it("preserves original content", () => {
      const content = "important data";
      const padded = padResponse(content);
      expect(padded.trimEnd()).toBe(content);
    });

    it("content exactly at boundary is not padded further", () => {
      const content = "x".repeat(512);
      const padded = padResponse(content);
      expect(padded.length).toBe(512);
    });

    it("different messages get same padded size", () => {
      const short = padResponse("hi");
      const medium = padResponse("hello world this is a test");
      expect(Buffer.byteLength(short, "utf8")).toBe(Buffer.byteLength(medium, "utf8"));
    });
  });

  describe("getPaddedSize", () => {
    it("returns 512 for short content", () => {
      expect(getPaddedSize("test")).toBe(512);
    });

    it("returns 1024 for >512 byte content", () => {
      expect(getPaddedSize("x".repeat(600))).toBe(1024);
    });
  });

  describe("timing jitter", () => {
    it("returns value in 10-50ms range", () => {
      for (let i = 0; i < 20; i++) {
        const jitter = getTimingJitter();
        expect(jitter).toBeGreaterThanOrEqual(10);
        expect(jitter).toBeLessThanOrEqual(50);
      }
    });

    it("varies across calls (not constant)", () => {
      const values = new Set<number>();
      for (let i = 0; i < 20; i++) {
        values.add(Math.round(getTimingJitter()));
      }
      expect(values.size).toBeGreaterThan(1);
    });
  });

  describe("latency sanitization", () => {
    it("quantizes to nearest 100ms", () => {
      expect(sanitizeLatency(127)).toBe(200);
      expect(sanitizeLatency(250)).toBe(300);
      expect(sanitizeLatency(99)).toBe(100);
    });

    it("exact 100ms stays at 100ms", () => {
      expect(sanitizeLatency(100)).toBe(100);
    });

    it("1ms rounds up to 100ms", () => {
      expect(sanitizeLatency(1)).toBe(100);
    });
  });

  describe("response metadata sanitization", () => {
    it("quantizes latency", () => {
      const result = sanitizeResponseMeta({ latencyMs: 127 });
      expect(result["latencyMs"]).toBe(200);
    });

    it("generalizes model names", () => {
      expect(sanitizeResponseMeta({ model: "claude-sonnet-4-20250514" })["model"]).toBe("claude");
      expect(sanitizeResponseMeta({ model: "gpt-4o-2024-05-13" })["model"]).toBe("gpt");
      expect(sanitizeResponseMeta({ model: "gemini-2.0-flash" })["model"]).toBe("gemini");
    });

    it("hides exact token counts", () => {
      const result = sanitizeResponseMeta({
        usage: { inputTokens: 1234, outputTokens: 567 },
      });
      expect(result["usage"]).toEqual({ approximate: true });
    });

    it("drops unknown fields", () => {
      const result = sanitizeResponseMeta({
        latencyMs: 100,
        internalSecret: "value",
        cost: 0.05,
      });
      expect(result["internalSecret"]).toBeUndefined();
      expect(result["cost"]).toBeUndefined();
    });
  });

  describe("token count batching", () => {
    it("batches to nearest 100", () => {
      expect(batchTokenCount(42)).toBe(100);
      expect(batchTokenCount(150)).toBe(200);
      expect(batchTokenCount(1001)).toBe(1100);
    });

    it("exact multiple stays same", () => {
      expect(batchTokenCount(100)).toBe(100);
      expect(batchTokenCount(500)).toBe(500);
    });

    it("supports custom batch size", () => {
      expect(batchTokenCount(42, 50)).toBe(50);
      expect(batchTokenCount(51, 50)).toBe(100);
    });
  });
});
