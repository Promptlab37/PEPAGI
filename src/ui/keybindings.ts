// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Keybindings
// ═══════════════════════════════════════════════════════════════

export type TuiAction =
  | { type: "open_view";   view: string }       // F1-F9
  | { type: "close_view" }                       // Escape
  | { type: "focus_panel"; panel: string }       // Tab / Shift+Tab
  | { type: "scroll_up" }
  | { type: "scroll_down" }
  | { type: "page_up" }
  | { type: "page_down" }
  | { type: "toggle_pause" }                     // Space
  | { type: "quit" }                             // q / C-c
  | { type: "decision_replay_prev" }             // Ctrl+Left
  | { type: "decision_replay_next" }             // Ctrl+Right
  | { type: "decision_replay_open" }             // Ctrl+R
  | { type: "thought_graph_open" }               // Ctrl+G
  | { type: "ack_anomaly" }                      // a
  | { type: "clear_log" }                        // c (in log view)
  | { type: "search_mode" }                      // / (in log view)
  | { type: "none" };

// Maps blessed key names → TuiAction
export const KEYMAP: Record<string, TuiAction> = {
  // F-key overlays
  "f1":  { type: "open_view", view: "F1" },
  "f2":  { type: "open_view", view: "F2" },
  "f3":  { type: "open_view", view: "F3" },
  "f4":  { type: "open_view", view: "F4" },
  "f5":  { type: "open_view", view: "F5" },
  "f6":  { type: "open_view", view: "F6" },
  "f7":  { type: "open_view", view: "F7" },
  "f8":  { type: "open_view", view: "F8" },
  "f9":  { type: "open_view", view: "F9" },

  // Close overlay
  "escape": { type: "close_view" },

  // Navigation
  "tab":           { type: "focus_panel", panel: "next" },
  "S-tab":         { type: "focus_panel", panel: "prev" },
  "up":            { type: "scroll_up" },
  "down":          { type: "scroll_down" },
  "pageup":        { type: "page_up" },
  "pagedown":      { type: "page_down" },
  "k":             { type: "scroll_up" },
  "j":             { type: "scroll_down" },

  // Pause
  " ":             { type: "toggle_pause" },

  // Quit
  "q":             { type: "quit" },
  "C-c":           { type: "quit" },

  // Revolutionary features
  "C-r":           { type: "decision_replay_open" },
  "C-left":        { type: "decision_replay_prev" },
  "C-right":       { type: "decision_replay_next" },
  "C-g":           { type: "thought_graph_open" },

  // Anomaly ack
  "a":             { type: "ack_anomaly" },

  // Log panel
  "c":             { type: "clear_log" },
  "/":             { type: "search_mode" },
};

/**
 * Returns the TuiAction for a key press event.
 * `keyName` is the blessed key name (e.g., "f1", "escape", "C-c").
 */
export function resolveKey(keyName: string): TuiAction {
  return KEYMAP[keyName] ?? { type: "none" };
}

/** Focus cycle order */
export const PANEL_ORDER = ["neural", "consciousness", "pipeline", "agents", "cost"] as const;
export type PanelName = (typeof PANEL_ORDER)[number];

export function nextPanel(current: string): PanelName {
  const idx = PANEL_ORDER.indexOf(current as PanelName);
  return PANEL_ORDER[(idx + 1) % PANEL_ORDER.length]!;
}

export function prevPanel(current: string): PanelName {
  const idx = PANEL_ORDER.indexOf(current as PanelName);
  return PANEL_ORDER[(idx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length]!;
}

/** Short label shown in the bottom bar help strip */
export const KEY_HELP = [
  "F1-F9:Views",
  "Tab:Focus",
  "Space:Pause",
  "/:Cmd",
  "↵:Input",
  "C-R:Replay",
  "C-G:Graph",
  "a:Ack",
  "q:Quit",
].join("  ");
