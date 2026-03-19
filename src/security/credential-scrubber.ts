// ═══════════════════════════════════════════════════════════════
// PEPAGI — Credential Scrubber (SEC-02)
// Comprehensive credential/secret scrubbing for all output paths.
// Applied to: logs, audit, memory, platform responses, thoughts.
// ═══════════════════════════════════════════════════════════════

// NOTE: No Logger import here to avoid circular dependency
// (Logger imports CredentialScrubber for scrubbing)

// SECURITY: SEC-02 — Credential patterns covering all known formats
const CREDENTIAL_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  // Anthropic API keys
  { name: "anthropic_key",     regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,       replacement: "[ANTHROPIC_KEY_REDACTED]" },
  // OpenAI API keys
  { name: "openai_key",        regex: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/g,     replacement: "[OPENAI_KEY_REDACTED]" },
  // Google API keys
  { name: "google_key",        regex: /AIza[0-9A-Za-z\-_]{35}/g,            replacement: "[GOOGLE_KEY_REDACTED]" },
  // AWS secrets
  { name: "aws_secret",        regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,         replacement: "[AWS_KEY_REDACTED]" },
  { name: "aws_secret_key",    regex: /[A-Za-z0-9/+]{40}(?=\s|"|'|$)/g,     replacement: "[AWS_SECRET_REDACTED]" },
  // Telegram bot tokens (numeric:alphanumeric format)
  { name: "telegram_token",    regex: /\d{8,10}:[A-Za-z0-9_-]{35,}/g,       replacement: "[TELEGRAM_TOKEN_REDACTED]" },
  // Discord bot tokens
  { name: "discord_token",     regex: /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, replacement: "[DISCORD_TOKEN_REDACTED]" },
  // Home Assistant tokens (long-lived access tokens)
  { name: "ha_token",          regex: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, replacement: "[HA_TOKEN_REDACTED]" },
  // Generic JWT tokens
  { name: "jwt_token",         regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[JWT_REDACTED]" },
  // SSH private keys
  { name: "ssh_key",           regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replacement: "[SSH_KEY_REDACTED]" },
  // Generic password/secret assignments
  { name: "password_field",    regex: /(?:password|passwd|secret|token|api_?key|access_key|auth_token)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi, replacement: "$&".replace(/=.*/, "=[REDACTED]") },
  // Credit card numbers
  { name: "credit_card",       regex: /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g,      replacement: "[CARD_REDACTED]" },
  // Email addresses (less aggressive — only redact in untrusted contexts)
  { name: "email",             regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL_REDACTED]" },
];

// SECURITY: SEC-02 — Fixed password field replacement (the regex backreference above
// doesn't work correctly; use a function replacer instead)
const PASSWORD_FIELD_REGEX = /(?:password|passwd|secret|token|api_?key|access_key|auth_token)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi;

/**
 * Scrub all known credential patterns from text.
 *
 * SECURITY: SEC-02 — Applied at every output boundary to prevent
 * credential leakage through logs, audit, memory, platform responses.
 *
 * @param text - Text to scrub
 * @returns Object with scrubbed text and list of what was redacted
 */
export function scrubCredentials(text: string): { scrubbed: string; redacted: string[] } {
  let result = text;
  const redacted: string[] = [];

  for (const { name, regex, replacement } of CREDENTIAL_PATTERNS) {
    // Skip password_field since we handle it separately
    if (name === "password_field") continue;

    // Reset regex lastIndex for safety (global regexps are stateful)
    regex.lastIndex = 0;
    const before = result;
    result = result.replace(regex, replacement);
    if (result !== before) {
      redacted.push(name);
    }
  }

  // Handle password fields with function replacer
  const beforePw = result;
  result = result.replace(PASSWORD_FIELD_REGEX, (match) => {
    const eqIdx = match.search(/[=:]/);
    if (eqIdx >= 0) {
      return match.slice(0, eqIdx + 1) + "[REDACTED]";
    }
    return "[CREDENTIAL_REDACTED]";
  });
  if (result !== beforePw) {
    redacted.push("password_field");
  }

  return { scrubbed: result, redacted };
}

/**
 * Quick check if text likely contains credentials.
 * Faster than full scrub — use for pre-filtering.
 */
export function likelyContainsCredentials(text: string): boolean {
  for (const { regex } of CREDENTIAL_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
