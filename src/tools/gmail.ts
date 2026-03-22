// ═══════════════════════════════════════════════════════════════
// PEPAGI — Full Gmail Tool (OAuth2)
// Actions: list, read, send, reply, search, label, delete
// Fallback to AppleScript if OAuth not configured.
// ═══════════════════════════════════════════════════════════════

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
import { isGoogleAuthenticated, googleFetch } from "../integrations/google-auth.js";
import { dlpEngine } from "../security/dlp-engine.js";

const logger = new Logger("Gmail");
const execAsync = promisify(exec);
const IS_MAC = process.platform === "darwin";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Rate limiter: max 20 sends/hour — persisted to disk across restarts
const SEC_MAX_SENDS_PER_HOUR = 20;
const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const RATE_LIMIT_PATH = join(PEPAGI_DATA_DIR, "gmail-rate-limit.json");

let sendTimestamps: number[] = [];

/** Load rate limit state from disk */
function loadRateLimit(): void {
  try {
    const raw = readFileSync(RATE_LIMIT_PATH, "utf8");
    const data = JSON.parse(raw) as number[];
    if (Array.isArray(data)) {
      sendTimestamps = data.filter(ts => typeof ts === "number" && ts > Date.now() - 3_600_000);
    }
  } catch {
    sendTimestamps = [];
  }
}

/** Save rate limit state to disk */
function saveRateLimit(): void {
  try {
    mkdirSync(PEPAGI_DATA_DIR, { recursive: true });
    writeFileSync(RATE_LIMIT_PATH, JSON.stringify(sendTimestamps), "utf8");
  } catch {
    // Non-critical — in-memory fallback
  }
}

// Load on module init
loadRateLimit();

function isSendRateLimited(): boolean {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  while (sendTimestamps.length > 0 && sendTimestamps[0]! < oneHourAgo) {
    sendTimestamps.shift();
  }
  return sendTimestamps.length >= SEC_MAX_SENDS_PER_HOUR;
}

function recordSend(): void {
  sendTimestamps.push(Date.now());
  saveRateLimit();
}

/** Base64url encode a string */
function base64urlEncode(str: string): string {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode base64url to string */
function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Build RFC 2822 message for Gmail API */
function buildRawMessage(to: string, subject: string, body: string, headers?: Record<string, string>): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (headers) {
    for (const [key, val] of Object.entries(headers)) {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("", body);
  return base64urlEncode(lines.join("\r\n"));
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string; size?: number };
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string; size?: number };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    }>;
    mimeType?: string;
  };
  internalDate?: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** Extract header value from Gmail message */
function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Extract body text from a Gmail message (handles multipart MIME) */
function extractBody(msg: GmailMessage): string {
  // Simple body
  if (msg.payload?.body?.data) {
    return base64urlDecode(msg.payload.body.data);
  }
  // Multipart: find text/plain
  if (msg.payload?.parts) {
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return base64urlDecode(part.body.data);
      }
      // Nested multipart
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === "text/plain" && sub.body?.data) {
            return base64urlDecode(sub.body.data);
          }
        }
      }
    }
    // Fallback: any HTML
    for (const part of msg.payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = base64urlDecode(part.body.data);
        return html.replace(/<[^>]+>/g, "").slice(0, 5000);
      }
    }
  }
  return msg.snippet ?? "(empty)";
}

/** Format a Gmail message for display */
function formatMessage(msg: GmailMessage, includeBody: boolean): string {
  const from = getHeader(msg, "From");
  const subject = getHeader(msg, "Subject");
  const date = getHeader(msg, "Date");
  const to = getHeader(msg, "To");
  const labels = (msg.labelIds ?? []).join(", ");
  let text = `ID: ${msg.id}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\nLabels: ${labels}`;
  if (includeBody) {
    const body = extractBody(msg);
    text += `\n\n${body.slice(0, 10000)}`;
  } else if (msg.snippet) {
    text += `\nPreview: ${msg.snippet}`;
  }
  return text;
}

// ─── AppleScript fallback (macOS Mail.app) ─────────────────

async function appleScriptFallback(action: string, params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  if (!IS_MAC) {
    return { success: false, output: "Gmail requires Google OAuth2 authentication. Run setup to configure." };
  }

  if (action === "list" || action === "search") {
    const maxResults = parseInt(params.maxResults ?? "10", 10);
    const label = params.label ?? "INBOX";
    const applescript = `
      tell application "Mail"
        set msgs to messages of mailbox "${label.replace(/"/g, '\\"')}" of account 1
        set result to ""
        set counter to 0
        repeat with msg in msgs
          if counter >= ${maxResults} then exit repeat
          set result to result & "Od: " & (sender of msg) & "\\nPředmět: " & (subject of msg) & "\\nDatum: " & (date received of msg) & "\\n---\\n"
          set counter to counter + 1
        end repeat
        if result is "" then return "Žádné zprávy."
        return result
      end tell
    `;
    try {
      const { stdout } = await execAsync(`osascript -e '${applescript.replace(/'/g, "'\"'\"'")}'`, { timeout: 15_000 });
      return { success: true, output: stdout.trim() || "Žádné zprávy." };
    } catch (err) {
      return { success: false, output: `AppleScript fallback failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { success: false, output: `Action "${action}" requires Google OAuth2. AppleScript fallback only supports list/search.` };
}

// ─── Gmail API actions ─────────────────────────────────────

async function gmailList(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const maxResults = params.maxResults ?? "10";
  const q = params.query ?? params.label ?? "";
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";

  const res = await googleFetch(`${GMAIL_API}/messages?maxResults=${maxResults}${qParam}`);
  if (!res.ok) return { success: false, output: `Gmail API error: ${res.status} ${await res.text()}` };

  const data = await res.json() as GmailListResponse;
  if (!data.messages?.length) return { success: true, output: "Žádné zprávy." };

  // Fetch details for each message
  const messages: string[] = [];
  for (const m of data.messages.slice(0, parseInt(maxResults, 10))) {
    const msgRes = await googleFetch(`${GMAIL_API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    if (msgRes.ok) {
      const msg = await msgRes.json() as GmailMessage;
      messages.push(formatMessage(msg, false));
    }
  }
  return { success: true, output: messages.join("\n---\n") || "Žádné zprávy." };
}

async function gmailRead(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const id = params.id ?? "";
  if (!id) return { success: false, output: "Message ID required (id parameter)" };

  const res = await googleFetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`);
  if (!res.ok) return { success: false, output: `Gmail API error: ${res.status}` };

  const msg = await res.json() as GmailMessage;
  return { success: true, output: formatMessage(msg, true) };
}

async function gmailSend(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const to = params.to ?? "";
  const subject = params.subject ?? "";
  const body = params.body ?? "";
  if (!to || !subject) return { success: false, output: "to and subject parameters required" };

  if (isSendRateLimited()) {
    eventBus.emit({ type: "security:blocked", taskId: "gmail", reason: "Gmail send rate limit exceeded (20/hr)" });
    return { success: false, output: "Rate limit: max 20 emails per hour" };
  }

  // SECURITY: DLP check — scan email content for sensitive data leakage
  const emailContent = `${to} ${subject} ${body}`;
  const dlpResult = dlpEngine.inspect(emailContent, `mailto:${to}`);
  if (!dlpResult.allowed) {
    logger.warn("DLP blocked email send", { to, issues: dlpResult.issues });
    eventBus.emit({ type: "security:blocked", taskId: "gmail", reason: `DLP: ${dlpResult.issues.join(", ")}` });
    return { success: false, output: `Email blocked by DLP: ${dlpResult.issues.join(", ")}` };
  }

  const raw = buildRawMessage(to, subject, body);
  const res = await googleFetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) return { success: false, output: `Send failed: ${res.status} ${await res.text()}` };

  recordSend();
  const sent = await res.json() as { id: string; threadId: string };
  return { success: true, output: `Email sent (ID: ${sent.id}, Thread: ${sent.threadId})` };
}

async function gmailReply(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const messageId = params.messageId ?? params.id ?? "";
  const body = params.body ?? "";
  if (!messageId || !body) return { success: false, output: "messageId and body required for reply" };

  if (isSendRateLimited()) {
    return { success: false, output: "Rate limit: max 20 emails per hour" };
  }

  // SECURITY: DLP check on reply body
  const dlpResult = dlpEngine.inspect(body, "gmail:reply");
  if (!dlpResult.allowed) {
    logger.warn("DLP blocked email reply", { messageId, issues: dlpResult.issues });
    return { success: false, output: `Reply blocked by DLP: ${dlpResult.issues.join(", ")}` };
  }

  // Fetch original message for headers
  const origRes = await googleFetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`);
  if (!origRes.ok) return { success: false, output: `Could not fetch original message: ${origRes.status}` };

  const orig = await origRes.json() as GmailMessage;
  const origFrom = getHeader(orig, "From");
  const origSubject = getHeader(orig, "Subject");
  const origMsgId = getHeader(orig, "Message-ID");

  const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
  const raw = buildRawMessage(origFrom, subject, body, {
    "In-Reply-To": origMsgId,
    References: origMsgId,
  });

  const res = await googleFetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw, threadId: orig.threadId }),
  });

  if (!res.ok) return { success: false, output: `Reply failed: ${res.status}` };
  recordSend();
  const sent = await res.json() as { id: string };
  return { success: true, output: `Reply sent (ID: ${sent.id})` };
}

async function gmailSearch(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const query = params.query ?? "";
  if (!query) return { success: false, output: "query parameter required" };
  return gmailList({ ...params, query });
}

async function gmailLabel(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const id = params.id ?? "";
  const addLabels = params.addLabels ? params.addLabels.split(",").map(l => l.trim()) : [];
  const removeLabels = params.removeLabels ? params.removeLabels.split(",").map(l => l.trim()) : [];
  if (!id || (!addLabels.length && !removeLabels.length)) {
    return { success: false, output: "id and addLabels/removeLabels required" };
  }

  const res = await googleFetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/modify`, {
    method: "POST",
    body: JSON.stringify({
      addLabelIds: addLabels,
      removeLabelIds: removeLabels,
    }),
  });

  if (!res.ok) return { success: false, output: `Label modify failed: ${res.status}` };
  return { success: true, output: `Labels updated on message ${id}` };
}

async function gmailDelete(params: Record<string, string>): Promise<{ success: boolean; output: string }> {
  const id = params.id ?? "";
  if (!id) return { success: false, output: "id parameter required" };

  // Move to trash (not permanent delete)
  const res = await googleFetch(`${GMAIL_API}/messages/${encodeURIComponent(id)}/trash`, {
    method: "POST",
  });

  if (!res.ok) return { success: false, output: `Trash failed: ${res.status}` };
  return { success: true, output: `Message ${id} moved to trash` };
}

// ─── Tool export ──────────────────────────────────────────────

export const gmailTool = {
  name: "gmail",
  description:
    "Full Gmail: list, read, send, reply, search, label, delete emails. Uses Google OAuth2; falls back to macOS Mail if not authenticated.",
  parameters: [
    { name: "action", type: "string" as const, description: "Action: list, read, send, reply, search, label, delete", required: true },
    { name: "id", type: "string" as const, description: "Message ID for read/reply/label/delete", required: false },
    { name: "messageId", type: "string" as const, description: "Alias for id (for reply)", required: false },
    { name: "to", type: "string" as const, description: "Recipient email for send", required: false },
    { name: "subject", type: "string" as const, description: "Email subject for send", required: false },
    { name: "body", type: "string" as const, description: "Email body for send/reply", required: false },
    { name: "query", type: "string" as const, description: "Gmail search query for list/search", required: false },
    { name: "label", type: "string" as const, description: "Label/folder for list", required: false },
    { name: "maxResults", type: "string" as const, description: "Max results for list/search (default: 10)", required: false },
    { name: "addLabels", type: "string" as const, description: "Comma-separated label IDs to add", required: false },
    { name: "removeLabels", type: "string" as const, description: "Comma-separated label IDs to remove", required: false },
  ],

  execute: async (
    params: Record<string, string>,
    _taskId?: string,
    guard?: { authorize: (taskId: string, action: unknown, details: string) => Promise<boolean> },
  ): Promise<{ success: boolean; output: string }> => {
    const action = params.action ?? "";
    if (!action) return { success: false, output: "action parameter required" };

    // Security: send/reply require email_send authorization
    if ((action === "send" || action === "reply") && guard) {
      const allowed = await guard.authorize("gmail", "email_send", `gmail:${action}`);
      if (!allowed) return { success: false, output: "Email send not authorized by security policy" };
    }

    // Check OAuth
    const hasOAuth = await isGoogleAuthenticated();
    if (!hasOAuth) {
      return appleScriptFallback(action, params);
    }

    try {
      switch (action) {
        case "list": return await gmailList(params);
        case "read": return await gmailRead(params);
        case "send": return await gmailSend(params);
        case "reply": return await gmailReply(params);
        case "search": return await gmailSearch(params);
        case "label": return await gmailLabel(params);
        case "delete": return await gmailDelete(params);
        default:
          return { success: false, output: `Unknown action: ${action}. Valid: list, read, send, reply, search, label, delete` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Gmail tool error", { action, error: msg });
      // If OAuth error, try AppleScript fallback for read-only actions
      if ((action === "list" || action === "search") && IS_MAC) {
        logger.info("Gmail OAuth failed, trying AppleScript fallback");
        return appleScriptFallback(action, params);
      }
      return { success: false, output: `Gmail error: ${msg}` };
    }
  },
};
