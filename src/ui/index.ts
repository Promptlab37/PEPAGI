// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Entry Point
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   npx tsx src/ui/index.ts
//   npm run tui
//
// The TUI is a pure presentation layer that hooks into the existing
// eventBus and reads from the running PEPAGI system.
// It does NOT start the Mediator or any agents — run those separately
// via `npm run dev` or `npm run daemon`.

import { PepagiDashboard } from "./dashboard.js";

// ── Graceful shutdown ─────────────────────────────────────────

let dashboard: PepagiDashboard | null = null;

function shutdown(): void {
  dashboard?.stop();
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  dashboard?.stop();
  console.error("[TUI] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // Non-fatal — log but don't crash TUI for async background failures
  console.error("[TUI] Unhandled rejection:", reason);
});

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  dashboard = new PepagiDashboard(
    // onTaskSubmit: called when user enters a task in F1 Command Center
    (task: string) => {
      // Dynamic import to avoid circular dep with main system
      void import("../core/task-store.js").then(async ({ TaskStore }) => {
        const store  = new TaskStore();
        await store.load();
        const { nanoid } = await import("nanoid");
        const newTask = await store.create({
          title:       task.slice(0, 80),
          description: task,
          priority:    "medium",
          tags:        ["tui", "user-input"],
        });
        // The mediator (if running) will pick it up via the event bus
        void newTask;
      }).catch((err: unknown) => {
        console.error("[TUI] Failed to create task:", err);
      });
    },
  );

  await dashboard.start();
}

void main();
