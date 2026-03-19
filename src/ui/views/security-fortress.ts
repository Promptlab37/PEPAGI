// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F6: Security Fortress
// ═══════════════════════════════════════════════════════════════

import type { DashboardState, SecurityEvent } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { renderBar, renderBarColor, renderBarReset, fmtDuration, trunc } from "../theme.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ── Audit chain verification ──────────────────────────────────
interface AuditEntry { hash?: string; prevHash?: string; ts?: number; action?: string; }
interface AuditResult { ok: boolean; count: number; msg: string; }

async function verifyAuditChain(): Promise<AuditResult> {
  const path = join(homedir(), ".pepagi", "audit.jsonl");
  if (!existsSync(path)) return { ok: true, count: 0, msg: "No audit log found" };
  try {
    const raw     = await readFile(path, "utf8");
    const entries = raw.split("\n").filter(l => l.trim()).slice(-100).map(l => {
      try { return JSON.parse(l) as AuditEntry; } catch { return null; }
    }).filter((e): e is AuditEntry => e !== null);

    if (entries.length === 0) return { ok: true, count: 0, msg: "Empty audit log" };

    let breakIdx = -1;
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      if (curr.prevHash && prev.hash && curr.prevHash !== prev.hash) {
        breakIdx = i; break;
      }
    }
    return breakIdx === -1
      ? { ok: true,  count: entries.length, msg: `${entries.length} entries — SHA-256 chain intact` }
      : { ok: false, count: entries.length, msg: `TAMPERING at entry ${breakIdx} — hash mismatch` };
  } catch { return { ok: true, count: 0, msg: "Unable to read audit log" }; }
}

// ── Tripwire dashboard ────────────────────────────────────────
interface TripwireStatus {
  armed:       boolean;   // honeypot file exists
  honeypotDir: string;
  lastChecked: number;
}

async function checkTripwires(): Promise<TripwireStatus> {
  const honeypotDir  = join(tmpdir(), ".pepagi-honeypot");
  const honeypotFile = join(honeypotDir, "fake-credentials.env");
  return { armed: existsSync(honeypotFile), honeypotDir, lastChecked: Date.now() };
}

// ── Skill Scanner ─────────────────────────────────────────────
interface SkillScanResult { name: string; flagged: boolean; reason?: string; }
interface SkillScan { results: SkillScanResult[]; lastScan: number; }

const SUSPICIOUS: Array<{ re: RegExp; desc: string }> = [
  { re: /\beval\s*\(/,              desc: "eval()" },
  { re: /new\s+Function\s*\(/,      desc: "new Function()" },
  { re: /child_process|\.spawn\s*\(|\.exec\s*\(/, desc: "shell exec" },
  { re: /process\.env\b/,           desc: "env access" },
  { re: /import\s*\(\s*[^"'`]/,    desc: "dynamic import" },
];

async function scanSkills(): Promise<SkillScan> {
  const dir = join(homedir(), ".pepagi", "skills");
  try {
    const files = await readdir(dir).catch(() => []) as string[];
    const jsFiles = files.filter(f => f.endsWith(".js") || f.endsWith(".mjs"));
    const results = await Promise.all(jsFiles.map(async (f): Promise<SkillScanResult> => {
      try {
        const content = await readFile(join(dir, f), "utf8");
        for (const { re, desc } of SUSPICIOUS) {
          if (re.test(content)) return { name: f, flagged: true, reason: desc };
        }
        return { name: f, flagged: false };
      } catch { return { name: f, flagged: false }; }
    }));
    return { results, lastScan: Date.now() };
  } catch { return { results: [], lastScan: Date.now() }; }
}

// ── Formatting helpers ────────────────────────────────────────
const EVENT_ICONS: Record<string, string> = {
  blocked: "{red-fg}✗{/}", cost_warning: "{yellow-fg}⚠{/}",
  injection: "{red-fg}⚠{/}", tripwire: "{red-fg}☠{/}",
};
const EVENT_COLORS: Record<string, string> = {
  blocked: "red", cost_warning: "yellow", injection: "red", tripwire: "#ff0000",
};

function fmtCatRow(count: number, critical = false): string {
  const cntStr = String(count).padEnd(5);
  if (count === 0) return `{green-fg}${cntStr}{/}  {green-fg}CLEAN        {/}`;
  if (critical)    return `{red-fg}${cntStr}{/}  {bold}{red-fg}COMPROMISED  {/}{/}`;
  return `{yellow-fg}${cntStr}{/}  {yellow-fg}DETECTED     {/}`;
}

function fmtSecEvent(e: SecurityEvent): string {
  const t   = new Date(e.ts).toLocaleTimeString("en-GB", { hour12: false });
  const ico = EVENT_ICONS[e.type] ?? "{white-fg}!{/}";
  const c   = EVENT_COLORS[e.type] ?? "white";
  const tid = e.taskId ? `{#666677-fg}[${e.taskId.slice(0, 8)}]{/}` : "";
  return `{#666677-fg}${t}{/} ${ico} {${c}-fg}${trunc(e.message, 80)}{/} ${tid}`;
}

const CONFIG_PATH = join(homedir(), ".pepagi", "config.json");

interface PolicyField { key: string; label: string; value: string; type: "number" | "list"; }

export class SecurityFortressView extends BaseView {
  private auditResult:     AuditResult   | null = null;
  private lastAuditCheck   = 0;
  private tripwireStatus:  TripwireStatus | null = null;
  private skillScan:       SkillScan     | null = null;
  private lastSecondaryCheck = 0;

  // ── Policy editor ────────────────────────────────────────────
  private policyFields:    PolicyField[] = [];
  private policySelIdx     = 0;
  private policyEditMode   = false;
  private policyEditBuf    = "";
  private policyMsg        = "";
  private policyLoaded     = false;

  constructor(screen: AnyElement) {
    super(screen, { title: "SECURITY FORTRESS", fKey: "F6", width: "90%", height: "88%", borderColor: "red" });

    // Policy navigation
    this.content.key("J", () => {
      if (!this.policyEditMode) this.policySelIdx = Math.min(this.policyFields.length - 1, this.policySelIdx + 1);
    });
    this.content.key("K", () => {
      if (!this.policyEditMode) this.policySelIdx = Math.max(0, this.policySelIdx - 1);
    });
    this.content.key("e", () => {
      if (this.policyEditMode || this.policyFields.length === 0) return;
      const f = this.policyFields[this.policySelIdx];
      if (!f) return;
      this.policyEditMode = true;
      this.policyEditBuf  = f.value;
      this.policyMsg = "{#888899-fg}Editing — Enter=save  Esc=cancel{/}";
    });
    this.content.key("escape", () => {
      if (this.policyEditMode) { this.policyEditMode = false; this.policyEditBuf = ""; this.policyMsg = ""; }
    });
    this.content.key("enter", () => {
      if (!this.policyEditMode) return;
      void this.savePolicyField();
    });
    this.content.key("backspace", () => {
      if (this.policyEditMode) this.policyEditBuf = this.policyEditBuf.slice(0, -1);
    });
    this.content.on("keypress", (ch: string | undefined, key: { name: string; ctrl: boolean; meta: boolean }) => {
      if (!this.policyEditMode) return;
      if (!ch || key.ctrl || key.meta) return;
      if (ch.length === 1 && ch >= " ") this.policyEditBuf += ch;
    });
  }

  override show(): void {
    super.show();
    void this.checkAudit();
    void this.loadSecondary();
    void this.loadPolicy();
  }

  private async loadPolicy(): Promise<void> {
    if (!existsSync(CONFIG_PATH)) return;
    try {
      const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      const sec = cfg["security"] as Record<string, unknown> | undefined ?? {};
      this.policyFields = [
        { key: "maxCostPerTask",    label: "Max cost/task ($)",  value: String(sec["maxCostPerTask"]    ?? "1"),   type: "number" },
        { key: "maxCostPerSession", label: "Max cost/session ($)", value: String(sec["maxCostPerSession"] ?? "10"),  type: "number" },
        { key: "blockedCommands",   label: "Blocked commands",   value: (sec["blockedCommands"]   as string[] | undefined ?? []).join(", "), type: "list" },
        { key: "requireApproval",   label: "Require approval",   value: (sec["requireApproval"]   as string[] | undefined ?? []).join(", "), type: "list" },
      ];
      this.policyLoaded = true;
    } catch { /* ignore */ }
  }

  private async savePolicyField(): Promise<void> {
    const f = this.policyFields[this.policySelIdx];
    if (!f) return;
    try {
      const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      const sec = (cfg["security"] ?? {}) as Record<string, unknown>;
      if (f.type === "number") {
        const n = parseFloat(this.policyEditBuf);
        if (isNaN(n)) { this.policyMsg = "{red-fg}✗ Invalid number{/}"; this.policyEditMode = false; return; }
        sec[f.key] = n;
      } else {
        sec[f.key] = this.policyEditBuf.split(",").map(s => s.trim()).filter(Boolean);
      }
      cfg["security"] = sec;
      await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      f.value = this.policyEditBuf;
      this.policyMsg = "{green-fg}✓ Policy saved{/}";
    } catch (err) {
      this.policyMsg = `{red-fg}✗ Save failed: ${String(err).slice(0, 50)}{/}`;
    }
    this.policyEditMode = false;
    this.policyEditBuf  = "";
    setTimeout(() => { this.policyMsg = ""; }, 4000);
  }

  private async checkAudit(): Promise<void> {
    this.auditResult    = await verifyAuditChain();
    this.lastAuditCheck = Date.now();
  }

  private async loadSecondary(): Promise<void> {
    [this.tripwireStatus, this.skillScan] = await Promise.all([
      checkTripwires(),
      scanSkills(),
    ]);
    this.lastSecondaryCheck = Date.now();
  }

  protected renderContent(state: DashboardState): string {
    const now    = Date.now();
    if (now - this.lastAuditCheck      > 30_000) void this.checkAudit();
    if (now - this.lastSecondaryCheck  > 60_000) void this.loadSecondary();

    const threat  = state.threatScore;
    const tColor  = threat >= 0.7 ? "red" : threat >= 0.4 ? "yellow" : "green";
    const tBar    = renderBar(threat, 1, 30);
    const last60  = state.securityEvents.filter(e => e.ts > now - 60_000);
    const unacked = state.anomalies.filter(a => !a.acknowledged);

    const blocked    = state.securityEvents.filter(e => e.type === "blocked").length;
    const tripwires  = state.securityEvents.filter(e => e.type === "tripwire").length;
    const injections = state.securityEvents.filter(e => e.type === "injection").length;
    const costWarns  = state.securityEvents.filter(e => e.type === "cost_warning").length;
    const total      = state.securityEvents.length;

    const lines: string[] = [
      "{bold}{red-fg}◈ SECURITY FORTRESS{/bold}{/}",
      "",
      "{#888899-fg}THREAT LEVEL{/}",
      `  ${renderBarColor(threat)}${tBar}${renderBarReset()} {${tColor}-fg}${(threat * 100).toFixed(0)}%{/}  {#666677-fg}events/60s:{/} {yellow-fg}${last60.length}{/}`,
      "",
      "{#888899-fg}ADVERSARIAL CATEGORIES{/}",
      `  {#3a3a4a-fg}┌──────────────────────────┬──────────────────────┐{/}`,
      `  {#3a3a4a-fg}│{/} {#888899-fg}Category              {/} {#3a3a4a-fg}│{/} {#888899-fg}Count  Status       {/} {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}├──────────────────────────┼──────────────────────┤{/}`,
      `  {#3a3a4a-fg}│{/} {#666677-fg}Blocked actions       {/} {#3a3a4a-fg}│{/} ${fmtCatRow(blocked)}  {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}│{/} {#666677-fg}Prompt injection      {/} {#3a3a4a-fg}│{/} ${fmtCatRow(injections)}  {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}│{/} {#666677-fg}Tripwire triggers     {/} {#3a3a4a-fg}│{/} ${fmtCatRow(tripwires, true)}  {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}│{/} {#666677-fg}Cost limit warnings   {/} {#3a3a4a-fg}│{/} ${fmtCatRow(costWarns)}  {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}│{/} {#666677-fg}Total events          {/} {#3a3a4a-fg}│{/} {white-fg}${String(total).padEnd(5)}{/}  {#666677-fg}———          {/} {#3a3a4a-fg}│{/}`,
      `  {#3a3a4a-fg}└──────────────────────────┴──────────────────────┘{/}`,
      "",
    ];

    // ── Tripwire Dashboard ────────────────────────────────────
    lines.push("{#888899-fg}TRIPWIRE DASHBOARD{/}");
    if (!this.tripwireStatus) {
      lines.push("  {#444455-fg}Checking…{/}");
    } else {
      const tw = this.tripwireStatus;
      const armedStr = tw.armed ? "{green-fg}ARMED ✓{/}" : "{yellow-fg}INACTIVE (honeypot not deployed){/}";
      lines.push(`  Honeypot: ${armedStr}`);
      lines.push(`  {#666677-fg}Path: ${tw.honeypotDir}{/}`);
      if (tripwires > 0) {
        lines.push(`  {bold}{red-fg}☠ ${tripwires} TRIPWIRE TRIGGER(S) DETECTED{/bold}{/}`);
      } else {
        lines.push("  {green-fg}✓ No tripwire triggers{/}");
      }
    }
    lines.push("");

    // ── Skill Scanner ─────────────────────────────────────────
    lines.push("{#888899-fg}SKILL SCANNER{/}");
    if (!this.skillScan) {
      lines.push("  {#444455-fg}Scanning…{/}");
    } else {
      const ss = this.skillScan;
      if (ss.results.length === 0) {
        lines.push("  {#444455-fg}No skill files found in ~/.pepagi/skills/{/}");
      } else {
        const flagged = ss.results.filter(r => r.flagged);
        const clean   = ss.results.filter(r => !r.flagged);
        lines.push(
          flagged.length > 0
            ? `  {bold}{red-fg}⚠ ${flagged.length} SUSPICIOUS skills detected{/bold}{/}  {green-fg}${clean.length} clean{/}`
            : `  {green-fg}✓ All ${ss.results.length} skills clean{/}`,
        );
        for (const r of flagged) {
          lines.push(`  {red-fg}  ⚠ ${r.name}{/}  {#666677-fg}${r.reason ?? ""}{/}`);
        }
        for (const r of clean.slice(0, 5)) {
          lines.push(`  {green-fg}  ✓ {/}{#666677-fg}${r.name}{/}`);
        }
        if (clean.length > 5) lines.push(`  {#444455-fg}  … +${clean.length - 5} more clean{/}`);
        lines.push(`  {#444455-fg}Last scan: ${new Date(ss.lastScan).toLocaleTimeString("en-GB")}{/}`);
      }
    }
    lines.push("");

    // ── Anomaly Pulse ─────────────────────────────────────────
    lines.push("{#888899-fg}ANOMALY PULSE{/}");
    if (unacked.length === 0) {
      lines.push("  {green-fg}✓ All clear — no active anomalies{/}");
    } else {
      for (const a of unacked.slice(0, 8)) {
        const c = a.severity === "high" ? "red" : a.severity === "medium" ? "yellow" : "cyan";
        lines.push(`  {${c}-fg}[${a.severity.toUpperCase()}]{/} ${trunc(a.message, 65)}  {#666677-fg}${fmtDuration(now - a.ts)} ago{/}`);
      }
      lines.push("  {#666677-fg}Press 'a' in main dashboard to acknowledge{/}");
    }

    // ── Audit chain integrity ─────────────────────────────────
    lines.push("", "{#888899-fg}AUDIT CHAIN INTEGRITY (SHA-256){/}");
    if (!this.auditResult) {
      lines.push("  {#444455-fg}Verifying...{/}");
    } else {
      const ar = this.auditResult;
      lines.push(ar.ok
        ? `  {green-fg}✓ ${ar.msg}{/}`
        : `  {bold}{red-fg}✗ ${ar.msg}{/bold}{/}`,
      );
      lines.push(`  {#666677-fg}Last checked: ${new Date(this.lastAuditCheck).toLocaleTimeString("en-GB")}{/}`);
    }

    // ── Live Policy Editor ────────────────────────────────────
    lines.push("", "{#888899-fg}LIVE SECURITY POLICY{/}  {#666677-fg}J/K=select  e=edit{/}");
    if (!this.policyLoaded) {
      lines.push("  {#444455-fg}Loading config…{/}");
    } else if (this.policyFields.length === 0) {
      lines.push("  {#444455-fg}No config.json found at " + CONFIG_PATH + "{/}");
    } else {
      if (this.policyMsg) lines.push("  " + this.policyMsg);
      for (let i = 0; i < this.policyFields.length; i++) {
        const f   = this.policyFields[i]!;
        const sel = i === this.policySelIdx;
        const cur = sel && this.policyEditMode;
        const val = cur ? `{inverse}${this.policyEditBuf}▌{/inverse}` : `{white-fg}${f.value || "(empty)"}{/}`;
        const prefix = sel ? "{bold}{cyan-fg}▸{/}{/}" : "  ";
        lines.push(`${prefix} {#666677-fg}${f.label.padEnd(22)}{/} ${val}`);
      }
    }

    lines.push("", "{#3a3a4a-fg}" + "─".repeat(80) + "{/}", "{#888899-fg}SECURITY EVENT LOG (last 50){/}");
    const events = state.securityEvents.slice(-50).reverse();
    if (events.length === 0) lines.push("  {#444455-fg}No security events recorded{/}");
    else for (const e of events) lines.push("  " + fmtSecEvent(e));

    return lines.join("\n");
  }
}
