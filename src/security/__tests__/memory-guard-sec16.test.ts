// ═══════════════════════════════════════════════════════════════
// Tests: MemoryGuard SEC-16 — RAG Poisoning Defense
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { MemoryGuard } from "../memory-guard.js";

describe("MemoryGuard SEC-16 — Contradiction Detection", () => {
  const guard = new MemoryGuard();

  it("detects contradicting facts with negation", () => {
    const existing = [
      { id: "f1", fact: "User prefers TypeScript for web development", confidence: 0.9 },
      { id: "f2", fact: "PostgreSQL runs on port 5432", confidence: 0.95 },
    ];
    const contradictions = guard.detectContradictions(
      "User does not prefer TypeScript for web development",
      existing,
    );
    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0]!.id).toBe("f1");
  });

  it("does not flag non-contradicting facts", () => {
    const existing = [
      { id: "f1", fact: "User prefers TypeScript", confidence: 0.9 },
    ];
    const contradictions = guard.detectContradictions(
      "User also likes Python for data science",
      existing,
    );
    expect(contradictions.length).toBe(0);
  });

  it("detects Czech negation patterns", () => {
    const existing = [
      { id: "f1", fact: "Systém podporuje Docker kontejnery", confidence: 0.8 },
    ];
    const contradictions = guard.detectContradictions(
      "Systém nepodporuje Docker kontejnery",
      existing,
    );
    expect(contradictions.length).toBeGreaterThan(0);
  });

  it("returns empty for unrelated facts", () => {
    const existing = [
      { id: "f1", fact: "The weather is sunny today", confidence: 0.5 },
    ];
    const contradictions = guard.detectContradictions(
      "PostgreSQL runs on port 5432",
      existing,
    );
    expect(contradictions.length).toBe(0);
  });
});

describe("MemoryGuard SEC-16 — Retrieval Anomaly Detection", () => {
  it("does not flag normal retrieval frequency", () => {
    const guard = new MemoryGuard();
    for (let i = 0; i < 5; i++) {
      expect(guard.trackRetrieval("fact-normal")).toBe(false);
    }
  });

  it("flags anomalous retrieval frequency", () => {
    const guard = new MemoryGuard();
    let flagged = false;
    for (let i = 0; i < 15; i++) {
      if (guard.trackRetrieval("fact-suspicious")) flagged = true;
    }
    expect(flagged).toBe(true);
  });

  it("tracks different facts independently", () => {
    const guard = new MemoryGuard();
    for (let i = 0; i < 15; i++) {
      guard.trackRetrieval("fact-A");
    }
    // fact-B should not be flagged
    expect(guard.trackRetrieval("fact-B")).toBe(false);
  });
});
