// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — F5: Consciousness Lab
// ═══════════════════════════════════════════════════════════════

import type { DashboardState } from "../state.js";
import { BaseView } from "./base-view.js";
import type { AnyElement } from "./base-view.js";
import { C, renderBar, renderBarColor, renderBarReset, trunc } from "../theme.js";

const QUALIA_DIMS = [
  "pleasure", "arousal", "dominance", "clarity", "curiosity", "confidence",
  "frustration", "satisfaction", "selfCoherence", "existentialComfort", "purposeAlignment",
] as const;

const QUALIA_SHORT: Record<string, string> = {
  pleasure: "Pleasure    ", arousal: "Arousal     ", dominance: "Dominance   ",
  clarity: "Clarity     ", curiosity: "Curiosity   ", confidence: "Confidence  ",
  frustration: "Frustration ", satisfaction: "Satisfaction", selfCoherence: "Coherence   ",
  existentialComfort: "Existential ", purposeAlignment: "Purpose     ",
};

const BLOCKS = " ░▒▓█";

export class ConsciousnessLabView extends BaseView {
  private scrubIndex = -1;

  constructor(screen: AnyElement) {
    super(screen, { title: "CONSCIOUSNESS LAB", fKey: "F5", width: "85%", height: "90%", borderColor: "#c084fc" });
    this.content.key("left",  () => { this.scrubIndex = Math.max(0, this.scrubIndex === -1 ? 0 : this.scrubIndex - 1); });
    this.content.key("right", () => { if (this.scrubIndex !== -1) this.scrubIndex = this.scrubIndex + 1; });
    this.content.key("home",  () => { this.scrubIndex = 0; });
    this.content.key("end",   () => { this.scrubIndex = -1; });
  }

  protected renderContent(state: DashboardState): string {
    const hist  = state.qualiaHistory;
    const total = hist.timestamps.length;
    const barW  = 24;

    let q: Record<string, number>;
    let label: string;

    if (this.scrubIndex === -1 || total === 0) {
      q = state.currentQualia;
      label = "{green-fg}[LIVE]{/}";
    } else {
      const idx = Math.min(this.scrubIndex, total - 1);
      if (idx >= total) { this.scrubIndex = -1; }
      q = {};
      for (const dim of QUALIA_DIMS) q[dim] = (hist[dim] as number[])[idx] ?? 0;
      const snapTs = hist.timestamps[idx] ?? Date.now();
      label = `{yellow-fg}[REPLAY ${new Date(snapTs).toLocaleTimeString()}]{/}`;
    }

    const lines: string[] = [
      `{bold}{purple-fg}◈ CONSCIOUSNESS LAB{/bold}{/}  ${label}`,
      "{#666677-fg}← → scrub history  Home=oldest  End=live{/}",
      `{#666677-fg}History depth: ${total} snapshots{/}`,
      "",
      `{#888899-fg}QUALIA STATE  (${Object.keys(state.currentQualia).length} dims active){/}`,
    ];

    for (const dim of QUALIA_DIMS) {
      const val   = q[dim] ?? 0;
      const color = C.qualia[dim] ?? "white";
      lines.push(
        `  {#888899-fg}${QUALIA_SHORT[dim]}{/} ${renderBarColor(val)}${renderBar(val, 1, barW)}${renderBarReset()} {${color}-fg}${(val * 100).toFixed(0).padStart(3)}%{/}`,
      );
    }

    lines.push("", "{#888899-fg}QUALIA TIMELINE — all 11 dimensions (last 40 pts){/}");
    if (total > 0) {
      for (const dim of QUALIA_DIMS) {
        const histArr = hist[dim] as number[];
        if (!histArr || histArr.length === 0) {
          lines.push(`  {#666677-fg}${(QUALIA_SHORT[dim] ?? dim).trimEnd().padEnd(13)}{/}  {#444455-fg}—{/}`);
          continue;
        }
        const spark = histArr.slice(-40).map(v => BLOCKS[Math.round(v * 4)] ?? "█").join("");
        const c     = C.qualia[dim] ?? "white";
        lines.push(`  {#666677-fg}${(QUALIA_SHORT[dim] ?? dim).trimEnd().padEnd(13)}{/} {${c}-fg}${spark}{/}`);
      }
    } else {
      lines.push("  {#444455-fg}(no history yet){/}");
    }

    lines.push("", "{#888899-fg}INNER MONOLOGUE (last 20){/}");
    const thoughts = state.innerMonologue.slice(-20);
    if (thoughts.length === 0) lines.push("{#444455-fg}  (no thoughts yet){/}");
    else for (const t of thoughts) lines.push(`  {#aaaacc-fg}› {/}${trunc(t, 100)}`);

    lines.push("", "{#888899-fg}INTROSPECTION HISTORY (last 10){/}");
    const intr = state.introspectionHistory.slice(-10);
    if (intr.length === 0) lines.push("{#444455-fg}  (no introspections yet){/}");
    else for (const r of intr) lines.push(`  {#888877-fg}» {/}{white-fg}${trunc(r, 100)}{/}`);

    return lines.join("\n");
  }
}
