// ═══════════════════════════════════════════════════════════════
// PEPAGI — Google OAuth2 Authentication
// Handles OAuth2 flow, token storage, auto-refresh for Gmail,
// Calendar, and Drive APIs.
// ═══════════════════════════════════════════════════════════════

import { readFile, writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";

const logger = new Logger("GoogleAuth");

const PEPAGI_DATA_DIR = process.env.PEPAGI_DATA_DIR ?? join(homedir(), ".pepagi");
const TOKEN_PATH = join(PEPAGI_DATA_DIR, "google-tokens.json");
const OAUTH_CALLBACK_PORT = 3101;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
}

let cachedTokens: GoogleTokens | null = null;

/** Get client ID from env or config */
function getClientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? "";
}

/** Get client secret from env or config */
function getClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET ?? "";
}

/** Atomic write tokens to disk with restricted permissions */
async function saveTokens(tokens: GoogleTokens): Promise<void> {
  await mkdir(PEPAGI_DATA_DIR, { recursive: true });
  const tmpPath = `${TOKEN_PATH}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(tokens, null, 2), "utf8");
  await rename(tmpPath, TOKEN_PATH);
  try {
    await chmod(TOKEN_PATH, 0o600);
  } catch {
    // chmod may fail on Windows — non-critical
  }
  cachedTokens = tokens;
}

/** Load tokens from disk */
async function loadTokens(): Promise<GoogleTokens | null> {
  if (cachedTokens) return cachedTokens;
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    cachedTokens = JSON.parse(raw) as GoogleTokens;
    return cachedTokens;
  } catch {
    return null;
  }
}

/** Check if we have valid Google authentication */
export async function isGoogleAuthenticated(): Promise<boolean> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) return false;
  // Even if access_token expired, we can refresh
  return true;
}

/** Refresh the access token using the refresh token */
async function refreshAccessToken(tokens: GoogleTokens): Promise<GoogleTokens> {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for token refresh");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number; scope?: string };
  const updated: GoogleTokens = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000, // subtract 60s buffer
    scope: data.scope ?? tokens.scope,
  };
  await saveTokens(updated);
  return updated;
}

/**
 * Get a valid Google access token. Auto-refreshes if expired.
 * @returns The access token string
 * @throws If not authenticated or refresh fails
 */
export async function getGoogleAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("Not authenticated with Google. Run the OAuth2 flow first.");
  }

  // Check if token is still valid (with 60s buffer)
  if (tokens.access_token && tokens.expires_at > Date.now() + 60_000) {
    return tokens.access_token;
  }

  // Refresh
  logger.info("Refreshing Google access token");
  const refreshed = await refreshAccessToken(tokens);
  return refreshed.access_token;
}

/**
 * Make an authenticated fetch to a Google API.
 * Auto-refreshes on 401.
 */
export async function googleFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getGoogleAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };

  let res = await fetch(url, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });

  // Auto-retry on 401 with refreshed token
  if (res.status === 401) {
    logger.info("Got 401 from Google API, refreshing token and retrying");
    const tokens = await loadTokens();
    if (tokens) {
      const refreshed = await refreshAccessToken(tokens);
      headers.Authorization = `Bearer ${refreshed.access_token}`;
      res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    }
  }

  return res;
}

/**
 * Start the Google OAuth2 flow.
 * Opens a local HTTP server on port 3101 to receive the callback.
 * @param scopes - Google API scopes to request
 * @returns The authorization URL to open in a browser
 */
export async function startGoogleAuth(
  scopes: string[] = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
  ],
): Promise<{ authUrl: string; waitForCallback: () => Promise<boolean> }> {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured");
  }

  const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
  // SECURITY: Use cryptographically secure random for CSRF state
  const state = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  const waitForCallback = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${OAUTH_CALLBACK_PORT}`);

        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authentication failed: ${error}</h2><p>You can close this window.</p></body></html>`);
          server.close();
          resolve(false);
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Invalid callback</h2></body></html>");
          server.close();
          resolve(false);
          return;
        }

        try {
          // Exchange code for tokens
          const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
            }),
            signal: AbortSignal.timeout(15_000),
          });

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`Token exchange failed: ${errText}`);
          }

          const data = await tokenRes.json() as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
            scope: string;
          };

          const tokens: GoogleTokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in - 60) * 1000,
            scope: data.scope,
          };

          await saveTokens(tokens);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body style="background:#0a0a0a;color:#00ff88;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <h1>&#10003; PEPAGI Google Auth Complete</h1>
              <p>You can close this window.</p>
            </div>
          </body></html>`);

          logger.info("Google OAuth2 flow completed successfully");
          eventBus.emit({ type: "system:alert", message: "Google OAuth2 authenticated successfully", level: "warn" as const });

          server.close();
          resolve(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Google OAuth2 token exchange failed", { error: msg });
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Error: ${msg}</h2></body></html>`);
          server.close();
          resolve(false);
        }
      });

      server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
        logger.info(`Google OAuth2 callback server listening on port ${OAUTH_CALLBACK_PORT}`);
      });

      // Auto-close after 5 minutes if no callback received
      setTimeout(() => {
        server.close();
        resolve(false);
      }, 300_000);
    });
  };

  return { authUrl, waitForCallback };
}

/**
 * Revoke Google authentication and delete stored tokens.
 */
export async function revokeGoogleAuth(): Promise<void> {
  const tokens = await loadTokens();
  if (tokens?.access_token) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${tokens.access_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Revocation is best-effort
    }
  }

  // Delete local tokens
  cachedTokens = null;
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(TOKEN_PATH);
  } catch {
    // File may not exist
  }

  logger.info("Google auth revoked and tokens deleted");
}
