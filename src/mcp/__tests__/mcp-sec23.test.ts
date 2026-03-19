// ═══════════════════════════════════════════════════════════════
// Tests: MCP Server SEC-23 — Zod Validation
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { z } from "zod";

// SECURITY: SEC-23 — Replicate the Zod schemas from MCP server for standalone testing
const ProcessTaskParamsSchema = z.object({
  description: z.string().min(1).max(10_000),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
});

const SearchMemoryParamsSchema = z.object({
  query: z.string().min(1).max(2000),
  memory_type: z.enum(["episodic", "semantic", "procedural", "all"]).optional(),
});

const ToolsCallParamsSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

describe("MCP SEC-23 — Zod Input Validation", () => {
  describe("ProcessTaskParams", () => {
    it("accepts valid params", () => {
      const result = ProcessTaskParamsSchema.safeParse({
        description: "Write a hello world program",
        priority: "medium",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty description", () => {
      const result = ProcessTaskParamsSchema.safeParse({ description: "" });
      expect(result.success).toBe(false);
    });

    it("rejects missing description", () => {
      const result = ProcessTaskParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects oversized description", () => {
      const result = ProcessTaskParamsSchema.safeParse({
        description: "x".repeat(10_001),
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid priority", () => {
      const result = ProcessTaskParamsSchema.safeParse({
        description: "test",
        priority: "ultra",
      });
      expect(result.success).toBe(false);
    });

    it("allows missing priority (optional)", () => {
      const result = ProcessTaskParamsSchema.safeParse({
        description: "Valid task",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("SearchMemoryParams", () => {
    it("accepts valid query", () => {
      const result = SearchMemoryParamsSchema.safeParse({
        query: "TypeScript patterns",
        memory_type: "semantic",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty query", () => {
      const result = SearchMemoryParamsSchema.safeParse({ query: "" });
      expect(result.success).toBe(false);
    });

    it("rejects oversized query", () => {
      const result = SearchMemoryParamsSchema.safeParse({
        query: "x".repeat(2001),
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid memory_type", () => {
      const result = SearchMemoryParamsSchema.safeParse({
        query: "test",
        memory_type: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ToolsCallParams", () => {
    it("accepts valid tool call", () => {
      const result = ToolsCallParamsSchema.safeParse({
        name: "process_task",
        arguments: { description: "hello" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = ToolsCallParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty name", () => {
      const result = ToolsCallParamsSchema.safeParse({ name: "" });
      expect(result.success).toBe(false);
    });

    it("rejects oversized name", () => {
      const result = ToolsCallParamsSchema.safeParse({
        name: "x".repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it("allows missing arguments (optional)", () => {
      const result = ToolsCallParamsSchema.safeParse({
        name: "get_status",
      });
      expect(result.success).toBe(true);
    });
  });
});
