// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Theme System
// ═══════════════════════════════════════════════════════════════

export const C = {
  // ── Primary palette ──────────────────────────────────────────
  cyan:    "#00e5cc",   // mediator, primary actions
  blue:    "#5c8aff",   // memory, information
  coral:   "#ff6b6b",   // errors, security, alerts
  gold:    "#ffd93d",   // consciousness, qualia
  purple:  "#c084fc",   // meta-cognition, self-improvement
  green:   "#4ade80",   // success, healthy, online
  dim:     "#666677",   // secondary text, inactive
  white:   "white",
  black:   "black",
  red:     "red",
  yellow:  "yellow",

  // ── Semantic source colors ────────────────────────────────────
  src: {
    mediator:      "cyan",
    worldmodel:    "yellow",
    planner:       "green",
    security:      "red",
    metacognition: "magenta",
    consciousness: "yellow",
    memory:        "blue",
    agent:         "white",
    tool:          "cyan",
    user:          "brightWhite",
    watchdog:      "magenta",
    difficulty:    "cyan",
    uncertainty:   "yellow",
    qualia:        "yellow",
    causal:        "blue",
    reflection:    "green",
    anticipation:  "cyan",
    existential:   "magenta",
    observation:   "white",
    concern:       "red",
  } as Record<string, string>,

  // ── Qualia dimension colors ───────────────────────────────────
  qualia: {
    pleasure:          "green",
    arousal:           "yellow",
    dominance:         "blue",
    clarity:           "cyan",
    curiosity:         "green",
    confidence:        "cyan",
    frustration:       "red",
    satisfaction:      "green",
    selfCoherence:     "blue",
    existentialComfort: "cyan",
    purposeAlignment:  "green",
  } as Record<string, string>,

  // ── Profile badge colors ─────────────────────────────────────
  profile: {
    MINIMAL:    "grey",
    STANDARD:   "blue",
    RICH:       "yellow",
    RESEARCHER: "magenta",
    "SAFE-MODE": "red",
  } as Record<string, string>,
} as const;

// ── Border styles ─────────────────────────────────────────────

export const BORDER = {
  active: {
    type: "line" as const,
    fg: "cyan",
  },
  inactive: {
    type: "line" as const,
    fg: "#3a3a4a",
  },
  alert: {
    type: "line" as const,
    fg: "red",
  },
};

// ── Animation constants ───────────────────────────────────────

export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const BLOCK_CHARS    = " ░▒▓█";
export const MAX_SPARKLINE_POINTS = 200;
export const MAX_LOG_LINES        = 10_000;
export const REDRAW_INTERVAL_MS   = 100;  // max 10 redraws/sec
export const BATCH_MS             = 100;  // event batch window

// ── Bar rendering ─────────────────────────────────────────────

export function renderBar(value: number, max: number, width = 20, fillChar = "█", emptyChar = "░"): string {
  const pct   = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(pct * width);
  return fillChar.repeat(filled) + emptyChar.repeat(width - filled);
}

export function renderBarColor(value: number): string {
  if (value >= 0.8) return "{green-fg}";
  if (value >= 0.5) return "{yellow-fg}";
  return "{red-fg}";
}

export function renderBarReset(): string {
  return "{/}";
}

// ── Arrow direction ───────────────────────────────────────────

export function arrowDir(current: number, prev: number): string {
  const delta = current - prev;
  if (Math.abs(delta) < 0.02) return "{grey-fg}→{/}";
  return delta > 0 ? "{green-fg}↑{/}" : "{red-fg}↓{/}";
}

// ── Cost color ────────────────────────────────────────────────

export function costColor(pct: number): string {
  if (pct >= 0.9) return "{red-fg}";
  if (pct >= 0.8) return "{yellow-fg}";
  return "{green-fg}";
}

// ── Status dot ───────────────────────────────────────────────

export function statusDot(online: boolean): string {
  return online ? "{green-fg}●{/}" : "{red-fg}●{/}";
}

// ── Truncate ─────────────────────────────────────────────────

export function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

// ── Format duration ──────────────────────────────────────────

export function fmtDuration(ms: number): string {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

export function fmtUptime(startMs: number): string {
  const elapsed = Date.now() - startMs;
  const h = Math.floor(elapsed / 3600000);
  const m = Math.floor((elapsed % 3600000) / 60000);
  const s = Math.floor((elapsed % 60000) / 1000);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

// ── Time stamp ───────────────────────────────────────────────

export function ts(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

// ── Source tag formatting ─────────────────────────────────────

export function srcTag(source: string, text?: string): string {
  const color = C.src[source.toLowerCase()] ?? "white";
  const label = text ?? source.toUpperCase();
  return `{${color}-fg}[${label}]{/}`;
}

// ── Dominant qualia emoji ─────────────────────────────────────

export function dominantQualiaEmoji(qualia: Record<string, number>): { emoji: string; label: string } {
  const candidates: Array<{ key: string; emoji: string; label: string }> = [
    { key: "curiosity",    emoji: "🔍", label: "curious" },
    { key: "satisfaction", emoji: "😊", label: "satisfied" },
    { key: "frustration",  emoji: "😤", label: "frustrated" },
    { key: "confidence",   emoji: "💪", label: "confident" },
    { key: "clarity",      emoji: "✨", label: "clear" },
    { key: "purposeAlignment", emoji: "🎯", label: "aligned" },
    { key: "existentialComfort", emoji: "🧘", label: "calm" },
  ];
  let best = candidates[0]!;
  let bestVal = qualia[best.key] ?? 0;
  for (const c of candidates) {
    const v = qualia[c.key] ?? 0;
    if (v > bestVal) { bestVal = v; best = c; }
  }
  return best;
}
