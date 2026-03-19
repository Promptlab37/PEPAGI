// ═══════════════════════════════════════════════════════════════
// PEPAGI — Tripwire / Honeypot Detection
// ═══════════════════════════════════════════════════════════════

import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventBus } from "../core/event-bus.js";
import { auditLog } from "./audit-log.js";
import { Logger } from "../core/logger.js";

const logger = new Logger("Tripwire");

const HONEYPOT_DIR = join(tmpdir(), ".pepagi-honeypot");

/** Fake credential patterns that indicate extraction if used */
export const HONEYPOT_API_KEY = "sk-pepagi-honeypot-0000000000000000000000000000000000000000000000";
export const HONEYPOT_PASSWORD = "pepagi_honeypot_password_do_not_use_8f4a2b9c";
export const HONEYPOT_FILE = join(HONEYPOT_DIR, "fake-credentials.env");

/** Accessed honeypot paths */
const accessedPaths = new Set<string>();

/** Initialize honeypot files */
export async function initTripwires(): Promise<void> {
  await mkdir(HONEYPOT_DIR, { recursive: true });

  const fakeContent = [
    `# SYSTEM CREDENTIALS - DO NOT SHARE`,
    `ANTHROPIC_API_KEY=${HONEYPOT_API_KEY}`,
    `OPENAI_API_KEY=sk-honeypot-gpt-000000000000000000000000000000000000000000000000`,
    `DATABASE_URL=postgresql://admin:${HONEYPOT_PASSWORD}@localhost:5432/production`,
    `AWS_SECRET_ACCESS_KEY=honeypot+secret+key+do+not+use+this+value`,
    `STRIPE_SECRET_KEY=honeypot_stripe_key_do_not_use_000000000000000000000000`,
  ].join("\n");

  // Write with restricted permissions (owner read-only) so only the process can access it
  await writeFile(HONEYPOT_FILE, fakeContent, { encoding: "utf8", mode: 0o600 });
  await chmod(HONEYPOT_DIR, 0o700);
  logger.debug("Tripwires initialized", { path: HONEYPOT_DIR });
}

/**
 * Check if a path or string matches a honeypot.
 * Returns true if a tripwire was triggered.
 */
export async function checkTripwire(input: string, taskId?: string, context?: string): Promise<boolean> {
  const triggered =
    input.includes(HONEYPOT_FILE) ||
    input.includes(HONEYPOT_API_KEY) ||
    input.includes(HONEYPOT_PASSWORD) ||
    input.includes(".pepagi-honeypot");

  if (triggered) {
    const message = `Tripwire triggered: honeypot content detected in agent output`;
    logger.error(message, { input: input.slice(0, 200), taskId, context });

    accessedPaths.add(input.slice(0, 200));

    // MEM-05: cap the Set at 1000 entries — without this it grows without bound
    // across long sessions. Trim to the 500 most-recent entries when the cap is hit.
    if (accessedPaths.size > 1000) {
      logger.warn("accessedPaths Set capped, clearing oldest entries");
      const entries = [...accessedPaths].slice(-500); // keep last 500
      accessedPaths.clear();
      entries.forEach(p => accessedPaths.add(p));
    }

    eventBus.emit({
      type: "security:blocked",
      taskId: taskId ?? "unknown",
      reason: message,
    });

    await auditLog({
      taskId,
      actionType: "tripwire_triggered",
      details: `Honeypot detected in: ${input.slice(0, 100)}`,
      outcome: "blocked",
    });

    return true;
  }

  return false;
}

/** Get list of triggered tripwire patterns */
export function getTriggeredTripwires(): string[] {
  return [...accessedPaths];
}
