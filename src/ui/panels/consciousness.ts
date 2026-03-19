// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Consciousness Observatory Panel
// ═══════════════════════════════════════════════════════════════
//
// Shows:
//  • Top: 11 qualia dimension bars with colored ▓▓▓░░░ style
//  • Middle: dominant emotion emoji + label
//  • Bottom: scrolling inner monologue log (last 5 thoughts)

import type { DashboardState } from "../state.js";
import {
  C, renderBar, renderBarColor, renderBarReset,
  dominantQualiaEmoji, arrowDir, trunc,
} from "../theme.js";
import { blessed as _blessed } from "../cjs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = any;

// ── Monologue category coloring ───────────────────────────────
function monologueColor(thought: string): string {
  const t = thought;
  if (/\b(plan|strateg|approach|decompos|structur|organiz)/i.test(t))  return "#5c8aff";  // planning
  if (/\b(reflect|consider|evaluat|assess|analyz|review)/i.test(t))    return "#c084fc";  // reflection
  if (/\b(unsure|uncertain|confus|unclear|don.t know|unknown)/i.test(t)) return "#ffd93d"; // uncertainty
  if (/\b(error|fail|problem|issue|wrong|broke|crash|except)/i.test(t)) return "#ff6b6b"; // error
  if (/\b(success|complet|done|finish|solved|achiev|great)/i.test(t))  return "#4ade80";  // success
  if (/\b(question|why\b|how\b|what\b|explor|wonder|invest)/i.test(t)) return "#00e5cc";  // questioning
  return "#aaaacc";
}

const QUALIA_ORDER = [
  "pleasure", "arousal", "dominance", "clarity",
  "curiosity", "confidence", "frustration", "satisfaction",
  "selfCoherence", "existentialComfort", "purposeAlignment",
] as const;

const QUALIA_LABELS: Record<string, string> = {
  pleasure:          "Pleasure    ",
  arousal:           "Arousal     ",
  dominance:         "Dominance   ",
  clarity:           "Clarity     ",
  curiosity:         "Curiosity   ",
  confidence:        "Confidence  ",
  frustration:       "Frustration ",
  satisfaction:      "Satisfaction",
  selfCoherence:     "Coherence   ",
  existentialComfort:"Existential ",
  purposeAlignment:  "Purpose     ",
};

export class ConsciousnessPanel {
  private box:        AnyElement;
  private content:    AnyElement;
  private title = " CONSCIOUSNESS ";
  private prevQualia: Record<string, number> = {};
  private inBreach    = false;

  constructor(
    parent: AnyElement,
    geom: { top: number; left: number; width: number; height: number },
  ) {
    this.box = _blessed.box({
      parent,
      top:    geom.top,
      left:   geom.left,
      width:  geom.width,
      height: geom.height,
      tags:   true,
      border: { type: "line", fg: "#3a3a4a" },
      label:  ` {gold-fg}🧠 ${this.title}{/} `,
      style: { fg: "white", bg: "black", border: { fg: "#3a3a4a" } },
    });

    this.content = _blessed.box({
      parent: this.box,
      top:    1,
      left:   1,
      width:  "100%-4",
      height: "100%-2",
      tags:   true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "#3a3a4a" } },
      style: { fg: "white", bg: "black" },
    });
  }

  update(state: DashboardState): void {
    if (state.paused) return;

    const q = state.currentQualia;
    const w = Math.max(8, (this.box.width ?? 24) - 20);   // bar width

    const lines: string[] = [];

    // ── Profile header ─────────────────────────────────────
    const { emoji, label } = dominantQualiaEmoji(q);
    const profColor = C.profile[state.consciousnessProfile] ?? "white";
    lines.push(
      `{${profColor}-fg}[${state.consciousnessProfile}]{/}  ${emoji} {bold}${label}{/bold}`,
    );
    lines.push("{#3a3a4a-fg}" + "─".repeat(w + 18) + "{/}");

    // ── Qualia bars ────────────────────────────────────────
    for (const key of QUALIA_ORDER) {
      const val  = q[key] ?? 0;
      const prev = this.prevQualia[key] ?? val;
      const color = C.qualia[key] ?? "white";
      const bar   = renderBar(val, 1, w);
      const bColor = renderBarColor(val);
      const arrow = arrowDir(val, prev);
      const pct   = `${(val * 100).toFixed(0).padStart(3)}%`;
      lines.push(
        `{#888899-fg}${QUALIA_LABELS[key]}{/} ${bColor}${bar}{/} {${color}-fg}${pct}{/} ${arrow}`,
      );
    }

    this.prevQualia = { ...q };

    lines.push("{#3a3a4a-fg}" + "─".repeat(w + 18) + "{/}");

    // ── Self-model ─────────────────────────────────────────
    lines.push("{#666677-fg}SELF-MODEL{/}");
    const integrity  = q["selfCoherence"]      ?? 0;
    const valAlign   = q["purposeAlignment"]   ?? 0;
    const continuity = q["existentialComfort"] ?? 0;
    const intColor   = integrity  >= 0.7 ? "green" : integrity  >= 0.4 ? "yellow" : "red";
    const valColor   = valAlign   >= 0.7 ? "green" : valAlign   >= 0.4 ? "yellow" : "red";
    const conColor   = continuity >= 0.7 ? "cyan"  : continuity >= 0.4 ? "yellow" : "red";
    const qHash      = QUALIA_ORDER.map(k => Math.round((q[k] ?? 0) * 15).toString(16)).join("");
    lines.push(
      `  {#666677-fg}Intgr {/}{${intColor}-fg}${(integrity  * 100).toFixed(0).padStart(3)}%{/}  ` +
      `{#666677-fg}Values {/}{${valColor}-fg}${(valAlign   * 100).toFixed(0).padStart(3)}%{/}  ` +
      `{#666677-fg}Cont {/}{${conColor}-fg}${(continuity * 100).toFixed(0).padStart(3)}%{/}`,
    );
    lines.push(`  {#444455-fg}fingerprint:${qHash.slice(0, 11)}  decisions:${state.decisions.length}{/}`);
    // ── Learning multiplier ─────────────────────────────────
    const ms    = state.memoryStats;
    const total = state.totalCompleted + state.totalFailed;
    const sr    = total > 0 ? state.totalCompleted / total : 0.5;
    const lm    = Math.min(2.0,
      1.0 + Math.min(0.5, ms.skills * 0.1) + Math.min(0.3, ms.procedures * 0.05) + sr * 0.2);
    const lmPct = Math.min(1, (lm - 1.0) / 1.0);
    const lmC   = lmPct >= 0.6 ? "green" : lmPct >= 0.25 ? "yellow" : "white";
    const lmBar = renderBar(lmPct, 1, Math.max(4, w - 8));
    lines.push(
      `  {#666677-fg}Learning×{/} {${lmC}-fg}${lm.toFixed(2)}×{/}  ${renderBarColor(lmPct)}${lmBar}${renderBarReset()}`,
    );

    lines.push("{#3a3a4a-fg}" + "─".repeat(w + 18) + "{/}");

    // ── Breach detection + border flash ───────────────────────
    const conf  = q["confidence"]  ?? 0.5;
    const frust = q["frustration"] ?? 0;
    const breach = conf < 0.3 || frust > 0.8;
    if (breach !== this.inBreach) {
      this.inBreach = breach;
      this.box.style.border = { fg: breach ? "#ff6b6b" : "#3a3a4a" };
    }
    if (breach) {
      const flashOn = Math.floor(Date.now() / 600) % 2 === 0;
      this.box.style.border = { fg: flashOn ? "#ff6b6b" : "#ff0000" };
    }

    // ── Inner monologue ────────────────────────────────────
    lines.push("{#666677-fg}INNER MONOLOGUE{/}");
    const thoughts = state.innerMonologue.slice(-5);
    if (thoughts.length === 0) {
      lines.push("{#444455-fg}  (silent){/}");
    } else {
      for (const t of thoughts) {
        const mc = monologueColor(t);
        lines.push(`{#666677-fg}  › {/}{${mc}-fg}${trunc(t, w + 16)}{/}`);
      }
    }

    this.content.setContent(lines.join("\n"));
  }

  focus(): void {
    this.box.style.border = { fg: "cyan" };
    this.box.setLabel(` {gold-fg}🧠 ${this.title}{/} ← `);
  }

  blur(): void {
    this.box.style.border = { fg: "#3a3a4a" };
    this.box.setLabel(` {gold-fg}🧠 ${this.title}{/} `);
  }

  getElement(): AnyElement { return this.box; }
}
