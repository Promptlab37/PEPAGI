// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F2: Memory Deep Dive
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { trunc } from "../theme.js";

const DATA = join(homedir(), ".pepagi");

type LevelNum = 1 | 2 | 3 | 4 | 5;
type SortMode = "date" | "confidence";

const LEVEL_LABELS: Record<LevelNum, string> = {
  1: "Working  ",
  2: "Episodic ",
  3: "Semantic ",
  4: "Procedural",
  5: "Meta/Refl",
};
const LEVEL_FILES: Record<LevelNum, string> = {
  1: "working.jsonl",
  2: "episodes.jsonl",
  3: "knowledge.jsonl",
  4: "procedures.jsonl",
  5: "reflections.jsonl",
};

interface MemEntry {
  preview:     string;
  fields:      Array<[string, string]>;
  confidence?: number;
  ts?:         number;
  rawLine?:    string;   // original JSON line (for write-back)
}

function parseEntry(level: LevelNum, raw: string): MemEntry {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw) as Record<string, unknown>; }
  catch { return { preview: trunc(raw, 80), fields: [["raw", raw]] }; }

  const fields: Array<[string, string]> = [];
  let preview = "";
  let confidence: number | undefined;
  let ts: number | undefined;

  if (typeof obj["confidence"] === "number") confidence = obj["confidence"] as number;
  if (typeof obj["createdAt"]  === "number") ts = obj["createdAt"] as number;
  if (typeof obj["timestamp"]  === "number") ts = obj["timestamp"] as number;
  if (typeof obj["ts"]         === "number") ts = obj["ts"] as number;

  if (level === 2) {
    preview = String(obj["taskTitle"] ?? obj["id"] ?? "episode").slice(0, 80);
    for (const k of ["taskTitle", "success", "agentsUsed", "cost", "duration", "tags", "failureReason"]) {
      if (obj[k] !== undefined) fields.push([k, JSON.stringify(obj[k]).slice(0, 80)]);
    }
  } else if (level === 3) {
    preview = String(obj["fact"] ?? obj["content"] ?? "fact").slice(0, 80);
    for (const k of ["fact", "confidence", "source", "tags", "lastVerified"]) {
      if (obj[k] !== undefined) fields.push([k, JSON.stringify(obj[k]).slice(0, 80)]);
    }
  } else if (level === 4) {
    preview = String(obj["name"] ?? obj["id"] ?? "procedure").slice(0, 80);
    for (const k of ["name", "description", "triggerPattern", "successRate", "timesUsed", "averageCost"]) {
      if (obj[k] !== undefined) fields.push([k, JSON.stringify(obj[k]).slice(0, 80)]);
    }
  } else if (level === 5) {
    preview = String(obj["summary"] ?? obj["reflection"] ?? "reflection").slice(0, 80);
    for (const k of ["summary", "reflection", "score", "createdAt"]) {
      if (obj[k] !== undefined) fields.push([k, JSON.stringify(obj[k]).slice(0, 80)]);
    }
  } else {
    preview = Object.keys(obj).slice(0, 3).map(k => `${k}:${JSON.stringify(obj[k])}`).join(" ").slice(0, 80);
    for (const [k, v] of Object.entries(obj).slice(0, 10)) {
      fields.push([k, JSON.stringify(v).slice(0, 80)]);
    }
  }

  return { preview, fields, confidence, ts, rawLine: raw };
}

async function loadLevelEntries(level: LevelNum): Promise<MemEntry[]> {
  if (level === 1) {
    const wFile = join(DATA, "memory", "working.jsonl");
    if (!existsSync(wFile)) return [{ preview: "In-memory rolling context (not persisted to disk)", fields: [] }];
    try {
      const raw = await readFile(wFile, "utf8");
      const lines = raw.split("\n").filter(l => l.trim());
      if (lines.length === 0) return [{ preview: "(working memory empty)", fields: [] }];
      return lines.map(l => parseEntry(1, l));
    } catch {
      return [{ preview: "In-memory rolling context (not persisted to disk)", fields: [] }];
    }
  }
  if (level === 4) {
    // Level 4: also scan skills directory
    const procFile = join(DATA, "memory", LEVEL_FILES[4]);
    const entries: MemEntry[] = [];
    if (existsSync(procFile)) {
      try {
        const raw = await readFile(procFile, "utf8");
        for (const line of raw.split("\n").filter(l => l.trim())) {
          entries.push(parseEntry(4, line));
        }
      } catch { /* ignore */ }
    }
    try {
      const files = await readdir(join(DATA, "skills")).catch(() => []) as string[];
      for (const f of files.filter(x => x.endsWith(".json") || x.endsWith(".mjs"))) {
        entries.push({ preview: `[skill] ${f}`, fields: [["file", f]] });
      }
    } catch { /* ignore */ }
    return entries;
  }
  const file = join(DATA, "memory", LEVEL_FILES[level]);
  if (!existsSync(file)) return [];
  try {
    const raw = await readFile(file, "utf8");
    return raw.split("\n").filter(l => l.trim()).map(l => parseEntry(level, l));
  } catch { return []; }
}

export class MemoryExplorerView extends BaseView {
  private level:       LevelNum  = 2;
  private entryIdx     = 0;
  private expanded     = false;
  private fullJson     = false;
  private sortMode:    SortMode  = "date";
  private levelEntries: Map<LevelNum, MemEntry[]> = new Map();
  private levelLoaded:  Set<LevelNum> = new Set();
  private loadingLevel: Set<LevelNum> = new Set();
  private actionMsg     = "";

  constructor(screen: AnyElement) {
    super(screen, { title: "MEMORY DEEP DIVE", fKey: "F2", width: "80%", height: "85%", borderColor: "blue" });

    // Level tabs 1-5
    for (const d of "12345") {
      this.content.key(d, () => {
        this.level    = parseInt(d, 10) as LevelNum;
        this.entryIdx = 0;
        this.expanded = false;
        if (!this.levelLoaded.has(this.level)) void this.loadLevel(this.level);
      });
    }
    this.content.key("j", () => {
      const entries = this.sortedEntries();
      this.entryIdx = Math.min(entries.length - 1, this.entryIdx + 1);
      this.expanded = false;
    });
    this.content.key("k", () => {
      this.entryIdx = Math.max(0, this.entryIdx - 1);
      this.expanded = false;
    });
    this.content.key(["enter", "space"], () => { this.expanded = !this.expanded; this.fullJson = false; });
    this.content.key("f", () => {
      if (!this.expanded) { this.expanded = true; }
      this.fullJson = !this.fullJson;
    });
    this.content.key("s", () => {
      this.sortMode = this.sortMode === "date" ? "confidence" : "date";
    });
    this.content.key("r", () => {
      this.levelLoaded.delete(this.level);
      void this.loadLevel(this.level);
    });
    // Soft delete (mark deleted: true)
    this.content.key("d", () => { void this.softDeleteEntry(); });
    // Hard delete (remove line)
    this.content.key("D", () => { void this.hardDeleteEntry(); });
    // Promote (increase confidence)
    this.content.key("p", () => { void this.promoteEntry(); });
  }

  private currentEntry(): MemEntry | undefined {
    return this.sortedEntries()[this.entryIdx];
  }

  private async softDeleteEntry(): Promise<void> {
    const entry = this.currentEntry();
    if (!entry?.rawLine) { this.actionMsg = "{#444455-fg}No entry selected or not editable{/}"; return; }
    try {
      const obj = JSON.parse(entry.rawLine) as Record<string, unknown>;
      obj["deleted"] = true;
      entry.rawLine    = JSON.stringify(obj);
      entry.preview    = `{#666677-fg}[deleted] {/}${entry.preview}`;
      await this.rewriteLevel();
      this.actionMsg = "{yellow-fg}✓ Marked as deleted{/}";
    } catch { this.actionMsg = "{red-fg}✗ Soft-delete failed{/}"; }
    setTimeout(() => { this.actionMsg = ""; }, 3000);
  }

  private async hardDeleteEntry(): Promise<void> {
    const entry = this.currentEntry();
    if (!entry) return;
    if (this.level === 1) { this.actionMsg = "{red-fg}Working memory is in-RAM only{/}"; return; }
    const rawEntries = this.levelEntries.get(this.level) ?? [];
    const idx = rawEntries.indexOf(entry);
    if (idx >= 0) rawEntries.splice(idx, 1);
    this.levelEntries.set(this.level, rawEntries);
    this.entryIdx = Math.max(0, this.entryIdx - 1);
    await this.rewriteLevel();
    this.actionMsg = "{red-fg}✓ Entry removed permanently{/}";
    setTimeout(() => { this.actionMsg = ""; }, 3000);
  }

  private async promoteEntry(): Promise<void> {
    const entry = this.currentEntry();
    if (!entry?.rawLine) { this.actionMsg = "{#444455-fg}No entry selected or not editable{/}"; return; }
    try {
      const obj  = JSON.parse(entry.rawLine) as Record<string, unknown>;
      const curr = typeof obj["confidence"] === "number" ? obj["confidence"] as number : 0.5;
      const next = Math.min(1.0, parseFloat((curr + 0.1).toFixed(2)));
      obj["confidence"]  = next;
      entry.confidence   = next;
      entry.rawLine      = JSON.stringify(obj);
      await this.rewriteLevel();
      this.actionMsg = `{green-fg}✓ Promoted → ${(next * 100).toFixed(0)}%{/}`;
    } catch { this.actionMsg = "{red-fg}✗ Promote failed{/}"; }
    setTimeout(() => { this.actionMsg = ""; }, 3000);
  }

  private async rewriteLevel(): Promise<void> {
    if (this.level === 1) return; // in-RAM only
    const file = join(DATA, "memory", LEVEL_FILES[this.level]);
    const entries = this.levelEntries.get(this.level) ?? [];
    const lines = entries
      .map(e => e.rawLine ?? "")
      .filter(l => l.trim());
    try {
      await writeFile(file, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
    } catch { /* ignore write errors */ }
  }

  override show(): void {
    super.show();
    if (!this.levelLoaded.has(this.level)) void this.loadLevel(this.level);
  }

  private async loadLevel(level: LevelNum): Promise<void> {
    if (this.loadingLevel.has(level)) return;
    this.loadingLevel.add(level);
    try {
      const entries = await loadLevelEntries(level);
      this.levelEntries.set(level, entries);
      this.levelLoaded.add(level);
    } finally {
      this.loadingLevel.delete(level);
    }
  }

  private sortedEntries(): MemEntry[] {
    const entries = [...(this.levelEntries.get(this.level) ?? [])];
    if (this.sortMode === "confidence") {
      entries.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
    } else {
      entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    }
    return entries;
  }

  protected renderContent(_state: DashboardState): string {
    // ── Tab header ──────────────────────────────────────────
    const tabs = ([1, 2, 3, 4, 5] as LevelNum[]).map(n => {
      const cnt = this.levelEntries.get(n)?.length ?? "?";
      const label = `L${n}:${LEVEL_LABELS[n]}(${cnt})`;
      return n === this.level
        ? `{bold}{cyan-fg}[${label}]{/}{/}`
        : `{#666677-fg}[${label}]{/}`;
    }).join(" ");

    const sortLabel = this.sortMode === "date" ? "sort:date↓" : "sort:conf↓";
    const lines: string[] = [
      "{bold}{blue-fg}◈ MEMORY DEEP DIVE{/bold}{/}",
      tabs,
      `{#666677-fg}1-5=level  j/k=nav  Enter=expand  f=raw-JSON  s=${sortLabel}  d=soft-del  D=hard-del  p=promote  r=refresh{/}`,
      "{#3a3a4a-fg}" + "─".repeat(70) + "{/}",
    ];
    if (this.actionMsg) lines.push(this.actionMsg);

    const loading = this.loadingLevel.has(this.level);
    const entries = this.sortedEntries();

    if (loading && entries.length === 0) {
      lines.push("  {#444455-fg}Loading…{/}");
      return lines.join("\n");
    }
    if (entries.length === 0) {
      lines.push("  {#444455-fg}No entries found{/}");
      lines.push(`  {#444455-fg}File: ${this.level === 1 ? "(working memory — in-RAM)" : join(DATA, "memory", LEVEL_FILES[this.level])}{/}`);
      return lines.join("\n");
    }

    // ── Entry list ───────────────────────────────────────────
    const pageSize = 18;
    const start    = Math.max(0, this.entryIdx - Math.floor(pageSize / 2));
    const visible  = entries.slice(start, start + pageSize);

    for (let i = 0; i < visible.length; i++) {
      const absIdx = start + i;
      const e      = visible[i]!;
      const sel    = absIdx === this.entryIdx;
      const cursor = sel ? "{bold}{cyan-fg}▸{/}{/}" : "  ";
      const conf   = e.confidence != null
        ? ` {${e.confidence >= 0.7 ? "green" : e.confidence >= 0.4 ? "yellow" : "red"}-fg}${(e.confidence * 100).toFixed(0)}%{/}`
        : "";
      const tsStr  = e.ts ? ` {#444455-fg}${new Date(e.ts).toLocaleDateString()}{/}` : "";
      lines.push(`${cursor} {#888899-fg}${String(absIdx + 1).padStart(4)}{/}  ${trunc(e.preview, 60)}${conf}${tsStr}`);

      // Expanded view for selected entry
      if (sel && this.expanded) {
        lines.push("  {#3a3a4a-fg}" + "─".repeat(66) + "{/}");
        if (this.fullJson && e.rawLine) {
          // Full raw JSON pretty-printed
          try {
            const parsed = JSON.parse(e.rawLine) as unknown;
            const pretty = JSON.stringify(parsed, null, 2).split("\n");
            for (const l of pretty.slice(0, 40)) lines.push(`  {#666677-fg}${l}{/}`);
            if (pretty.length > 40) lines.push(`  {#444455-fg}… (${pretty.length - 40} more lines){/}`);
          } catch { lines.push(`  {#666677-fg}${e.rawLine}{/}`); }
          lines.push(`  {#444455-fg}f=toggle fields view{/}`);
        } else {
          for (const [k, v] of e.fields) {
            lines.push(`  {#666677-fg}${k.padEnd(16)}{/} {white-fg}${v}{/}`);
          }
          if (e.fields.length === 0) lines.push("  {#444455-fg}(no fields){/}");
          if (e.rawLine) lines.push(`  {#444455-fg}f=raw JSON view{/}`);
        }
        lines.push("  {#3a3a4a-fg}" + "─".repeat(66) + "{/}");
      }
    }

    lines.push("", `{#444455-fg}${entries.length} total  showing ${start + 1}–${Math.min(start + pageSize, entries.length)}{/}`);
    return lines.join("\n");
  }
}
