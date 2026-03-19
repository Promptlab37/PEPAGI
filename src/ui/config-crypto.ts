// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — AES-256-GCM Config Encryption
// ═══════════════════════════════════════════════════════════════
//
// Key derived via PBKDF2 (100k iterations, SHA-512)
// Salt: machine-derived (hostname + username + 'pepagi-vault-v1')
// Format: 'enc:v1:<base64-iv>:<base64-authTag>:<base64-ciphertext>'
// Auto-migration: detects plaintext API keys and encrypts them on first run
// Decryption: lazy, only when a value is needed — NEVER logged

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { hostname, userInfo } from "node:os";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Constants ─────────────────────────────────────────────────

const PREFIX     = "enc:v1:";
const KEY_LEN    = 32;   // AES-256
const IV_LEN     = 12;   // GCM nonce
const ITERATIONS = 100_000;

// ── Key derivation ────────────────────────────────────────────

let _key: Buffer | null = null;

function getDerivedKey(): Buffer {
  if (_key) return _key;
  const saltBase = `${hostname()}:${userInfo().username}:pepagi-vault-v1`;
  const salt     = Buffer.from(saltBase, "utf8");
  // Static passphrase — the machine identity IS the secret
  const pass     = `pepagi-tui-${hostname()}-${userInfo().username}`;
  _key = pbkdf2Sync(pass, salt, ITERATIONS, KEY_LEN, "sha512");
  return _key;
}

// ── Encrypt ───────────────────────────────────────────────────

export function encrypt(plaintext: string): string {
  const key    = getDerivedKey();
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

// ── Decrypt ───────────────────────────────────────────────────

export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // plaintext passthrough
  const inner = ciphertext.slice(PREFIX.length).split(":");
  if (inner.length !== 3) throw new Error("config-crypto: malformed encrypted value");
  const [ivB64, tagB64, dataB64] = inner as [string, string, string];
  const key     = getDerivedKey();
  const iv      = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data    = Buffer.from(dataB64, "base64");
  const dec     = createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(authTag);
  return Buffer.concat([dec.update(data), dec.final()]).toString("utf8");
}

// ── Helpers ───────────────────────────────────────────────────

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt only if not already encrypted */
export function encryptIfPlain(value: string): string {
  return isEncrypted(value) ? value : encrypt(value);
}

// ── Auto-migration ────────────────────────────────────────────
//
// Patterns that look like plaintext API keys (not already encrypted)

const KEY_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9]{20,}$/,                 // OpenAI
  /^sk-ant-[A-Za-z0-9\-_]{40,}$/,          // Anthropic
  /^AIza[A-Za-z0-9\-_]{35,}$/,             // Google
  /^[A-Za-z0-9]{40,}$/,                    // generic long tokens
];

function looksLikePlainKey(value: string): boolean {
  if (!value || isEncrypted(value)) return false;
  return KEY_PATTERNS.some(re => re.test(value));
}

/**
 * Reads the config JSON at `configPath`, encrypts any plaintext API keys
 * in the `agents` map, and writes the updated config back atomically.
 * Returns the number of keys migrated.
 */
export async function migrateConfigKeys(configPath: string): Promise<number> {
  if (!existsSync(configPath)) return 0;

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return 0;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 0;
  }

  let migrated = 0;
  const agents = config["agents"] as Record<string, Record<string, unknown>> | undefined;

  if (agents) {
    for (const [provider, cfg] of Object.entries(agents)) {
      if (typeof cfg["apiKey"] === "string" && looksLikePlainKey(cfg["apiKey"])) {
        (agents[provider] as Record<string, unknown>)["apiKey"] = encrypt(cfg["apiKey"]);
        migrated++;
      }
    }
  }

  // Also check top-level keys
  for (const key of ["telegramToken", "discordToken", "whatsappToken"]) {
    const val = config[key];
    if (typeof val === "string" && looksLikePlainKey(val)) {
      config[key] = encrypt(val);
      migrated++;
    }
  }

  if (migrated > 0) {
    const tmp = `${configPath}.tmp.${process.pid}`;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await rename(tmp, configPath);
  }

  return migrated;
}
