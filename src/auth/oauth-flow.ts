// ═══════════════════════════════════════════════════════════════
// PEPAGI — OAuth Login Flows
// Browser-based PKCE OAuth for OpenAI and Anthropic
// ═══════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";

// ─── PKCE Helpers ────────────────────────────────────────────

/** Base64url encode (unpadded, RFC 7636 compliant) */
function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

/** Generate PKCE code_verifier + code_challenge (S256) */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Generate random state parameter */
function generateState(): string {
  return base64url(randomBytes(16));
}

/** Open URL in default browser */
function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    exec(`open "${url}"`);
  } else if (process.platform === "win32") {
    // Windows: must use cmd /c start with empty title and escaped URL
    exec(`cmd /c start "" "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

// ─── OpenAI OAuth (Codex-compatible PKCE flow) ──────────────

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_REDIRECT_PORT = 1455;
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_REDIRECT_PORT}/auth/callback`;
const OPENAI_SCOPES = "openid profile email offline_access";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Run the full OpenAI PKCE OAuth flow:
 * 1. Start local HTTP server on port 1455
 * 2. Open browser to OpenAI auth page
 * 3. User logs in with ChatGPT account
 * 4. Receive callback with auth code
 * 5. Exchange code for tokens
 * 6. Store in ~/.codex/auth.json (Codex CLI compatible)
 */
export async function openaiOAuthLogin(): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  const authUrl = `${OPENAI_AUTH_URL}?` + new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  return new Promise<OAuthTokens>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout — prohlížeč se neotevřel nebo přihlášení trvá příliš dlouho (5 min)"));
    }, 300_000);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${OPENAI_REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage("Chyba", `Přihlášení selhalo: ${error}. Můžeš zavřít toto okno.`));
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OpenAI OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage("Chyba", "Neplatná odpověď. Zkus to znovu."));
        clearTimeout(timeout);
        server.close();
        reject(new Error("Invalid OAuth callback — missing code or state mismatch"));
        return;
      }

      try {
        // Exchange code for tokens
        const tokenRes = await fetch(OPENAI_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: OPENAI_CLIENT_ID,
            redirect_uri: OPENAI_REDIRECT_URI,
          }),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
        }

        const data = await tokenRes.json() as Record<string, unknown>;
        const accessToken = String(data["access_token"] ?? "");
        const refreshToken = String(data["refresh_token"] ?? "");
        const idToken = typeof data["id_token"] === "string" ? data["id_token"] : undefined;
        const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : 86400;

        if (!accessToken) throw new Error("No access_token in response");

        // Store in ~/.codex/auth.json (Codex CLI compatible)
        const codexDir = join(homedir(), ".codex");
        await mkdir(codexDir, { recursive: true });
        await writeFile(join(codexDir, "auth.json"), JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: accessToken,
            refresh_token: refreshToken,
            ...(idToken ? { id_token: idToken } : {}),
          },
          last_refresh: new Date().toISOString(),
        }, null, 2), "utf8");

        const tokens: OAuthTokens = {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + expiresIn * 1000,
        };

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage("Přihlášeno!", "OpenAI účet propojen s PEPAGI. Můžeš zavřít toto okno."));
        clearTimeout(timeout);
        server.close();
        resolve(tokens);

      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage("Chyba", `Token exchange selhal: ${err instanceof Error ? err.message : String(err)}`));
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        reject(new Error(`Port ${OPENAI_REDIRECT_PORT} je obsazený. Zavři ostatní OAuth procesy a zkus znovu.`));
      } else {
        reject(err);
      }
    });

    server.listen(OPENAI_REDIRECT_PORT, "127.0.0.1", () => {
      openBrowser(authUrl);
    });
  });
}

// ─── Anthropic OAuth (PKCE flow, manual code paste) ─────────

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_SCOPES = "user:profile user:inference";

/**
 * Run the Anthropic PKCE OAuth flow:
 * 1. Open browser to claude.ai/oauth/authorize
 * 2. User logs in with claude.ai account
 * 3. Redirected to platform.claude.com which shows the auth code
 * 4. User copies and pastes the code back into terminal
 * 5. Exchange code for tokens
 * 6. Store in ~/.pepagi/anthropic-oauth.json
 *
 * @param askCode callback that prompts user for the authorization code
 */
export async function anthropicOAuthLogin(
  askCode: (prompt: string) => Promise<string>,
): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePKCE();

  const authUrl = `${ANTHROPIC_AUTH_URL}?` + new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  }).toString();

  openBrowser(authUrl);

  const rawCode = await askCode(
    "  Přihlaš se v prohlížeči a zkopíruj autorizační kód z callback stránky.\n" +
    "  Autorizační kód: "
  );

  const code = rawCode.trim();
  if (!code) throw new Error("Žádný kód nebyl zadán");

  // Exchange code for tokens
  const tokenRes = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Anthropic token exchange failed (${tokenRes.status}): ${errText}`);
  }

  const data = await tokenRes.json() as Record<string, unknown>;
  const accessToken = String(data["access_token"] ?? "");
  const refreshToken = String(data["refresh_token"] ?? "");
  const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : 28800;

  if (!accessToken) throw new Error("No access_token in Anthropic response");

  // Store in ~/.pepagi/anthropic-oauth.json
  const pepagiDir = join(homedir(), ".pepagi");
  await mkdir(pepagiDir, { recursive: true });
  const tokenData = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(pepagiDir, "anthropic-oauth.json"), JSON.stringify(tokenData, null, 2), "utf8");

  return {
    accessToken,
    refreshToken,
    expiresAt: tokenData.expiresAt,
  };
}

// ─── Anthropic Token Reader (for llm-provider) ──────────────

/** Cached Anthropic OAuth token */
let _anthropicTokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Read Anthropic OAuth token from ~/.pepagi/anthropic-oauth.json.
 * Auto-refreshes when expired.
 */
export async function readAnthropicOAuthToken(): Promise<string | null> {
  // Return cached if valid (with 60s buffer)
  if (_anthropicTokenCache && Date.now() < _anthropicTokenCache.expiresAt - 60_000) {
    return _anthropicTokenCache.token;
  }

  try {
    const tokenPath = join(homedir(), ".pepagi", "anthropic-oauth.json");
    const raw = await readFile(tokenPath, "utf8");
    const data = JSON.parse(raw) as { accessToken: string; refreshToken: string; expiresAt: number };

    if (!data.accessToken) return null;

    // Check expiry
    if (Date.now() >= data.expiresAt - 60_000) {
      // Try refresh
      if (data.refreshToken) {
        const refreshed = await refreshAnthropicToken(data.refreshToken);
        if (refreshed) {
          _anthropicTokenCache = { token: refreshed, expiresAt: Date.now() + 28800 * 1000 };
          return refreshed;
        }
      }
      _anthropicTokenCache = null;
      return null;
    }

    _anthropicTokenCache = { token: data.accessToken, expiresAt: data.expiresAt };
    return data.accessToken;
  } catch {
    _anthropicTokenCache = null;
    return null;
  }
}

/** Refresh Anthropic OAuth token */
async function refreshAnthropicToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTHROPIC_CLIENT_ID,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    const newAccess = typeof data["access_token"] === "string" ? data["access_token"] : null;
    const newRefresh = typeof data["refresh_token"] === "string" ? data["refresh_token"] : null;
    const expiresIn = typeof data["expires_in"] === "number" ? data["expires_in"] : 28800;

    if (!newAccess) return null;

    // Update stored tokens
    const pepagiDir = join(homedir(), ".pepagi");
    await writeFile(join(pepagiDir, "anthropic-oauth.json"), JSON.stringify({
      accessToken: newAccess,
      refreshToken: newRefresh ?? refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      updatedAt: new Date().toISOString(),
    }, null, 2), "utf8");

    return newAccess;
  } catch {
    return null;
  }
}

/** Reset cached Anthropic token (e.g. on 401) */
export function resetAnthropicTokenCache(): void {
  _anthropicTokenCache = null;
}

// ─── HTML template for OAuth callback page ──────────────────

function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PEPAGI — ${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{background:#1a1a2e;padding:3rem;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.5)}
h1{color:#00d4ff;margin-bottom:1rem}p{color:#a0a0a0;font-size:1.1rem}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}
