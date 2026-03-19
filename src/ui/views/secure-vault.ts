// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F8: Secure Vault
// ═══════════════════════════════════════════════════════════════
//
// View and manage encrypted API keys.
// NEVER logs decrypted values.

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { isEncrypted, decrypt, encrypt } from "../config-crypto.js";
import { readFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const CONFIG_PATH = join(homedir(), ".pepagi", "config.json");

interface VaultEntry {
  path: string; masked: string; encrypted: boolean;
  revealed: boolean; value?: string;
}

export class SecureVaultView extends BaseView {
  private entries:       VaultEntry[] = [];
  private lastRefresh    = 0;
  private selectedIdx    = 0;
  private revealWarning  = "";
  private rawConfig: Record<string, unknown> = {};
  private actionMsg      = "";

  // ── Inline edit ──────────────────────────────────────────────
  private editMode       = false;
  private editBuf        = "";

  // ── Agent config editor ───────────────────────────────────────
  private agentTab       = false;
  private agentRows:     Array<{ provider: string; field: string; value: string; type: "string" | "boolean" | "number" }> = [];
  private agentSelIdx    = 0;
  private agentEditMode  = false;
  private agentEditBuf   = "";
  private agentMsg       = "";

  // ── PIN / auto-lock ──────────────────────────────────────────
  private pin:           string | null = null;   // null = not set
  private locked         = false;
  private pinBuffer      = "";
  private pinMsg         = "";
  private lastCloseTime  = 0;

  constructor(screen: AnyElement) {
    super(screen, { title: "SECURE VAULT", fKey: "F8", width: "75%", height: "80%", borderColor: "red" });

    // PIN digit entry (works when locked)
    for (const d of "0123456789") {
      this.content.key(d, () => {
        if (!this.locked) return;
        this.pinBuffer += d;
        this.pinMsg = "";
        if (this.pinBuffer.length >= 4) {
          if (this.pin === null) {
            // First time: set PIN
            this.pin = this.pinBuffer;
            this.locked = false;
            this.pinMsg = "{green-fg}✓ PIN set (vault auto-locks 60s after closing){/}";
          } else if (this.pinBuffer === this.pin) {
            this.locked = false;
            this.pinMsg = "{green-fg}✓ PIN accepted{/}";
          } else {
            this.pinMsg = "{red-fg}✗ Wrong PIN — try again{/}";
          }
          this.pinBuffer = "";
        }
      });
    }

    // Backspace — handled in edit mode block below

    // p = lock vault manually
    this.content.key("p", () => {
      if (!this.locked && this.pin) {
        this.locked = true; this.pinBuffer = "";
        this.pinMsg = "{yellow-fg}Vault locked — enter PIN to unlock{/}";
      }
    });

    // Reveal / hide key (only when unlocked)
    this.content.key("r", () => {
      if (this.locked) return;
      const entry = this.entries[this.selectedIdx];
      if (!entry) return;
      if (!entry.encrypted) { this.revealWarning = "{red-fg}⚠ Key is NOT encrypted — run migration first{/}"; return; }
      if (entry.revealed) {
        entry.revealed = false; entry.value = undefined;
        this.revealWarning = "{green-fg}✓ Value hidden{/}";
      } else {
        try {
          entry.value = decrypt(this.loadRawValue(entry.path));
          entry.revealed = true;
          this.revealWarning = "{yellow-fg}⚠ Decrypted — auto-hidden in 30s{/}";
          setTimeout(() => { entry.revealed = false; entry.value = undefined; }, 30_000);
        } catch { this.revealWarning = "{red-fg}✗ Decryption failed{/}"; }
      }
    });

    this.content.key("j", () => { if (!this.locked) this.selectedIdx = Math.min(this.entries.length - 1, this.selectedIdx + 1); });
    this.content.key("k", () => { if (!this.locked) this.selectedIdx = Math.max(0, this.selectedIdx - 1); });

    // Ctrl+B — backup config.json
    this.content.key("C-b", () => { void this.backupConfig(); });

    // [t] — API test for selected entry
    this.content.key("t", () => { if (!this.locked) void this.testApi(); });

    // [e] — inline edit selected entry
    this.content.key("e", () => {
      if (this.locked || this.editMode) return;
      const entry = this.entries[this.selectedIdx];
      if (!entry) return;
      this.editMode   = true;
      this.editBuf    = "";
      this.actionMsg  = "{cyan-fg}Editing — type new value, Enter=save (encrypted), Esc=cancel{/}";
    });
    // General text input for edit/agent modes (enter/escape/backspace consolidated below)
    this.content.on("keypress", (ch: string | undefined, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!ch || key.ctrl || key.meta) return;
      if (ch.length !== 1 || ch < " ") return;
      if (this.editMode)      { this.editBuf      += ch; return; }
      if (this.agentEditMode) { this.agentEditBuf += ch; }
    });

    // [a] — toggle agent config editor
    this.content.key("a", () => {
      if (this.locked) return;
      this.agentTab      = !this.agentTab;
      this.agentEditMode = false;
      this.agentEditBuf  = "";
      this.agentSelIdx   = 0;
      this.buildAgentRows();
    });
    // Agent config navigation (uppercase to avoid conflict with base keys)
    this.content.key("J", () => {
      if (!this.agentTab || this.agentEditMode) return;
      this.agentSelIdx = Math.min(this.agentRows.length - 1, this.agentSelIdx + 1);
    });
    this.content.key("K", () => {
      if (!this.agentTab || this.agentEditMode) return;
      this.agentSelIdx = Math.max(0, this.agentSelIdx - 1);
    });
    this.content.key("E", () => {
      if (!this.agentTab || this.agentEditMode || this.locked) return;
      const row = this.agentRows[this.agentSelIdx];
      if (!row) return;
      if (row.type === "boolean") { void this.toggleAgentBool(); return; }
      this.agentEditMode = true;
      this.agentEditBuf  = row.value;
      this.agentMsg = "{#888899-fg}Editing — Enter=save  Esc=cancel{/}";
    });
    this.content.key("enter", () => {
      if (this.agentEditMode) { void this.saveAgentRow(); return; }
      if (!this.editMode) return;
      void this.saveEditedEntry();
    });
    this.content.key("escape", () => {
      if (this.agentEditMode) { this.agentEditMode = false; this.agentEditBuf = ""; this.agentMsg = ""; return; }
      if (this.editMode) { this.editMode = false; this.editBuf = ""; this.actionMsg = ""; }
    });
    this.content.key("backspace", () => {
      if (this.locked && this.pinBuffer.length > 0) { this.pinBuffer = this.pinBuffer.slice(0, -1); return; }
      if (this.agentEditMode) { this.agentEditBuf = this.agentEditBuf.slice(0, -1); return; }
      if (this.editMode)      { this.editBuf      = this.editBuf.slice(0, -1); }
    });
  }

  private buildAgentRows(): void {
    this.agentRows = [];
    const agents = this.rawConfig["agents"] as Record<string, Record<string, unknown>> | undefined;
    if (!agents) return;
    for (const [prov, cfg] of Object.entries(agents)) {
      this.agentRows.push({ provider: prov, field: "enabled",     value: String(cfg["enabled"]     ?? false), type: "boolean" });
      this.agentRows.push({ provider: prov, field: "model",        value: String(cfg["model"]        ?? ""),    type: "string"  });
      this.agentRows.push({ provider: prov, field: "temperature",  value: String(cfg["temperature"]  ?? 0.3),   type: "number"  });
      this.agentRows.push({ provider: prov, field: "maxOutputTokens", value: String(cfg["maxOutputTokens"] ?? 4096), type: "number" });
    }
  }

  private async toggleAgentBool(): Promise<void> {
    const row = this.agentRows[this.agentSelIdx];
    if (!row) return;
    row.value = row.value === "true" ? "false" : "true";
    await this.writeAgentField(row.provider, row.field, row.value === "true");
    this.agentMsg = `{green-fg}✓ ${row.provider}.${row.field} = ${row.value}{/}`;
    setTimeout(() => { this.agentMsg = ""; }, 3000);
  }

  private async saveAgentRow(): Promise<void> {
    const row = this.agentRows[this.agentSelIdx];
    if (!row) { this.agentEditMode = false; return; }
    let val: unknown = this.agentEditBuf;
    if (row.type === "number") {
      const n = parseFloat(this.agentEditBuf);
      if (isNaN(n)) { this.agentMsg = "{red-fg}✗ Invalid number{/}"; this.agentEditMode = false; return; }
      val = n;
    }
    row.value = this.agentEditBuf;
    await this.writeAgentField(row.provider, row.field, val);
    this.agentMsg = `{green-fg}✓ ${row.provider}.${row.field} saved{/}`;
    this.agentEditMode = false; this.agentEditBuf = "";
    setTimeout(() => { this.agentMsg = ""; }, 3000);
  }

  private async writeAgentField(provider: string, field: string, value: unknown): Promise<void> {
    try {
      const cfg  = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      const agts = (cfg["agents"] ?? {}) as Record<string, Record<string, unknown>>;
      if (!agts[provider]) agts[provider] = {};
      agts[provider]![field] = value;
      cfg["agents"] = agts;
      await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    } catch (err) {
      this.agentMsg = `{red-fg}✗ Write failed: ${String(err).slice(0, 40)}{/}`;
    }
  }

  private async saveEditedEntry(): Promise<void> {
    const entry = this.entries[this.selectedIdx];
    if (!entry || !this.editBuf) {
      this.actionMsg = "{#444455-fg}No value entered{/}";
      this.editMode = false; this.editBuf = "";
      return;
    }
    try {
      const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      const encrypted = encrypt(this.editBuf);
      // Navigate to nested path and set value
      const parts = entry.path.split(".");
      let obj: Record<string, unknown> = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i]!;
        if (typeof obj[p] !== "object" || obj[p] === null) obj[p] = {};
        obj = obj[p] as Record<string, unknown>;
      }
      obj[parts[parts.length - 1]!] = encrypted;
      await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      entry.encrypted = true;
      entry.masked    = "[ENCRYPTED]";
      entry.revealed  = false;
      entry.value     = undefined;
      this.actionMsg  = "{green-fg}✓ Value updated & encrypted{/}";
    } catch (err) {
      this.actionMsg = `{red-fg}✗ Save failed: ${String(err).slice(0, 50)}{/}`;
    }
    this.editMode = false; this.editBuf = "";
    setTimeout(() => { this.actionMsg = ""; }, 5000);
  }

  private async backupConfig(): Promise<void> {
    if (!existsSync(CONFIG_PATH)) { this.actionMsg = "{red-fg}✗ config.json not found{/}"; return; }
    try {
      const backupDir = join(homedir(), ".pepagi", "backups");
      await mkdir(backupDir, { recursive: true });
      const dest = join(backupDir, `config-${Date.now()}.json`);
      await copyFile(CONFIG_PATH, dest);
      this.actionMsg = `{green-fg}✓ Backup saved: ${dest}{/}`;
    } catch (e) {
      this.actionMsg = `{red-fg}✗ Backup failed: ${String(e)}{/}`;
    }
    setTimeout(() => { this.actionMsg = ""; }, 5000);
  }

  private async testApi(): Promise<void> {
    const entry = this.entries[this.selectedIdx];
    if (!entry) { this.actionMsg = "{#444455-fg}No entry selected{/}"; return; }
    if (!entry.encrypted) { this.actionMsg = "{red-fg}⚠ Key not encrypted — reveal and test manually{/}"; return; }
    let key: string;
    try { key = decrypt(this.loadRawValue(entry.path)); }
    catch { this.actionMsg = "{red-fg}✗ Cannot decrypt key for test{/}"; return; }
    const prov = entry.path.split(".")[1] ?? "";
    this.actionMsg = "{#888899-fg}⟳ Testing API…{/}";
    try {
      let url: string; let headers: Record<string, string>;
      if (prov === "claude") {
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
      } else if (prov === "gpt") {
        url = "https://api.openai.com/v1/models";
        headers = { Authorization: `Bearer ${key}` };
      } else if (prov === "gemini") {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
        headers = {};
      } else {
        this.actionMsg = `{yellow-fg}⚠ No API test for provider: ${prov}{/}`;
        setTimeout(() => { this.actionMsg = ""; }, 4000);
        return;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        this.actionMsg = `{green-fg}✓ ${prov} API key valid (HTTP ${res.status}){/}`;
      } else {
        this.actionMsg = `{red-fg}✗ ${prov} API rejected key (HTTP ${res.status}){/}`;
      }
    } catch (e) {
      this.actionMsg = `{red-fg}✗ API test failed: ${String(e).slice(0, 60)}{/}`;
    }
    setTimeout(() => { this.actionMsg = ""; }, 5000);
  }

  hide(): void {
    this.lastCloseTime = Date.now();
    this.pinBuffer = ""; this.pinMsg = "";
    this.editMode = false; this.editBuf = "";
    for (const e of this.entries) { e.revealed = false; e.value = undefined; }
    super.hide();
  }

  show(): void {
    // Auto-lock: require PIN re-entry if closed more than 60s ago and PIN is set
    if (this.pin && (Date.now() - this.lastCloseTime) > 60_000) {
      this.locked = true;
      this.pinMsg = "{#666677-fg}Vault auto-locked — enter PIN to unlock{/}";
    }
    super.show();
    void this.loadEntries();
  }

  private async loadEntries(): Promise<void> {
    if (!existsSync(CONFIG_PATH)) return;
    try { this.rawConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>; }
    catch { return; }

    this.entries = [];
    const agents = this.rawConfig["agents"] as Record<string, Record<string, unknown>> | undefined;
    if (agents) {
      for (const [prov, cfg] of Object.entries(agents)) {
        const key = cfg["apiKey"];
        if (typeof key === "string" && key) {
          this.entries.push({ path: `agents.${prov}.apiKey`, masked: isEncrypted(key) ? "[ENCRYPTED]" : maskPlaintext(key), encrypted: isEncrypted(key), revealed: false });
        }
      }
    }
    for (const plat of ["telegram", "whatsapp", "discord"] as const) {
      const cfg = (this.rawConfig["platforms"] as Record<string, Record<string, unknown>> | undefined)?.[plat];
      const token = cfg?.["botToken"] ?? cfg?.["token"];
      if (typeof token === "string" && token) {
        this.entries.push({ path: `platforms.${plat}.botToken`, masked: isEncrypted(token) ? "[ENCRYPTED]" : maskPlaintext(token), encrypted: isEncrypted(token), revealed: false });
      }
    }
    this.lastRefresh = Date.now();
  }

  private loadRawValue(path: string): string {
    const parts = path.split(".");
    let obj: unknown = this.rawConfig;
    for (const p of parts) { if (typeof obj !== "object" || obj === null) return ""; obj = (obj as Record<string, unknown>)[p]; }
    return typeof obj === "string" ? obj : "";
  }

  protected renderContent(_state: DashboardState): string {
    if (Date.now() - this.lastRefresh > 10_000) void this.loadEntries();

    // ── PIN entry screen ─────────────────────────────────────
    if (this.locked) {
      const dots = "●".repeat(this.pinBuffer.length) + "○".repeat(Math.max(0, 4 - this.pinBuffer.length));
      return [
        "{bold}{red-fg}◈ SECURE VAULT — 🔒 LOCKED{/bold}{/}",
        "",
        "  {#888899-fg}Enter 4-digit PIN to unlock{/}",
        `  {bold}{white-fg}[ ${dots} ]{/bold}{/}`,
        "",
        this.pinMsg || "{#666677-fg}Type PIN digits (0-9)  ⌫=backspace{/}",
        "",
        this.pin === null
          ? "{yellow-fg}  ℹ No PIN set — type 4 digits to create one{/}"
          : "{#444455-fg}  Auto-locks 60s after closing  |  p=lock manually{/}",
      ].join("\n");
    }

    const lines: string[] = [
      "{bold}{red-fg}◈ SECURE VAULT{/bold}{/}",
      `{#666677-fg}${this.agentTab ? "{cyan-fg}[AGENTS]{/}" : "credentials"}  r=reveal  j/k=select  e=edit  a=agents  p=lock  t=API test  Ctrl+B=backup{/}`,
      "{#3a3a4a-fg}" + "─".repeat(60) + "{/}",
    ];
    if (this.actionMsg) { lines.push(this.actionMsg, ""); }

    // ── Agent Config Tab ──────────────────────────────────────
    if (this.agentTab) {
      if (this.agentMsg) lines.push(this.agentMsg, "");
      lines.push("{bold}{cyan-fg}AGENT CONFIGURATION{/bold}{/}", "");
      lines.push(`{#888899-fg}${"PROVIDER".padEnd(12)} ${"FIELD".padEnd(20)} ${"VALUE".padEnd(20)}{/}`);
      lines.push("{#3a3a4a-fg}" + "─".repeat(55) + "{/}");
      if (this.agentRows.length === 0) {
        lines.push("{#444455-fg}  No agents configured{/}");
      } else {
        for (let i = 0; i < this.agentRows.length; i++) {
          const row = this.agentRows[i]!;
          const sel = i === this.agentSelIdx ? "{bold}{cyan-fg}▸{/}{/}" : "  ";
          const inEdit = i === this.agentSelIdx && this.agentEditMode;
          const valStr = inEdit
            ? `{cyan-fg}[{/}{white-fg}${this.agentEditBuf}{/}{cyan-fg}▌]{/}`
            : row.type === "boolean"
              ? (row.value === "true" ? "{green-fg}✓ enabled{/}" : "{red-fg}✗ disabled{/}")
              : `{white-fg}${row.value || "{#444455-fg}(empty)"}{/}`;
          lines.push(`${sel} {cyan-fg}${row.provider.padEnd(11)}{/} {#888899-fg}${row.field.padEnd(19)}{/} ${valStr}`);
        }
      }
      lines.push("", "{#666677-fg}J/K=navigate  E=edit  Enter=save  Esc=cancel  boolean: Enter toggles{/}");
      return lines.join("\n");
    }

    // ── Credentials Tab ───────────────────────────────────────
    if (this.revealWarning) { lines.push(this.revealWarning, ""); }

    if (this.entries.length === 0) {
      lines.push("{#444455-fg}  No credentials found in config.json{/}", `  {#666677-fg}Path: {/}{white-fg}${CONFIG_PATH}{/}`);
    } else {
      for (let i = 0; i < this.entries.length; i++) {
        const e   = this.entries[i]!;
        const sel = i === this.selectedIdx ? "{bold}{cyan-fg}▸{/}{/}" : "  ";
        const enc = e.encrypted ? "{green-fg}🔒{/}" : "{red-fg}⚠{/}";
        const inEdit = i === this.selectedIdx && this.editMode;
        const val = inEdit
          ? `{cyan-fg}[{/}{white-fg}${this.editBuf}{/}{cyan-fg}▌]{/}`
          : e.revealed && e.value ? `{yellow-fg}${maskPartial(e.value)}{/}` : `{#666677-fg}${e.masked}{/}`;
        lines.push(`${sel} ${enc} {white-fg}${e.path.padEnd(35)}{/} ${val}`);
      }
    }

    const enc = this.entries.filter(e => e.encrypted).length;
    const tot = this.entries.length;
    const c   = enc === tot && tot > 0 ? "green" : tot > 0 ? "red" : "grey";
    lines.push("", "{#3a3a4a-fg}" + "─".repeat(60) + "{/}", "{#888899-fg}ENCRYPTION STATUS{/}");
    lines.push(`  {${c}-fg}${enc}/${tot} credentials encrypted{/}`);
    if (enc < tot && tot > 0) lines.push("  {red-fg}⚠ Plaintext credentials detected!{/}");
    lines.push("", `{#666677-fg}Config path: ${CONFIG_PATH}{/}`);
    if (this.pinMsg) lines.push("", this.pinMsg);
    const pinStatus = this.pin
      ? "{green-fg}🔒 PIN set — vault will auto-lock 60s after closing{/}"
      : "{#666677-fg}No PIN set — type 4 digits to set one (p=lock once set){/}";
    lines.push("", pinStatus);
    return lines.join("\n");
  }
}

function maskPlaintext(value: string): string {
  if (value.length <= 8) return "●".repeat(value.length);
  return value.slice(0, 4) + "●".repeat(Math.min(8, value.length - 8)) + value.slice(-4);
}

function maskPartial(value: string): string {
  if (value.length <= 12) return value.slice(0, 4) + "●".repeat(value.length - 4);
  return value.slice(0, 8) + "●".repeat(4) + value.slice(-4);
}
