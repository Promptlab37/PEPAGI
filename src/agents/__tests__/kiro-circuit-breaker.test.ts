// ═══════════════════════════════════════════════════════════════
// Tests: Kiro Circuit Breaker State Machine (Property-Based)
// Feature: kiro-cli-support, Property 11: Circuit Breaker State Machine
// Validates: Requirements 9.2, 9.3, 16.1, 16.2, 16.3
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import type { PepagiEvent } from "../../core/types.js";

// ── Constants matching KiroCircuitBreaker internals ───────────
const THRESHOLD = 10;
const RESET_TIMEOUT = 300_000; // 5 min

// ── Helpers ───────────────────────────────────────────────────

/**
 * Fresh-import both kiroCircuitBreaker and eventBus so they share
 * the same module graph (vi.resetModules() isolates each import).
 */
async function freshBreakerAndBus() {
  const [llmMod, busMod] = await Promise.all([
    import("../llm-provider.js"),
    import("../../core/event-bus.js"),
  ]);
  return {
    breaker: llmMod.kiroCircuitBreaker,
    eventBus: busMod.eventBus,
  };
}

/** Drive N consecutive failures through the circuit breaker */
async function driveFailures(
  breaker: Awaited<ReturnType<typeof freshBreakerAndBus>>["breaker"],
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    try {
      await breaker.call(async () => { throw new Error(`failure-${i}`); });
    } catch {
      // expected
    }
  }
}

// ─── Property 11: Circuit Breaker State Machine ───────────────

describe("Property 11: Circuit Breaker State Machine", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── P11a: closed → open after THRESHOLD failures ───────────

  it("transitions closed → open after THRESHOLD failures within WINDOW", async () => {
    const { breaker, eventBus } = await freshBreakerAndBus();
    const events: PepagiEvent[] = [];
    const handler = (ev: PepagiEvent) => events.push(ev);
    eventBus.onAny(handler);

    expect(breaker.getState()).toBe("closed");
    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");

    const openAlert = events.find(
      e => e.type === "system:alert" && e.message.includes("Circuit breaker OPEN"),
    );
    expect(openAlert).toBeDefined();
    expect(openAlert!.type === "system:alert" && openAlert!.level).toBe("warn");

    eventBus.offAny(handler);
  });

  // ── P11b: open → half-open after RESET_TIMEOUT ─────────────

  it("transitions open → half-open after RESET_TIMEOUT elapses", async () => {
    const { breaker, eventBus } = await freshBreakerAndBus();
    const events: PepagiEvent[] = [];
    const handler = (ev: PepagiEvent) => events.push(ev);
    eventBus.onAny(handler);

    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");
    events.length = 0;

    vi.advanceTimersByTime(RESET_TIMEOUT + 1);

    // Probe call — fails, but should transition through half-open
    try {
      await breaker.call(async () => { throw new Error("probe-fail"); });
    } catch { /* expected */ }

    const halfOpenAlert = events.find(
      e => e.type === "system:alert" && e.message.includes("HALF-OPEN"),
    );
    expect(halfOpenAlert).toBeDefined();

    eventBus.offAny(handler);
  });

  // ── P11c: half-open → closed on success ─────────────────────

  it("transitions half-open → closed on successful probe", async () => {
    const { breaker, eventBus } = await freshBreakerAndBus();
    const events: PepagiEvent[] = [];
    const handler = (ev: PepagiEvent) => events.push(ev);
    eventBus.onAny(handler);

    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");
    events.length = 0;

    vi.advanceTimersByTime(RESET_TIMEOUT + 1);

    const result = await breaker.call(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("closed");

    const halfOpenAlert = events.find(
      e => e.type === "system:alert" && e.message.includes("HALF-OPEN"),
    );
    const closedAlert = events.find(
      e => e.type === "system:alert" && e.message.includes("recovered"),
    );
    expect(halfOpenAlert).toBeDefined();
    expect(closedAlert).toBeDefined();

    eventBus.offAny(handler);
  });

  // ── P11d: half-open → open on failure ───────────────────────

  it("transitions half-open → open on failed probe", async () => {
    const { breaker } = await freshBreakerAndBus();

    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");

    vi.advanceTimersByTime(RESET_TIMEOUT + 1);

    try {
      await breaker.call(async () => { throw new Error("probe-fail"); });
    } catch { /* expected */ }

    expect(breaker.getState()).toBe("open");
  });

  // ── P11e: stays closed below THRESHOLD ──────────────────────

  it("stays closed when failures are below THRESHOLD", async () => {
    const { breaker } = await freshBreakerAndBus();
    await driveFailures(breaker, THRESHOLD - 1);
    expect(breaker.getState()).toBe("closed");
  });

  // ── P11f: open state throws non-retryable error ─────────────

  it("throws non-retryable error when circuit is open", async () => {
    const { breaker } = await freshBreakerAndBus();

    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");

    await expect(
      breaker.call(async () => "should-not-run"),
    ).rejects.toThrow(/Circuit breaker OPEN/);
  });

  // ── P11g: Property-based — random success/failure sequences ─

  it("state machine invariants hold for random outcome sequences", async () => {
    const arbStep = fc.record({
      outcome: fc.boolean(),
      timeAdvanceMs: fc.integer({ min: 0, max: RESET_TIMEOUT * 2 }),
    });
    const arbSequence = fc.array(arbStep, { minLength: 1, maxLength: 60 });

    await fc.assert(
      fc.asyncProperty(arbSequence, async (steps) => {
        vi.resetModules();
        const { breaker, eventBus } = await freshBreakerAndBus();
        const events: PepagiEvent[] = [];
        const handler = (ev: PepagiEvent) => events.push(ev);
        eventBus.onAny(handler);

        let state: "closed" | "open" | "half-open" = "closed";

        for (const step of steps) {
          if (step.timeAdvanceMs > 0) {
            vi.advanceTimersByTime(step.timeAdvanceMs);
          }

          const prevState = breaker.getState();

          try {
            if (step.outcome) {
              await breaker.call(async () => "ok");
            } else {
              await breaker.call(async () => { throw new Error("fail"); });
            }
          } catch {
            // expected for failures or open circuit
          }

          state = breaker.getState();

          // Invariant 1: state is always valid
          expect(["closed", "open", "half-open"]).toContain(state);

          // Invariant 2: success in half-open → closed
          if (prevState === "half-open" && step.outcome) {
            expect(state).toBe("closed");
          }

          // Invariant 3: failure in half-open → open
          if (prevState === "half-open" && !step.outcome) {
            expect(state).toBe("open");
          }

          // Invariant 4: success in closed → stays closed
          if (prevState === "closed" && step.outcome) {
            expect(state).toBe("closed");
          }
        }

        // Invariant 5: failure count is non-negative
        expect(breaker.getRecentFailureCount()).toBeGreaterThanOrEqual(0);

        // Invariant 6: all emitted system:alert events have level "warn"
        const alertEvents = events.filter(e => e.type === "system:alert");
        for (const alert of alertEvents) {
          if (alert.type === "system:alert") {
            expect(alert.level).toBe("warn");
          }
        }

        // Invariant 7: if ended in open, at least one open-transition alert was emitted
        if (state === "open") {
          const openAlerts = alertEvents.filter(
            e => e.type === "system:alert" && e.message.includes("Circuit breaker OPEN"),
          );
          expect(openAlerts.length).toBeGreaterThanOrEqual(1);
        }

        eventBus.offAny(handler);
      }),
      { numRuns: 100 },
    );
  });

  // ── P11h: forceReset recovers from any state ────────────────

  it("forceReset returns to closed from any state", async () => {
    const { breaker } = await freshBreakerAndBus();

    await driveFailures(breaker, THRESHOLD);
    expect(breaker.getState()).toBe("open");

    breaker.forceReset();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getRecentFailureCount()).toBe(0);
  });
});
