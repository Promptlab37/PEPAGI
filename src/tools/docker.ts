// ═══════════════════════════════════════════════════════════════
// PEPAGI — Docker Management Tool
// Uses child_process.exec to run docker CLI commands.
// All commands are authorized through SecurityGuard.
// ═══════════════════════════════════════════════════════════════

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../core/logger.js";
import type { SecurityGuard, ActionCategory } from "../security/security-guard.js";

const execAsync = promisify(exec);
const logger = new Logger("Docker");

/** Allowed docker subcommands to prevent injection */
const ALLOWED_DOCKER_SUBCOMMANDS = new Set(["ps", "images", "logs", "start", "stop", "inspect"]);

/** Validate a container name/ID — allow only safe characters */
// OPUS: regex allowed `/` which could enable path traversal in shell contexts.
// Docker container names/IDs only use alphanumeric, underscore, hyphen, and dot.
function isValidContainerName(name: string): boolean {
  return /^[a-zA-Z0-9_.\-]+$/.test(name) && name.length <= 200;
}

/** Run a docker command after security authorization */
async function runDockerCommand(
  taskId: string,
  guard: SecurityGuard,
  cmd: string,
): Promise<{ success: boolean; output: string }> {
  const allowed = await guard.authorize(taskId, "docker_manage" as ActionCategory, cmd);
  if (!allowed) {
    return { success: false, output: `Docker command not authorized: ${cmd}` };
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
    const output = stdout.trim() + (stderr.trim() ? `\nSTDERR: ${stderr.trim()}` : "");
    return { success: true, output: output || "(no output)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Docker command failed", { cmd, error: msg, taskId });
    return { success: false, output: `Docker error: ${msg}` };
  }
}

// ─── Tool definition ──────────────────────────────────────────

export const dockerTool = {
  name: "docker",
  description: "Manage Docker containers and images. Actions: ps, images, logs, start, stop, inspect.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: ps, images, logs, start, stop, inspect", required: true },
    { name: "container", type: "string" as const, description: "Container name or ID (required for logs, start, stop, inspect)", required: false },
    { name: "lines", type: "string" as const, description: "Number of log lines to show (default 50, for logs action)", required: false },
  ],
  execute: async (
    params: Record<string, string>,
    taskId: string,
    guard: SecurityGuard,
  ): Promise<{ success: boolean; output: string }> => {
    const action = params.action ?? "";

    if (!ALLOWED_DOCKER_SUBCOMMANDS.has(action)) {
      return {
        success: false,
        output: `Unknown action: "${action}". Valid actions: ps, images, logs, start, stop, inspect`,
      };
    }

    try {
      switch (action) {
        case "ps": {
          return runDockerCommand(
            taskId,
            guard,
            "docker ps --format 'table {{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'",
          );
        }

        case "images": {
          return runDockerCommand(
            taskId,
            guard,
            "docker images --format 'table {{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}'",
          );
        }

        case "logs": {
          const container = params.container ?? "";
          if (!container) return { success: false, output: "container parameter required for logs" };
          if (!isValidContainerName(container)) {
            return { success: false, output: `Invalid container name: "${container}"` };
          }
          const lines = params.lines ? parseInt(params.lines, 10) : 50;
          const safeLines = isNaN(lines) || lines < 1 ? 50 : Math.min(lines, 1000);
          return runDockerCommand(taskId, guard, `docker logs --tail ${safeLines} "${container}"`);
        }

        case "start": {
          const container = params.container ?? "";
          if (!container) return { success: false, output: "container parameter required for start" };
          if (!isValidContainerName(container)) {
            return { success: false, output: `Invalid container name: "${container}"` };
          }
          return runDockerCommand(taskId, guard, `docker start "${container}"`);
        }

        case "stop": {
          const container = params.container ?? "";
          if (!container) return { success: false, output: "container parameter required for stop" };
          if (!isValidContainerName(container)) {
            return { success: false, output: `Invalid container name: "${container}"` };
          }
          return runDockerCommand(taskId, guard, `docker stop "${container}"`);
        }

        case "inspect": {
          const container = params.container ?? "";
          if (!container) return { success: false, output: "container parameter required for inspect" };
          if (!isValidContainerName(container)) {
            return { success: false, output: `Invalid container name: "${container}"` };
          }
          return runDockerCommand(taskId, guard, `docker inspect "${container}"`);
        }

        default:
          return { success: false, output: `Unhandled action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Docker tool error", { action, error: msg, taskId });
      return { success: false, output: `Docker tool error: ${msg}` };
    }
  },
};
