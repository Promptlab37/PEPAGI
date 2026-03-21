// ═══════════════════════════════════════════════════════════════
// PEPAGI — n8n Webhook Tool
// Sends payloads to user-configured n8n workflow webhooks.
// DLP-safe: only whitelisted n8n base URL + explicit paths allowed.
// ═══════════════════════════════════════════════════════════════

import { Logger } from "../core/logger.js";
import type { ToolResult } from "./tool-registry.js";

const logger = new Logger("n8n");

interface N8nConfig {
  enabled: boolean;
  baseUrl: string;
  webhookPaths: string[];
  apiKey: string;
}

/**
 * Execute an n8n webhook call.
 * @param args.webhook_path - Webhook path suffix (must be in whitelisted webhookPaths)
 * @param args.payload - JSON payload to send (optional, default "{}")
 * @param args.method - HTTP method (default "POST")
 * @param n8nConfig - n8n configuration from PepagiConfig
 */
export async function executeN8nWebhook(
  args: Record<string, string>,
  n8nConfig: N8nConfig,
): Promise<ToolResult> {
  if (!n8nConfig.enabled || !n8nConfig.baseUrl) {
    return { success: false, output: "", error: "n8n is not configured. Run 'pepagi setup' or set n8n config in dashboard." };
  }

  const webhookPath = args["webhook_path"] ?? args["path"] ?? "";
  if (!webhookPath) {
    return { success: false, output: "", error: "Missing required argument: webhook_path" };
  }

  // Security: only allow paths explicitly whitelisted in config
  const normalizedPath = webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`;
  const isAllowed = n8nConfig.webhookPaths.some(p => {
    const np = p.startsWith("/") ? p : `/${p}`;
    return normalizedPath === np || normalizedPath.startsWith(`${np}/`);
  });

  if (!isAllowed) {
    logger.warn("n8n webhook path not whitelisted", { path: normalizedPath, allowed: n8nConfig.webhookPaths });
    return {
      success: false,
      output: "",
      error: `Webhook path "${normalizedPath}" is not in the allowed list. Add it to n8n.webhookPaths in config.`,
    };
  }

  const baseUrl = n8nConfig.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}${normalizedPath}`;
  const method = (args["method"] ?? "POST").toUpperCase();

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = args["payload"] ?? args["body"] ?? "{}";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (n8nConfig.apiKey) {
    headers["Authorization"] = `Bearer ${n8nConfig.apiKey}`;
  }

  try {
    logger.info("n8n webhook call", { url, method });
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    const truncated = text.length > 10_000 ? text.slice(0, 10_000) + "\n...[truncated]" : text;

    if (!response.ok) {
      return { success: false, output: truncated, error: `n8n returned HTTP ${response.status}` };
    }

    return { success: true, output: truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: `n8n webhook failed: ${msg}` };
  }
}
