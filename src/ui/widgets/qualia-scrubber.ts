// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Qualia Scrubber Widget
// ═══════════════════════════════════════════════════════════════
//
// Overlay to scrub through qualia history across all 11 dimensions.
// Keyboard: ←/→ = move cursor in time, ↑/↓ = select dimension,
//           Home/End = jump to start/end, r = reset to live.

import type { DashboardState, QualiaHistory } from "../state.js";
import { BaseView } from "../views/base-view.js";
import type { AnyElement } from "../views/base-view.js";
import { renderBar, C } from "../theme.js";

const QUALIA_DIMS = [
  "pleasure", "arousal", "dominance", "clarity",
  "curiosity", "confidence", "frustration", "satisfaction",
  "selfCoherence", "existentialComfort", "purposeAlignment",
] as const;

type QualiaDim = typeof QUALIA_DIMS[number];

const QUALIA_LABELS: Record<QualiaDim, string> = {
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

export class QualiaScrubberView extends BaseView {
  private cursor    = -1;   // -1 = live (end of history)
  private dimIdx    = 0;

  constructor(screen: AnyElement) {
    super(screen, { title: "QUALIA SCRUBBER", fKey: "Q", width: "80%", height: "85%", borderColor: "#c084fc" });

    this.content.key("left",  () => { this.cursor = Math.max(0, (this.cursor < 0 ? 9999 : this.cursor) - 1); });
    this.content.key("right", () => { this.cursor = this.cursor < 0 ? -1 : this.cursor + 1; });
    this.content.key("up",    () => { this.dimIdx = Math.max(0, this.dimIdx - 1); });
    this.content.key("down",  () => { this.dimIdx = Math.min(QUALIA_DIMS.length - 1, this.dimIdx + 1); });
    this.content.key("home",  () => { this.cursor = 0; });
    this.content.key("end",   () => { this.cursor = -1; });
    this.content.key("r",     () => { this.cursor = -1; this.dimIdx = 0; });
  }

  show(): void {
    this.cursor = -1;
    this.dimIdx = 0;
    super.show();
  }

  protected renderContent(state: DashboardState): string {
    const hist  = state.qualiaHistory;
    const total = hist.timestamps.length;
    const barW  = 30;

    // Clamp cursor
    if (this.cursor >= total) this.cursor = -1;
    const idx    = this.cursor < 0 ? Math.max(0, total - 1) : this.cursor;
    const isLive = this.cursor < 0;

    const lines: string[] = [
      "{bold}{purple-fg}◈ QUALIA SCRUBBER{/bold}{/}",
      "{#666677-fg}← → = scrub time  ↑ ↓ = select dim  Home/End  r = live{/}",
      "",
    ];

    // Time position bar
    const posBar = total > 1
      ? renderBar(idx / (total - 1), 1, 40)
      : renderBar(1, 1, 40);
    const timeStr = total > 0
      ? new Date(hist.timestamps[idx] ?? Date.now()).toLocaleTimeString("en-GB")
      : "—";
    lines.push(
      `  {#888899-fg}Time:{/} {cyan-fg}${posBar}{/} {#666677-fg}${idx + 1}/${total}{/} {white-fg}${timeStr}{/}` +
      (isLive ? "  {green-fg}● LIVE{/}" : "  {yellow-fg}⏸ SCRUB{/}"),
      "",
    );

    // Per-dimension rows
    lines.push("{#888899-fg}DIMENSIONS{/}");
    for (let i = 0; i < QUALIA_DIMS.length; i++) {
      const dim    = QUALIA_DIMS[i]!;
      const series = hist[dim as keyof QualiaHistory] as number[] | undefined ?? [];
      const val    = series[idx] ?? state.currentQualia[dim] ?? 0;
      const prev   = series[idx - 1] ?? val;
      const delta  = val - prev;
      const dStr   = delta > 0.01 ? "{green-fg}▲{/}" : delta < -0.01 ? "{red-fg}▼{/}" : "{#666677-fg}─{/}";
      const color  = C.qualia[dim] ?? "white";
      const bar    = renderBar(val, 1, barW);
      const sel    = i === this.dimIdx ? "{bold}{cyan-fg}▸{/}{/}" : "  ";
      lines.push(
        `${sel}{#888899-fg}${QUALIA_LABELS[dim]}{/} {${color}-fg}${bar}{/} {white-fg}${(val * 100).toFixed(0).padStart(3)}%{/} ${dStr}`,
      );

      // Show mini trend for selected dimension
      if (i === this.dimIdx && series.length > 1) {
        const BLOCK = " ░▒▓█";
        const trend = series.slice(-40).map(v => {
          const ci = Math.round(Math.max(0, Math.min(1, v)) * (BLOCK.length - 1));
          return BLOCK[ci] ?? BLOCK[BLOCK.length - 1]!;
        }).join("");
        lines.push(`    {#444455-fg}trend: {${color}-fg}${trend}{/}`);
      }
    }

    lines.push(
      "",
      `{#444455-fg}History points: ${total}  Cursor: ${isLive ? "live" : idx}{/}`,
    );

    return lines.join("\n");
  }
}
