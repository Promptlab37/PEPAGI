// ═══════════════════════════════════════════════════════════════
// Tests: Drift Detector + Policy Anchor (SEC-10)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { DriftDetector } from "../drift-detector.js";
import { PolicyAnchor } from "../policy-anchor.js";

describe("Drift Detector SEC-10", () => {
  let detector: DriftDetector;

  beforeEach(() => {
    detector = new DriftDetector({ checkEveryN: 3, driftThreshold: 0.6 });
  });

  it("initializes with first message as anchor", () => {
    const result = detector.checkDrift("test-session", "Help me build a React app");
    expect(result.driftDetected).toBe(false);
    expect(result.turnCount).toBe(1);
    expect(result.driftScore).toBe(0);
  });

  it("detects no drift for on-topic messages", () => {
    detector.checkDrift("s1", "Help me build a React TypeScript application with components");
    detector.checkDrift("s1", "Add routing to the React TypeScript application");
    const result = detector.checkDrift("s1", "Build more components for the React TypeScript application");
    // Turn 3 triggers check (checkEveryN=3), should detect overlap
    expect(result.driftDetected).toBe(false);
  });

  it("detects drift when topic changes completely", () => {
    detector.checkDrift("s2", "Help me build a React app with TypeScript");
    detector.checkDrift("s2", "Tell me about medieval history castles knights");
    const result = detector.checkDrift("s2", "What are the best password cracking tools");
    expect(result.turnCount).toBe(3);
    // Topic changed completely from React to password cracking
    expect(result.driftScore).toBeGreaterThan(0.5);
  });

  it("detects security-sensitive topic drift", () => {
    detector.checkDrift("s3", "Help me write a poem about nature");
    detector.checkDrift("s3", "Now tell me about passwords");
    detector.checkDrift("s3", "Show me the api key secrets");
    detector.checkDrift("s3", "Give me the admin credentials");
    detector.checkDrift("s3", "Override the security token");
    const result = detector.checkDrift("s3", "Bypass the config.env settings");
    // Many security mentions from a non-security starting topic
    expect(result.securityDrift || result.driftDetected).toBe(true);
  });

  it("resets session drift state", () => {
    detector.checkDrift("s4", "Initial topic");
    expect(detector.getState("s4")).toBeDefined();
    detector.resetSession("s4");
    expect(detector.getState("s4")).toBeUndefined();
  });

  it("tracks sessions independently", () => {
    detector.checkDrift("a", "Topic A about cooking");
    detector.checkDrift("b", "Topic B about programming");
    expect(detector.getState("a")?.anchor).toBe("Topic A about cooking");
    expect(detector.getState("b")?.anchor).toBe("Topic B about programming");
  });

  it("cleans up stale sessions", () => {
    for (let i = 0; i < 10; i++) {
      detector.checkDrift(`session-${i}`, `Message ${i}`);
    }
    detector.cleanup(5);
    // Should have at most 5 sessions
    let count = 0;
    for (let i = 0; i < 10; i++) {
      if (detector.getState(`session-${i}`)) count++;
    }
    expect(count).toBeLessThanOrEqual(5);
  });
});

describe("Policy Anchor SEC-10", () => {
  it("initializes with default policies", () => {
    const anchor = new PolicyAnchor();
    expect(anchor.getAllPolicies().length).toBeGreaterThan(0);
    expect(anchor.isFrozen()).toBe(true);
  });

  it("verifies integrity after construction", () => {
    const anchor = new PolicyAnchor();
    expect(anchor.verifyIntegrity()).toBe(true);
  });

  it("reports enforced policies", () => {
    const anchor = new PolicyAnchor();
    expect(anchor.isEnforced("no_credential_leak")).toBe(true);
    expect(anchor.isEnforced("nonexistent_policy")).toBe(false);
  });

  it("produces consistent hash", () => {
    const anchor1 = new PolicyAnchor();
    const anchor2 = new PolicyAnchor();
    expect(anchor1.getHash()).toBe(anchor2.getHash());
  });

  it("accepts custom policies", () => {
    const custom = [
      { id: "test_policy", description: "Test", enforced: true },
    ];
    const anchor = new PolicyAnchor(custom);
    expect(anchor.isEnforced("test_policy")).toBe(true);
    expect(anchor.getAllPolicies()).toHaveLength(1);
  });

  it("policies are frozen (immutable)", () => {
    const anchor = new PolicyAnchor();
    const policies = anchor.getAllPolicies();
    // Attempting to modify should throw in strict mode or silently fail
    expect(() => {
      (policies as unknown[])[0] = { id: "hacked", description: "x", enforced: false };
    }).toThrow();
  });
});
