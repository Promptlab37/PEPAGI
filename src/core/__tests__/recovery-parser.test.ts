// ═══════════════════════════════════════════════════════════════
// Tests: Recovery Marker Extraction Functions
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  extractRecoveryStatus,
  extractRecoveryActions,
  extractGapReport,
  extractEscalationReason,
  extractRecoveryLearnings,
  extractRecoveryInfo,
  stripRecoveryMarkers,
} from "../worker-executor.js";

// ── extractRecoveryStatus ───────────────────────────────────

describe("extractRecoveryStatus", () => {
  it("returns RECOVERED when [RECOVERED] marker present", () => {
    expect(extractRecoveryStatus("Task done [RECOVERED] successfully")).toBe("RECOVERED");
  });

  it("returns DEGRADED when [DEGRADED] marker present", () => {
    expect(extractRecoveryStatus("Partial result [DEGRADED]")).toBe("DEGRADED");
  });

  it("returns ESCALATED when [ESCALATED] marker present", () => {
    expect(extractRecoveryStatus("[ESCALATED] Cannot proceed")).toBe("ESCALATED");
  });

  it("returns null when no recovery marker present", () => {
    expect(extractRecoveryStatus("Normal output without markers")).toBeNull();
  });

  it("ESCALATED takes priority over DEGRADED and RECOVERED", () => {
    expect(extractRecoveryStatus("[RECOVERED] [DEGRADED] [ESCALATED]")).toBe("ESCALATED");
  });

  it("DEGRADED takes priority over RECOVERED", () => {
    expect(extractRecoveryStatus("[RECOVERED] [DEGRADED]")).toBe("DEGRADED");
  });
});

// ── extractRecoveryActions ──────────────────────────────────

describe("extractRecoveryActions", () => {
  it("extracts comma-separated actions", () => {
    const output = "[RECOVERY_ACTIONS]: retried with different path, used alternative tool, searched for context";
    expect(extractRecoveryActions(output)).toEqual([
      "retried with different path",
      "used alternative tool",
      "searched for context",
    ]);
  });

  it("returns empty array when no marker present", () => {
    expect(extractRecoveryActions("No recovery actions here")).toEqual([]);
  });

  it("handles single action", () => {
    expect(extractRecoveryActions("[RECOVERY_ACTIONS]: retried install")).toEqual(["retried install"]);
  });
});

// ── extractGapReport ────────────────────────────────────────

describe("extractGapReport", () => {
  it("extracts comma-separated gaps", () => {
    const output = "[GAP_REPORT]: missing API docs, no test coverage";
    expect(extractGapReport(output)).toEqual(["missing API docs", "no test coverage"]);
  });

  it("returns empty array when no marker present", () => {
    expect(extractGapReport("All good")).toEqual([]);
  });
});

// ── extractEscalationReason ─────────────────────────────────

describe("extractEscalationReason", () => {
  it("extracts escalation reason text", () => {
    const output = "[ESCALATION_REASON]: GitHub API requires authentication token";
    expect(extractEscalationReason(output)).toBe("GitHub API requires authentication token");
  });

  it("returns undefined when no marker present", () => {
    expect(extractEscalationReason("No escalation")).toBeUndefined();
  });
});

// ── extractRecoveryLearnings ────────────────────────────────

describe("extractRecoveryLearnings", () => {
  it("extracts a single learning block", () => {
    const output = `Some text before
[LEARNING]
PATTERN: npm install failed with EACCES
ROOT_CAUSE: missing write permissions to node_modules
SOLUTION: used sudo or changed directory ownership
PREVENTION: always check directory permissions before install
[/LEARNING]
Some text after`;

    const learnings = extractRecoveryLearnings(output);
    expect(learnings).toHaveLength(1);
    expect(learnings[0]).toEqual({
      failurePattern: "npm install failed with EACCES",
      rootCause: "missing write permissions to node_modules",
      solution: "used sudo or changed directory ownership",
      preventionHint: "always check directory permissions before install",
    });
  });

  it("extracts multiple learning blocks", () => {
    const output = `
[LEARNING]
PATTERN: file not found
ROOT_CAUSE: wrong path
SOLUTION: searched for correct path
PREVENTION: verify paths before access
[/LEARNING]
Middle text
[LEARNING]
PATTERN: syntax error in JSON
ROOT_CAUSE: trailing comma
SOLUTION: removed trailing comma
PREVENTION: validate JSON before parsing
[/LEARNING]`;

    const learnings = extractRecoveryLearnings(output);
    expect(learnings).toHaveLength(2);
    expect(learnings[0]!.failurePattern).toBe("file not found");
    expect(learnings[1]!.failurePattern).toBe("syntax error in JSON");
  });

  it("returns empty array when no learning blocks", () => {
    expect(extractRecoveryLearnings("Regular output")).toEqual([]);
  });
});

// ── extractRecoveryInfo ─────────────────────────────────────

describe("extractRecoveryInfo", () => {
  it("returns undefined when no recovery markers", () => {
    expect(extractRecoveryInfo("Clean output")).toBeUndefined();
  });

  it("returns full recovery info for RECOVERED status", () => {
    const output = "[RECOVERED]\n[RECOVERY_ACTIONS]: retried with fix, used alternative";
    const info = extractRecoveryInfo(output);
    expect(info).toEqual({
      status: "RECOVERED",
      actionsAttempted: ["retried with fix", "used alternative"],
      nextAgentCanProceed: true,
    });
  });

  it("includes gap report for DEGRADED status", () => {
    const output = "[DEGRADED]\n[RECOVERY_ACTIONS]: partial completion\n[GAP_REPORT]: missing auth, no docs";
    const info = extractRecoveryInfo(output);
    expect(info?.status).toBe("DEGRADED");
    expect(info?.degradedGaps).toEqual(["missing auth", "no docs"]);
    expect(info?.nextAgentCanProceed).toBe(true);
  });

  it("includes escalation reason for ESCALATED status", () => {
    const output = "[ESCALATED]\n[ESCALATION_REASON]: API key invalid";
    const info = extractRecoveryInfo(output);
    expect(info?.status).toBe("ESCALATED");
    expect(info?.escalationReason).toBe("API key invalid");
    expect(info?.nextAgentCanProceed).toBe(false);
  });
});

// ── stripRecoveryMarkers ────────────────────────────────────

describe("stripRecoveryMarkers", () => {
  it("strips all recovery markers from output", () => {
    const output = `Here is the result [RECOVERED]
[RECOVERY_ACTIONS]: tried fix, retried
[LEARNING]
PATTERN: error
ROOT_CAUSE: bad input
SOLUTION: fixed input
PREVENTION: validate first
[/LEARNING]

Final output here`;

    const stripped = stripRecoveryMarkers(output);
    expect(stripped).not.toContain("[RECOVERED]");
    expect(stripped).not.toContain("[RECOVERY_ACTIONS]");
    expect(stripped).not.toContain("[LEARNING]");
    expect(stripped).not.toContain("[/LEARNING]");
    expect(stripped).toContain("Here is the result");
    expect(stripped).toContain("Final output here");
  });

  it("returns clean text when no markers present", () => {
    const output = "Clean output text";
    expect(stripRecoveryMarkers(output)).toBe("Clean output text");
  });

  it("strips DEGRADED and GAP_REPORT markers", () => {
    const output = "[DEGRADED] Partial result\n[GAP_REPORT]: missing tests";
    const stripped = stripRecoveryMarkers(output);
    expect(stripped).not.toContain("[DEGRADED]");
    expect(stripped).not.toContain("[GAP_REPORT]");
  });

  it("strips ESCALATED and ESCALATION_REASON markers", () => {
    const output = "[ESCALATED]\n[ESCALATION_REASON]: auth failed";
    const stripped = stripRecoveryMarkers(output);
    expect(stripped).not.toContain("[ESCALATED]");
    expect(stripped).not.toContain("[ESCALATION_REASON]");
  });
});
